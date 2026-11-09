/** Shared option checks keep invalid values out of timers and schedulers. */
export function finiteNumber(value, name, { min = -Infinity, max = Infinity } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(`${name} must be a finite number between ${min} and ${max}`);
  }
  return value;
}

export function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

export function callable(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  return value;
}

export function throwIfAborted(signal) {
  signal?.throwIfAborted();
}
