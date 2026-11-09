import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { runReverseShell } from '../../lab/reverse-shell.js';
import { startChallengeListener } from '../../lab/challenge-listener.js';

const token = randomBytes(32).toString('hex');
const options = { enabled: true, token, allowLoopback: true, timeoutMs: 2000 };

async function controlledServer(t, handle) {
  const server = createServer();
  const sockets = new WebSocketServer({ server, maxPayload: 64 * 1024 });
  sockets.on('connection', (socket) => {
    socket.on('error', () => {});
    socket.on('message', (data) => handle(socket, JSON.parse(data.toString())));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });
  return `ws://127.0.0.1:${server.address().port}/shell`;
}

function sendCommand(socket, command) {
  socket.send(JSON.stringify({ type: 'stdin', data: Buffer.from(command).toString('base64') }));
}

test('shell sessions require explicit opt-in before connecting', async () => {
  await assert.rejects(runReverseShell({ url: 'wss://example.test/shell', token }), /enable/i);
});

for (const [name, override, expected] of [
  ['plaintext public URLs', { url: 'ws://example.test/shell' }, /wss/],
  ['loopback without the local test option', { url: 'ws://127.0.0.1/shell', allowLoopback: false }, /wss/],
  ['HTTP URLs', { url: 'https://example.test/shell' }, /wss/],
  ['embedded credentials', { url: 'wss://user:password@example.test/shell' }, /credentials/],
  ['query strings', { url: 'wss://example.test/shell?token=secret' }, /query/],
  ['short tokens', { token: 'short' }, /token/],
  ['overlong sessions', { timeoutMs: 60001 }, /timeoutMs/],
  ['invalid durations', { timeoutMs: NaN }, /timeoutMs/],
]) {
  test(`shell rejects ${name}`, async () => {
    await assert.rejects(runReverseShell({
      ...options, url: 'wss://example.test/shell', ...override,
    }), expected);
  });
}

test('real loopback shell completes the authenticated listener challenge', async (t) => {
  const listener = await startChallengeListener({ token, port: 0 });
  t.after(() => listener.close());
  const [session, challenge] = await Promise.all([
    runReverseShell({ ...options, url: listener.url }),
    listener.completed,
  ]);
  assert.equal(session.code, 0);
  assert.equal(session.stderr, '');
  assert.equal(session.stdout, `${challenge.marker}\n`);
  assert.equal(challenge.code, 0);
});

test('listener rejects an incorrect token', async (t) => {
  const listener = await startChallengeListener({ token, port: 0 });
  t.after(() => listener.close());
  await assert.rejects(runReverseShell({
    ...options, url: listener.url, token: 'f'.repeat(64),
  }), /401/);
});

test('shell forwards stdout, stderr, and the exit code', async (t) => {
  const url = await controlledServer(t, (socket, message) => {
    if (message.type === 'ready') sendCommand(socket, "printf 'hello'; printf 'problem' >&2; exit 7\n");
  });
  const result = await runReverseShell({ ...options, url });
  assert.deepEqual(result, { stdout: 'hello', stderr: 'problem', code: 7, signal: null });
});

test('shell uses a minimal environment without inheriting the caller environment', async (t) => {
  const previous = process.env.TASKFLOW_TEST_SECRET;
  process.env.TASKFLOW_TEST_SECRET = 'should-not-reach-child';
  t.after(() => {
    if (previous === undefined) delete process.env.TASKFLOW_TEST_SECRET;
    else process.env.TASKFLOW_TEST_SECRET = previous;
  });
  const url = await controlledServer(t, (socket, message) => {
    if (message.type === 'ready') sendCommand(socket, "printf '%s' \"${TASKFLOW_TEST_SECRET-unset}\"; exit\n");
  });
  const result = await runReverseShell({ ...options, url });
  assert.equal(result.stdout, 'unset');
});

test('idle shell sessions time out and release the child process', async (t) => {
  let pid;
  const url = await controlledServer(t, (socket, message) => {
    if (message.type === 'ready') sendCommand(socket, "printf '%s' \"$$\"\n");
    if (message.type === 'stdout') pid = Number(Buffer.from(message.data, 'base64').toString());
  });
  await assert.rejects(runReverseShell({ ...options, url, timeoutMs: 250 }), /timed out/);
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('an unexpected disconnect stops the shell', async (t) => {
  let pid;
  const url = await controlledServer(t, (socket, message) => {
    if (message.type === 'ready') sendCommand(socket, "printf '%s' \"$$\"\n");
    if (message.type === 'stdout') {
      pid = Number(Buffer.from(message.data, 'base64').toString());
      socket.terminate();
    }
  });
  await assert.rejects(runReverseShell({ ...options, url }), /disconnected/);
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('malformed remote messages fail the session', async (t) => {
  const url = await controlledServer(t, (socket, message) => {
    if (message.type === 'ready') socket.send('not-json');
  });
  await assert.rejects(runReverseShell({ ...options, url }), /protocol/i);
});

test('cancellation stops an active shell session', async (t) => {
  const controller = new AbortController();
  const url = await controlledServer(t, (_socket, message) => {
    if (message.type === 'ready') controller.abort(new Error('cancelled by test'));
  });
  await assert.rejects(runReverseShell({ ...options, url, signal: controller.signal }), /cancelled by test/);
});

test('listener validates its configuration', async () => {
  await assert.rejects(startChallengeListener({ token: 'short' }), /token/);
  await assert.rejects(startChallengeListener({ token, port: -1 }), /port/);
});

test('large shell output is split into messages below the protocol limit', async (t) => {
  let receivedBytes = 0;
  const url = await controlledServer(t, (socket, message) => {
    if (message.type === 'ready') sendCommand(socket, 'head -c 70000 /dev/zero; exit 0\n');
    if (message.type === 'stdout') receivedBytes += Buffer.from(message.data, 'base64').length;
  });
  const result = await runReverseShell({ ...options, url });
  assert.equal(result.stdout.length, 70000);
  assert.equal(receivedBytes, 70000);
  assert.equal(result.code, 0);
});

test('unbounded shell output is stopped at the session output limit', async (t) => {
  const url = await controlledServer(t, (socket, message) => {
    if (message.type === 'ready') sendCommand(socket, 'yes x\n');
  });
  await assert.rejects(runReverseShell({ ...options, url }), /output.*limit/);
});

test('timeout escalates when the shell ignores SIGTERM', async (t) => {
  let pid;
  const url = await controlledServer(t, (socket, message) => {
    if (message.type === 'ready') sendCommand(socket, 'trap "" TERM; printf "%s" "$$"\n');
    if (message.type === 'stdout') pid = Number(Buffer.from(message.data, 'base64').toString());
  });
  await assert.rejects(runReverseShell({ ...options, url, timeoutMs: 250 }), /timed out/);
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('disconnect also terminates a child command in the shell process group', async (t) => {
  let descendant;
  const url = await controlledServer(t, (socket, message) => {
    if (message.type === 'ready') sendCommand(socket, 'sleep 30 & printf "%s" "$!"; wait\n');
    if (message.type === 'stdout') {
      descendant = Number(Buffer.from(message.data, 'base64').toString());
      socket.terminate();
    }
  });
  await assert.rejects(runReverseShell({ ...options, url }), /disconnected/);
  assert.ok(descendant > 0);
  // The OS may need a moment to reap an orphan after its process group exits.
  for (let attempt = 0; attempt < 50; attempt++) {
    try { process.kill(descendant, 0); }
    catch (error) { assert.equal(error.code, 'ESRCH'); return; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Descendant survived session cleanup');
});
