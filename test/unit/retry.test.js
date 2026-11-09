import test from 'node:test';
import assert from 'node:assert/strict';
import { delay, retry, backoff } from '../../src/retry.js';

test('retry returns the first successful result and numbers attempts from one', async () => {
  const calls = [];
  const result = await retry(({ attempt }) => {
    calls.push(attempt);
    if (attempt < 3) throw new Error('transient');
    return 42;
  }, { attempts: 4, minDelay: 0 });
  assert.equal(result, 42);
  assert.deepEqual(calls, [1, 2, 3]);
});

test('retry preserves the final failure', async () => {
  const error = new Error('offline');
  let calls = 0;
  await assert.rejects(retry(() => { calls++; throw error; }, {
    attempts: 2, minDelay: 0,
  }), (actual) => actual === error);
  assert.equal(calls, 2);
});

test('retry can reject non-retryable failures without another attempt', async () => {
  let calls = 0;
  await assert.rejects(retry(() => { calls++; throw new Error('invalid'); }, {
    shouldRetry: () => false, minDelay: 0,
  }), /invalid/);
  assert.equal(calls, 1);
});

test('retry reports each retry but never reports the final failure as a retry', async () => {
  const events = [];
  await assert.rejects(retry(() => { throw new Error('no'); }, {
    attempts: 3, minDelay: 0, onRetry: (event) => events.push(event.attempt),
  }), /no/);
  assert.deepEqual(events, [1, 2]);
});

test('retry honors cancellation before calling the operation', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  let called = false;
  await assert.rejects(retry(() => { called = true; }, {
    signal: controller.signal,
  }), /cancelled/);
  assert.equal(called, false);
});

test('retry cancellation interrupts backoff', async () => {
  const controller = new AbortController();
  await assert.rejects(retry(() => { throw new Error('retry'); }, {
    signal: controller.signal,
    minDelay: 10000,
    onRetry: () => controller.abort(new Error('stop waiting')),
  }), /stop waiting/);
});

test('retry supports asynchronous retry decisions', async () => {
  let calls = 0;
  const value = await retry(() => {
    if (++calls === 1) throw new Error('again');
    return 'ok';
  }, { minDelay: 0, shouldRetry: async () => true });
  assert.equal(value, 'ok');
});

test('backoff grows exponentially and caps at maxDelay', () => {
  assert.deepEqual([1, 2, 3, 4].map((attempt) => backoff(attempt, {
    minDelay: 10, factor: 3, maxDelay: 50,
  })), [10, 30, 50, 50]);
});

test('backoff jitter remains within its configured range', () => {
  for (let i = 0; i < 100; i++) {
    const value = backoff(2, { minDelay: 100, jitter: 0.5 });
    assert.ok(value >= 100 && value <= 200);
  }
});

for (const options of [{ attempts: 0 }, { attempts: 1.5 }, { minDelay: -1 },
  { maxDelay: Infinity }, { factor: 0 }, { jitter: 2 }, { onRetry: true }]) {
  test(`retry rejects invalid options ${JSON.stringify(options)}`, async () => {
    await assert.rejects(retry(() => 1, options), /must/);
  });
}

test('delay resolves a value and rejects invalid durations', async () => {
  assert.equal(await delay(0, { value: 'done' }), 'done');
  await assert.rejects(delay(-1), /must/);
});

test('delay reacts to an abort while waiting', async () => {
  const controller = new AbortController();
  const waiting = delay(10000, { signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
});
