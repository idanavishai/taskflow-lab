import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { MAX_MESSAGE, MAX_OUTPUT, validateToken, parseMessage, decodeData } from './protocol.js';

/** One-shot listener which sends only a random printf challenge followed by exit. */
export async function startChallengeListener({ token, port = 8787, timeoutMs = 120000 } = {}) {
  validateToken(token);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('port must be 0 to 65535');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) {
    throw new TypeError('timeoutMs must be 1 to 600000');
  }
  const expectedAuth = Buffer.from(`Bearer ${token}`);
  const marker = `taskflow-shell-ok-${randomBytes(16).toString('hex')}`;
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('Taskflow fixed-challenge reverse-shell listener\n');
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  let resolveCompleted;
  let rejectCompleted;
  let settled = false;
  let accepted = false;
  let closing;
  const completed = new Promise((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  // Consumers may attach after startup. Keep early failures observable without
  // an unhandled rejection between server creation and the caller's await.
  completed.catch(() => {});

  function settle(error, result) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) rejectCompleted(error);
    else resolveCompleted(result);
  }

  const timer = setTimeout(() => {
    settle(new Error('Listener timed out waiting for the shell challenge'));
    for (const socket of sockets.clients) socket.terminate();
  }, timeoutMs);

  server.on('upgrade', (request, socket, head) => {
    const actual = Buffer.from(request.headers.authorization ?? '');
    let status;
    if (request.url !== '/shell') status = '404 Not Found';
    else if (actual.length !== expectedAuth.length || !timingSafeEqual(actual, expectedAuth)) {
      status = '401 Unauthorized';
    } else if (accepted || settled) status = '409 Conflict';
    if (status) {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    accepted = true;
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit('connection', client));
  });

  sockets.on('connection', (socket) => {
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let ready = false;
    socket.on('error', (error) => settle(error));
    socket.on('close', () => settle(new Error('Shell disconnected before completing the challenge')));
    socket.on('message', (data) => {
      try {
        const message = parseMessage(data);
        if (message.type === 'ready' && !ready) {
          ready = true;
          const command = `printf '%s\\n' '${marker}'; exit 0\n`;
          socket.send(JSON.stringify({ type: 'stdin', data: Buffer.from(command).toString('base64') }));
        } else if (ready && ['stdout', 'stderr'].includes(message.type)) {
          const chunk = decodeData(message);
          bytes += chunk.length;
          if (bytes > MAX_OUTPUT) throw new Error('Challenge output limit exceeded');
          (message.type === 'stdout' ? stdout : stderr).push(chunk);
        } else if (ready && message.type === 'exit') {
          const output = Buffer.concat(stdout).toString();
          const errors = Buffer.concat(stderr).toString();
          if (message.code !== 0 || output !== `${marker}\n` || errors !== '') {
            throw new Error('Shell did not return the expected printf challenge');
          }
          settle(null, { marker, stdout: output, stderr: errors, code: message.code });
        } else {
          throw new Error('Unexpected shell protocol message');
        }
      } catch (error) {
        settle(error);
        socket.close(1008, 'Challenge failed');
      }
    });
  });

  try {
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
  } catch (error) {
    clearTimeout(timer);
    sockets.close();
    throw error;
  }

  return {
    url: `ws://127.0.0.1:${server.address().port}/shell`,
    completed,
    close() {
      closing ??= (async () => {
        settle(new Error('Listener closed'));
        for (const socket of sockets.clients) socket.terminate();
        await new Promise((resolve) => sockets.close(resolve));
        await new Promise((resolve) => server.close(resolve));
      })();
      return closing;
    },
  };
}
