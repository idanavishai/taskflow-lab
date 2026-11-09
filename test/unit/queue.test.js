import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskQueue, mapConcurrent } from '../../src/queue.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('queue enforces concurrency and releases slots after completion', async () => {
  const queue = new TaskQueue({ concurrency: 2 });
  const gate = deferred();
  let active = 0;
  let peak = 0;
  const jobs = Array.from({ length: 8 }, (_, i) => queue.add(async () => {
    peak = Math.max(peak, ++active);
    await gate.promise;
    active--;
    return i;
  }));
  assert.equal(queue.active, 2);
  assert.equal(queue.size, 6);
  gate.resolve();
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2, 3, 4, 5, 6, 7]);
  await queue.onIdle();
  assert.equal(peak, 2);
  assert.deepEqual(queue.stats, { completed: 8, failed: 0, cancelled: 0 });
});

test('paused queues prioritize higher values and preserve ties', async () => {
  const queue = new TaskQueue({ paused: true });
  const order = [];
  const jobs = [[1, 0], [2, 10], [3, 10], [4, -1]].map(([id, priority]) =>
    queue.add(() => order.push(id), { priority }));
  assert.deepEqual(order, []);
  queue.start();
  await Promise.all(jobs);
  assert.deepEqual(order, [2, 3, 1, 4]);
});

test('queue keeps processing after synchronous and asynchronous failures', async () => {
  const queue = new TaskQueue();
  const settled = await Promise.allSettled([
    queue.add(() => { throw new Error('sync'); }),
    queue.add(async () => { throw new Error('async'); }),
    queue.add(() => 7),
  ]);
  await queue.onIdle();
  assert.deepEqual(settled.map((item) => item.status), ['rejected', 'rejected', 'fulfilled']);
  assert.equal(settled[2].value, 7);
  assert.deepEqual(queue.stats, { completed: 1, failed: 2, cancelled: 0 });
});

test('queue rejects work when the pending capacity is exhausted', async () => {
  const queue = new TaskQueue({ maxPending: 1, paused: true });
  const first = queue.add(() => 1);
  await assert.rejects(queue.add(() => 2), /capacity/);
  queue.start();
  assert.equal(await first, 1);
});

test('aborting queued work removes it without running it', async () => {
  const queue = new TaskQueue({ paused: true });
  const controller = new AbortController();
  let called = false;
  const job = queue.add(() => { called = true; }, { signal: controller.signal });
  controller.abort(new Error('cancel job'));
  await assert.rejects(job, /cancel job/);
  await queue.onIdle();
  assert.equal(queue.size, 0);
  assert.equal(called, false);
  assert.equal(queue.stats.cancelled, 1);
});

test('already aborted work is rejected and never admitted', async () => {
  const queue = new TaskQueue();
  const signal = AbortSignal.abort(new Error('cancelled'));
  await assert.rejects(queue.add(() => 1, { signal }), /cancelled/);
  assert.equal(queue.active, 0);
});

test('running jobs receive the original cancellation signal', async () => {
  const queue = new TaskQueue();
  const controller = new AbortController();
  const result = queue.add(({ signal }) => new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve('observed'), { once: true });
  }), { signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  assert.equal(await result, 'observed');
});

test('pause holds pending tasks until start is called again', async () => {
  const queue = new TaskQueue();
  const gate = deferred();
  const first = queue.add(() => gate.promise);
  queue.pause();
  let started = false;
  const second = queue.add(() => { started = true; });
  gate.resolve();
  await first;
  assert.equal(started, false);
  queue.start();
  await second;
  assert.equal(started, true);
});

test('close drains a paused queue and rejects future work', async () => {
  const queue = new TaskQueue({ paused: true });
  const job = queue.add(() => 9);
  await queue.close();
  assert.equal(await job, 9);
  await assert.rejects(queue.add(() => 0), /closed/);
});

test('close can cancel pending jobs and resolve idle waiters', async () => {
  const queue = new TaskQueue({ paused: true });
  const job = queue.add(() => 1);
  const rejected = assert.rejects(job, /closed/);
  const idle = queue.onIdle();
  await queue.close({ cancelPending: true });
  await Promise.all([rejected, idle]);
  assert.equal(queue.stats.cancelled, 1);
});

test('clear rejects pending work but leaves the queue reusable', async () => {
  const queue = new TaskQueue({ paused: true });
  const job = queue.add(() => 1);
  queue.clear(new Error('removed'));
  await assert.rejects(job, /removed/);
  queue.start();
  assert.equal(await queue.add(() => 2), 2);
});

test('queue validates its settings and tasks', async () => {
  assert.throws(() => new TaskQueue({ concurrency: 0 }), /must/);
  assert.throws(() => new TaskQueue({ maxPending: -1 }), /must/);
  const queue = new TaskQueue();
  await assert.rejects(queue.add(null), /must/);
  await assert.rejects(queue.add(() => 1, { priority: NaN }), /must/);
});

test('mapConcurrent preserves input order', async () => {
  const gate = deferred();
  const result = mapConcurrent([1, 2, 3], async (value, index) => {
    if (index === 0) await gate.promise;
    else gate.resolve();
    return value * 2;
  }, { concurrency: 2 });
  assert.deepEqual(await result, [2, 4, 6]);
});

test('mapConcurrent supports settled results', async () => {
  const result = await mapConcurrent([1, 2], (value) => {
    if (value === 1) throw new Error('bad item');
    return value;
  }, { settled: true });
  assert.equal(result[0].status, 'rejected');
  assert.equal(result[0].reason.message, 'bad item');
  assert.deepEqual(result[1], { status: 'fulfilled', value: 2 });
});

test('mapConcurrent handles empty input and propagates failures', async () => {
  assert.deepEqual(await mapConcurrent([], (value) => value), []);
  await assert.rejects(mapConcurrent([1], () => { throw new Error('broken'); }), /broken/);
  await assert.rejects(mapConcurrent([1], null), /must/);
});
