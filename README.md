# taskflow-lab

Lightweight async job toolkit for Node.js 22+. Zero runtime dependencies.

- **TaskQueue** — bounded-concurrency job queue with priorities and cancellation
- **LruCache** — LRU cache with TTL and coalesced loading
- **Pipeline** — composable async stage pipeline
- **retry / backoff / delay** — configurable retry with exponential backoff and jitter
- **mapConcurrent** — ordered concurrent map over iterables

```sh
npm install
npm test
npm run example
```

## Quick start

```js
import { TaskQueue, retry, LruCache, Pipeline, mapConcurrent, delay, backoff } from 'taskflow-lab';

const queue = new TaskQueue({ concurrency: 3, maxPending: 100 });
const cache = new LruCache({ maxSize: 200, ttl: 30000 });

const result = await queue.add(() => cache.getOrLoad('answer', () => retry(
  async ({ attempt, signal }) => 42,
  { attempts: 3, minDelay: 100, maxDelay: 1000 },
)), { priority: 10 });

await queue.close();
console.log(result); // 42
```

## API

### retry(operation, options)

Retries an async operation with exponential backoff. The operation receives `{ attempt, signal }`. Defaults: 3 attempts, 100ms min delay, 30s cap, factor 2, jitter 0.

### TaskQueue

```js
const queue = new TaskQueue({ concurrency: 4, maxPending: Infinity });
await queue.add(task, { priority: 0, signal });
await queue.onIdle();
await queue.close();
```

Higher numeric priorities run first. `pause()` / `start()` control scheduling. `clear(reason)` rejects pending jobs. `stats` returns `{ completed, failed, cancelled }`.

### LruCache

```js
const cache = new LruCache({ maxSize: 100, ttl: 60000 });
cache.set('key', value);
const hit = cache.get('key');
const loaded = await cache.getOrLoad('key', loader, { ttl });
```

`getOrLoad` coalesces concurrent misses. Expired entries are pruned before eviction.

### Pipeline

```js
const pipeline = new Pipeline()
  .use('parse', (v) => Number(v))
  .use('multiply', async (v, { context }) => v * context.factor);

const result = await pipeline.run('21', { context: { factor: 2 } });
```

Stages run sequentially. Failures wrap in `PipelineError` with `stage`, `index`, and `cause`.

### mapConcurrent(iterable, mapper, options)

Ordered concurrent map. `settled: true` gives `Promise.allSettled` format.

## Tests

```sh
npm test                # unit tests
npm run test:coverage   # with V8 coverage
```

## License

MIT
