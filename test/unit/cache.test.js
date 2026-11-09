import test from 'node:test';
import assert from 'node:assert/strict';
import { LruCache } from '../../src/cache.js';

test('cache evicts the least recently used entry', () => {
  const cache = new LruCache({ maxSize: 2 });
  cache.set('a', 1).set('b', 2);
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);
  assert.equal(cache.has('b'), false);
  assert.deepEqual([...cache.entries()], [['a', 1], ['c', 3]]);
});

test('cache expires at the exact TTL boundary', () => {
  let now = 0;
  const cache = new LruCache({ ttl: 10, clock: () => now });
  cache.set('a', 1);
  now = 9;
  assert.equal(cache.get('a'), 1);
  now = 10;
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.size, 0);
});

test('per-entry TTL overrides the default and zero never expires', () => {
  let now = 0;
  const cache = new LruCache({ ttl: 5, clock: () => now });
  cache.set('forever', 1, { ttl: 0 }).set('short', 2, { ttl: 2 });
  now = 100;
  assert.equal(cache.get('forever'), 1);
  assert.equal(cache.has('short'), false);
});

test('cache distinguishes a cached undefined value from a miss', async () => {
  const cache = new LruCache();
  cache.set('key', undefined);
  assert.equal(cache.has('key'), true);
  assert.equal(await cache.getOrLoad('key', () => 42), undefined);
});

test('concurrent cache misses share one loader', async () => {
  const cache = new LruCache();
  let calls = 0;
  const loader = async () => { calls++; return 42; };
  const results = await Promise.all(Array.from({ length: 8 }, () => cache.getOrLoad('key', loader)));
  assert.deepEqual(results, Array(8).fill(42));
  assert.equal(calls, 1);
  assert.equal(cache.get('key'), 42);
});

test('rejected loaders do not poison subsequent cache loads', async () => {
  const cache = new LruCache();
  await assert.rejects(cache.getOrLoad('key', () => { throw new Error('offline'); }), /offline/);
  assert.equal(await cache.getOrLoad('key', () => 7), 7);
});

test('an explicit write wins over an older in-flight loader', async () => {
  const cache = new LruCache();
  let finish;
  const loading = cache.getOrLoad('key', () => new Promise((resolve) => { finish = resolve; }));
  await Promise.resolve();
  cache.set('key', 'new');
  finish('old');
  assert.equal(await loading, 'old');
  assert.equal(cache.get('key'), 'new');
});

test('delete and clear prevent stale loaders from repopulating the cache', async () => {
  for (const invalidate of [(cache) => cache.delete('key'), (cache) => cache.clear()]) {
    const cache = new LruCache();
    let finish;
    const loading = cache.getOrLoad('key', () => new Promise((resolve) => { finish = resolve; }));
    await Promise.resolve();
    invalidate(cache);
    finish('old');
    await loading;
    assert.equal(cache.has('key'), false);
  }
});

test('prune removes expired entries before a live entry is evicted', () => {
  let now = 0;
  const cache = new LruCache({ maxSize: 2, clock: () => now });
  cache.set('live', 1).set('expired', 2, { ttl: 1 });
  now = 2;
  cache.set('next', 3);
  assert.equal(cache.get('live'), 1);
  assert.equal(cache.size, 2);
});

test('updating an entry refreshes recency without increasing size', () => {
  const cache = new LruCache({ maxSize: 2 });
  cache.set('a', 1).set('b', 2).set('a', 3).set('c', 4);
  assert.equal(cache.get('a'), 3);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.size, 2);
});

test('cache validates capacities, TTLs, clocks, and loaders', async () => {
  assert.throws(() => new LruCache({ maxSize: 0 }), /must/);
  assert.throws(() => new LruCache({ ttl: -1 }), /must/);
  assert.throws(() => new LruCache({ clock: 3 }), /must/);
  const cache = new LruCache();
  assert.throws(() => cache.set('key', 1, { ttl: Infinity }), /must/);
  await assert.rejects(cache.getOrLoad('key', false), /must/);
});
