import { callable, finiteNumber, positiveInteger, throwIfAborted } from './validation.js';

/** In-memory priority queue. Running tasks cooperate with cancellation. */
export class TaskQueue {
  #concurrency;
  #maxPending;
  #paused;
  #closed = false;
  #active = 0;
  #pending = [];
  #idle = new Set();
  #sequence = 0;
  #stats = { completed: 0, failed: 0, cancelled: 0 };

  constructor({ concurrency = 1, maxPending = Infinity, paused = false } = {}) {
    positiveInteger(concurrency, 'concurrency');
    if (maxPending !== Infinity && (!Number.isSafeInteger(maxPending) || maxPending < 0)) {
      throw new TypeError('maxPending must be a non-negative safe integer or Infinity');
    }
    this.#concurrency = concurrency;
    this.#maxPending = maxPending;
    this.#paused = Boolean(paused);
  }

  get active() { return this.#active; }
  get size() { return this.#pending.length; }
  get stats() { return { ...this.#stats }; }

  /** Higher priorities start first. Equal priorities retain insertion order. */
  add(task, { priority = 0, signal } = {}) {
    return new Promise((resolve, reject) => {
      callable(task, 'task');
      finiteNumber(priority, 'priority');
      throwIfAborted(signal);
      if (this.#closed) throw new Error('Queue is closed');
      const canStart = !this.#paused && this.#active < this.#concurrency;
      if (!canStart && this.size >= this.#maxPending) throw new Error('Queue capacity exceeded');

      const job = { task, priority, signal, resolve, reject, sequence: this.#sequence++ };
      job.onAbort = () => {
        const index = this.#pending.indexOf(job);
        if (index === -1) return;
        this.#pending.splice(index, 1);
        signal.removeEventListener('abort', job.onAbort);
        this.#stats.cancelled++;
        reject(signal.reason);
        this.#notifyIdle();
      };
      signal?.addEventListener('abort', job.onAbort, { once: true });
      this.#pending.push(job);
      this.#pending.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
      this.#drain();
    });
  }

  pause() { this.#paused = true; }

  start() {
    this.#paused = false;
    this.#drain();
  }

  clear(reason = new Error('Queue cleared')) {
    const jobs = this.#pending.splice(0);
    for (const job of jobs) {
      job.signal?.removeEventListener('abort', job.onAbort);
      this.#stats.cancelled++;
      job.reject(reason);
    }
    this.#notifyIdle();
    return jobs.length;
  }

  onIdle() {
    if (this.#active === 0 && this.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idle.add(resolve));
  }

  /** Stop accepting jobs, then drain or cancel queued jobs and await active work. */
  close({ cancelPending = false } = {}) {
    this.#closed = true;
    if (cancelPending) this.clear(new Error('Queue closed'));
    this.start();
    return this.onIdle();
  }

  #drain() {
    while (!this.#paused && this.#active < this.#concurrency && this.size > 0) {
      const job = this.#pending.shift();
      job.signal?.removeEventListener('abort', job.onAbort);
      this.#active++;
      Promise.resolve().then(() => {
        throwIfAborted(job.signal);
        return job.task({ signal: job.signal });
      }).then(
        (value) => this.#finish(job, true, value),
        (error) => this.#finish(job, false, error),
      );
    }
    this.#notifyIdle();
  }

  #finish(job, success, result) {
    this.#active--;
    this.#stats[success ? 'completed' : 'failed']++;
    if (success) job.resolve(result);
    else job.reject(result);
    this.#drain();
  }

  #notifyIdle() {
    if (this.#active !== 0 || this.size !== 0) return;
    for (const resolve of this.#idle) resolve();
    this.#idle.clear();
  }
}

/** Map an iterable concurrently while retaining input order in the result. */
export async function mapConcurrent(items, mapper, {
  concurrency = 4, signal, settled = false,
} = {}) {
  callable(mapper, 'mapper');
  throwIfAborted(signal);
  const queue = new TaskQueue({ concurrency });
  const values = Array.from(items);
  const promises = values.map((value, index) => queue.add(
    () => { throwIfAborted(signal); return mapper(value, index, { signal }); },
  ));
  const results = settled ? Promise.allSettled(promises) : Promise.all(promises);
  // Each promise already has a handler before the queue is drained.
  queue.close();
  return results;
}
