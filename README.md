# taskflow-lab

A JavaScript package with a useful async job toolkit, a substantial test suite, and an explicit reverse-shell integration lab for Cloudflare Tunnel.

The library has no runtime dependencies. The lab uses the `ws` development dependency. Requires Node.js 22 or newer. The shell lab additionally requires macOS or Linux and `/bin/sh`.

```sh
npm ci --ignore-scripts
npm test
npm run example
```

## Test commands

| Command | Behavior |
| --- | --- |
| `npm test` | Runs toolkit unit tests. No shell or network connection. |
| `npm run test:coverage` | Runs unit tests with Node's coverage report. |
| `npm run test:lab` | Runs real shell integration tests against loopback WebSocket servers. |
| `npm run test:reverse-shell` | Runs the Cloudflare shell test only when explicitly enabled. Otherwise reports one skipped test. |
| `npm run lab:listener` | Starts the authenticated, one-shot, fixed-challenge listener. |

There are no install hooks and importing the public package does not start a process or connection. Use the named npm commands to select the intended test suite. Bare `node --test` discovers the local lab tests too.

## Toolkit

```js
import { TaskQueue, retry, LruCache, Pipeline, mapConcurrent, delay, backoff } from 'taskflow-lab';

const queue = new TaskQueue({ concurrency: 3, maxPending: 100 });
const cache = new LruCache({ maxSize: 200, ttl: 30000 });

const result = await queue.add(() => cache.getOrLoad('answer', () => retry(
  async ({ attempt, signal }) => 42,
  { attempts: 3, minDelay: 100, maxDelay: 1000 },
)), { priority: 10 });

await queue.close();
console.log(result);
```

### Retry and delay

- `retry(operation, options)` passes `{ attempt, signal }` to the operation. Attempts start at 1 and include the initial call. Defaults: 3 attempts, 100 ms minimum delay, 30000 ms cap, factor 2, jitter 0.
- `shouldRetry(error, { attempt, signal })` may return a boolean or promise. `onRetry({ error, attempt, delay })` runs before each retry delay. Hook failures propagate.
- `backoff(attempt, options)` calculates exponential delay. Jitter between 0 and 1 reduces the capped delay by a random fraction. Invalid settings fail before execution.
- `delay(milliseconds, { signal, value })` resolves to `value` or rejects on cancellation. Durations must fit Node's timer range.

### TaskQueue and mapConcurrent

`new TaskQueue({ concurrency: 1, maxPending: Infinity, paused: false })` creates a queue. Higher numeric priorities run first; equal priorities preserve submission order. Jobs already running keep their slots when new high-priority jobs arrive.

`add(task, { priority: 0, signal })` returns a promise for the task's result. The task receives `{ signal }`. Cancelling a waiting job removes it immediately. Running jobs must cooperate with their signal. A pending capacity of zero permits immediate work only.

`pause()` stops new starts, `start()` resumes them, and `clear(reason)` rejects pending jobs without affecting active jobs. `onIdle()` waits for both pending and active counts to reach zero. `close({ cancelPending: false })` rejects new submissions and drains existing work, even if paused. Setting `cancelPending: true` rejects waiting jobs before awaiting active work.

`size` counts waiting jobs, `active` counts running jobs, and `stats` returns a snapshot with `completed`, `failed`, and `cancelled` counts. `cancelled` counts jobs removed while waiting. Rejections from running jobs count as failures.

`mapConcurrent(iterable, mapper, { concurrency: 4, signal, settled: false })` preserves input order. The mapper receives `(value, index, { signal })`. With `settled: true`, results use the `Promise.allSettled` format. Otherwise the first failure rejects the result, while other submitted work continues. Cancellation is checked before each mapper starts; running mappers cooperate with the signal.

### LruCache

`new LruCache({ maxSize: 100, ttl: 0, clock: Date.now })` caches arbitrary keys and values. TTLs are in milliseconds; zero never expires. Reads refresh recency but not expiry. Expiry occurs at the exact TTL boundary.

Use `set(key, value, { ttl })`, `get(key)`, `has(key)`, `delete(key)`, `clear()`, `prune()`, `entries()`, and `size`. `has` distinguishes a stored `undefined` from a missing key. Expired entries are pruned before evicting live entries.

`getOrLoad(key, loader, { ttl })` coalesces concurrent misses into one loader call. Failed loads are not cached. An explicit write, delete, or clear prevents an older pending load from storing stale data. Existing callers still receive that older load's result.

### Pipeline

