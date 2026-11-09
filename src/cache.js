import { callable, finiteNumber, positiveInteger } from './validation.js';

/** Expiring least-recently-used cache with shared asynchronous cache misses. */
export class LruCache {
  #entries = new Map();
  #loads = new Map();
  #maxSize;
  #ttl;
  #clock;

  constructor({ maxSize = 100, ttl = 0, clock = Date.now } = {}) {
    positiveInteger(maxSize, 'maxSize');
    finiteNumber(ttl, 'ttl', { min: 0 });
    callable(clock, 'clock');
    this.#maxSize = maxSize;
    this.#ttl = ttl;
    this.#clock = clock;
  }

  get size() {
    this.prune();
    return this.#entries.size;
  }

  has(key) { return this.#lookup(key) !== undefined; }

  get(key) {
    const entry = this.#lookup(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key, value, { ttl = this.#ttl } = {}) {
    finiteNumber(ttl, 'ttl', { min: 0 });
    this.#loads.delete(key);
    this.prune();
    this.#entries.delete(key);
    this.#entries.set(key, {
      value,
      expires: ttl === 0 ? Infinity : this.#clock() + ttl,
    });
    while (this.#entries.size > this.#maxSize) {
      this.#entries.delete(this.#entries.keys().next().value);
    }
    return this;
  }

  delete(key) {
    this.#loads.delete(key);
    return this.#entries.delete(key);
  }

  clear() {
    this.#loads.clear();
    this.#entries.clear();
  }

  prune() {
    const now = this.#clock();
    let removed = 0;
    for (const [key, entry] of this.#entries) {
      if (entry.expires <= now) {
        this.#entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  *entries() {
    this.prune();
    for (const [key, entry] of this.#entries) yield [key, entry.value];
  }

  async getOrLoad(key, loader, options = {}) {
    callable(loader, 'loader');
    if (this.has(key)) return this.get(key);
    if (this.#loads.has(key)) return this.#loads.get(key);

    const loading = Promise.resolve().then(() => loader(key)).then((value) => {
      // A newer write, delete, or clear invalidates this load's right to store.
      if (this.#loads.get(key) === loading) this.set(key, value, options);
      return value;
    }).finally(() => {
      if (this.#loads.get(key) === loading) this.#loads.delete(key);
    });
    this.#loads.set(key, loading);
    return loading;
  }

  #lookup(key) {
    const entry = this.#entries.get(key);
    if (entry && entry.expires <= this.#clock()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry;
  }
}
