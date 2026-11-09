import { performance } from 'node:perf_hooks';
import { callable, throwIfAborted } from './validation.js';

export class PipelineError extends Error {
  constructor(stage, index, cause) {
    super(`Pipeline stage "${stage}" failed`, { cause });
    this.name = 'PipelineError';
    this.stage = stage;
    this.index = index;
  }
}

/** Immutable pipeline definition. Each run owns its value and context. */
export class Pipeline {
  #stages = [];

  use(name, handler) {
    if (typeof name !== 'string' || !name.trim()) throw new TypeError('name must be non-empty');
    callable(handler, 'handler');
    if (this.#stages.some((stage) => stage.name === name)) {
      throw new Error(`duplicate pipeline stage: ${name}`);
    }
    const next = new Pipeline();
    next.#stages = [...this.#stages, { name, handler }];
    return next;
  }

  async run(input, { context = {}, signal, onStep = () => {} } = {}) {
    callable(onStep, 'onStep');
    throwIfAborted(signal);
    let value = input;
    for (const [index, stage] of this.#stages.entries()) {
      throwIfAborted(signal);
      const started = performance.now();
      try {
        value = await stage.handler(value, { context, signal, index });
        throwIfAborted(signal);
        await onStep({ name: stage.name, index, value, duration: performance.now() - started });
      } catch (cause) {
        throwIfAborted(signal);
        throw new PipelineError(stage.name, index, cause);
      }
    }
    throwIfAborted(signal);
    return value;
  }
}
