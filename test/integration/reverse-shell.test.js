/** This test deliberately opens a remote shell when explicitly enabled. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runReverseShell } from '../../lab/reverse-shell.js';

const enabled = process.env.ENABLE_REVERSE_SHELL === '1';

test('opt-in reverse shell through a Cloudflare WebSocket tunnel', {
  skip: enabled ? false : 'Set ENABLE_REVERSE_SHELL=1, SHELL_LAB_URL, and SHELL_LAB_TOKEN',
  timeout: 65000,
}, async (t) => {
  assert.ok(process.env.SHELL_LAB_URL, 'SHELL_LAB_URL must be supplied');
  assert.ok(process.env.SHELL_LAB_TOKEN, 'SHELL_LAB_TOKEN must be supplied');
  t.diagnostic('Starting an explicitly enabled remote shell session.');
  const result = await runReverseShell({
    enabled,
    url: process.env.SHELL_LAB_URL,
    token: process.env.SHELL_LAB_TOKEN,
    timeoutMs: Number(process.env.SHELL_LAB_TIMEOUT_MS ?? 15000),
    signal: t.signal,
  });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^taskflow-shell-ok-[0-9a-f]{32}\n$/);
});