```js
const pipeline = new Pipeline()
  .use('parse', (value) => Number(value))
  .use('multiply', async (value, { context }) => value * context.factor);

const total = await pipeline.run('21', { context: { factor: 2 } });
```

`use(name, handler)` returns a new pipeline without changing the original. Stage names must be unique and nonempty. Handlers receive `(value, { context, signal, index })`. `run(input, { context, signal, onStep })` invokes stages sequentially, reports successful stages with their duration, and wraps stage failures in `PipelineError` with `stage`, `index`, and `cause`. Cancellation reasons propagate directly.

## Cloudflare reverse-shell test

The test is `test/integration/reverse-shell.test.js`. It opens an outbound WebSocket to your listener, then attaches a real `/bin/sh` process. The listener can execute commands with the test runner's OS permissions. Run this lab in a disposable environment you control. The temporary directory and minimal environment are cleanup and isolation conveniences, not an OS sandbox.

The included listener sends only a random `printf` challenge followed by `exit 0`. The test checks the output and exit status. It is a pipe-based shell without a PTY, terminal resizing, or interactive editor support.

Cloudflare Tunnel supports WebSockets. A Quick Tunnel can expose the included localhost HTTP/WebSocket listener. See [Cloudflare Tunnel documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/) and [Cloudflare WebSockets documentation](https://developers.cloudflare.com/network/websockets/).

1. Generate a shared token with `openssl rand -hex 32`. Set the same generated value in the listener and test terminals. Do not put the token in the URL.

2. In the listener terminal, from this package directory:

   ```sh
   export SHELL_LAB_TOKEN='PASTE_GENERATED_TOKEN_HERE'
   npm run lab:listener
   ```

3. In another terminal on the listener machine, with `cloudflared` installed:

   ```sh
   cloudflared tunnel --url http://127.0.0.1:8787
   ```

   Copy the generated `https://...trycloudflare.com` hostname. Change `https` to `wss` and append `/shell` for the test URL. A named Cloudflare Tunnel forwarding to the same listener also works.

4. In the test terminal, from this package directory:

   ```sh
   export SHELL_LAB_TOKEN='PASTE_THE_SAME_GENERATED_TOKEN_HERE'
   export SHELL_LAB_URL='wss://YOUR-TUNNEL.trycloudflare.com/shell'
   ENABLE_REVERSE_SHELL=1 npm run test:reverse-shell
   ```

The listener accepts one authenticated session, verifies the challenge, and exits. Restart it before rerunning the test. Stop `cloudflared` when finished. This package does not start or provision a Cloudflare Tunnel itself.

The live test accepts `wss://` URLs with normal certificate verification, disallows URL credentials and query strings, and does not follow redirects. The `ws://127.0.0.1` exception is available only to the separately invoked local lab tests. Tokens must contain 32 to 256 ASCII letters, digits, underscores, or hyphens.

### Lab configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ENABLE_REVERSE_SHELL` | unset | Must equal `1` to enable the live integration test. |
| `SHELL_LAB_URL` | none | Explicit `wss://` listener URL ending in `/shell`. |
| `SHELL_LAB_TOKEN` | none | Shared random bearer token. |
| `SHELL_LAB_TIMEOUT_MS` | `15000` | Entire client session timeout, maximum `60000`. |
| `SHELL_LAB_PORT` | `8787` | Listener port, bound to `127.0.0.1`. |
| `SHELL_LAB_LISTENER_TIMEOUT_MS` | `120000` | Listener wait limit, maximum `600000`. |

`.env.example` documents these settings. Scripts do not automatically load `.env` files. Extend the listener wait limit if tunnel setup takes more than two minutes.

Sessions cap output at 1 MiB, limit message size, and terminate the shell process group on timeout or disconnect. The shell starts in a temporary directory with `PATH`, `HOME`, `TMPDIR`, and `LANG` only. Lab secrets are not passed in its environment. A malicious command can deliberately escape ordinary process-group cleanup, so this is not a containment boundary.

## Layout

```text
src/                 Public toolkit, no lab imports
test/unit/           Default unit suite
test/lab/            Explicit local shell tests
test/integration/    Opt-in live tunnel test
lab/                 Shell transport and fixed-challenge listener
examples/jobs.js      Runnable toolkit example
```

The package is marked private to prevent accidental npm publication. Source and tests are included for local development. The transport follows the [ws client and server API](https://github.com/websockets/ws), and tests use the [Node.js test runner](https://nodejs.org/api/test.html).
