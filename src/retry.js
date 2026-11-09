import { setTimeout as sleep } from 'node:timers/promises';
import { callable, finiteNumber, positiveInteger, throwIfAborted } from './validation.js';

const MAX_TIMER = 2 ** 31 - 1;

/** Wait for a bounded duration, optionally returning a value or reacting to abort. */
export async function delay(milliseconds, { signal, value } = {}) {
  finiteNumber(milliseconds, 'milliseconds', { min: 0, max: MAX_TIMER });
  throwIfAborted(signal);
  try {
    return await sleep(milliseconds, value, { signal });
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  }
}

function normalizeBackoff({ minDelay = 100, maxDelay = 30000, factor = 2, jitter = 0 } = {}) {
  finiteNumber(minDelay, 'minDelay', { min: 0, max: MAX_TIMER });
  finiteNumber(maxDelay, 'maxDelay', { min: 0, max: MAX_TIMER });
  finiteNumber(factor, 'factor', { min: 1 });
  finiteNumber(jitter, 'jitter', { min: 0, max: 1 });
  return { minDelay, maxDelay, factor, jitter };
}

/** Calculate delay after a failed attempt. Jitter only reduces the capped delay. */
export function backoff(attempt, options = {}) {
  positiveInteger(attempt, 'attempt');
  const { minDelay, maxDelay, factor, jitter } = normalizeBackoff(options);
  // Avoid 0 * Infinity when a caller requests many zero-delay retries.
  const base = minDelay === 0 ? 0 : Math.min(maxDelay, minDelay * factor ** (attempt - 1));
  return Math.floor(base * (1 - jitter * Math.random()));
}

/** Retry an operation a bounded number of times, preserving the final error. */
export async function retry(operation, options = {}) {
  callable(operation, 'operation');
  const {
    attempts = 3,
    signal,
    shouldRetry = () => true,
    onRetry = () => {},
  } = options;
  positiveInteger(attempts, 'attempts');
  callable(shouldRetry, 'shouldRetry');
  callable(onRetry, 'onRetry');
  const timing = normalizeBackoff(options);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    throwIfAborted(signal);
    try {
      const value = await operation({ attempt, signal });
      throwIfAborted(signal);
      return value;
    } catch (error) {
      throwIfAborted(signal);
      if (attempt === attempts || !await shouldRetry(error, { attempt, signal })) throw error;
      const milliseconds = backoff(attempt, timing);
      await onRetry({ error, attempt, delay: milliseconds });
      await delay(milliseconds, { signal });
    }
  }
}
