import test from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline, PipelineError } from '../../src/pipeline.js';

test('pipeline composes synchronous and asynchronous stages in order', async () => {
  const pipeline = new Pipeline()
    .use('parse', (value) => Number(value))
    .use('double', async (value) => value * 2)
    .use('label', (value) => `total:${value}`);
  assert.equal(await pipeline.run('21'), 'total:42');
});

test('extending a pipeline leaves the original reusable', async () => {
  const base = new Pipeline().use('add', (value) => value + 1);
  const extended = base.use('double', (value) => value * 2);
  assert.equal(await base.run(2), 3);
  assert.equal(await extended.run(2), 6);
});

test('stages share per-run context and receive index and signal', async () => {
  const context = { suffix: '!' };
  const controller = new AbortController();
  const pipeline = new Pipeline().use('append', (value, info) => {
    assert.equal(info.context, context);
    assert.equal(info.signal, controller.signal);
    assert.equal(info.index, 0);
    return value + info.context.suffix;
  });
  assert.equal(await pipeline.run('ok', { context, signal: controller.signal }), 'ok!');
});

test('pipeline errors preserve the original cause and failing stage', async () => {
  const cause = new Error('invalid input');
  const pipeline = new Pipeline().use('parse', () => { throw cause; });
  await assert.rejects(pipeline.run('bad'), (error) => {
    assert.ok(error instanceof PipelineError);
    assert.equal(error.cause, cause);
    assert.equal(error.stage, 'parse');
    assert.equal(error.index, 0);
    return true;
  });
});

test('pipeline stops before the next stage when aborted', async () => {
  const controller = new AbortController();
  let later = false;
  const pipeline = new Pipeline()
    .use('cancel', () => controller.abort(new Error('stopped')))
    .use('later', () => { later = true; });
  await assert.rejects(pipeline.run(null, { signal: controller.signal }), /stopped/);
  assert.equal(later, false);
});

test('pipeline reports successful stages with their outputs', async () => {
  const events = [];
  await new Pipeline().use('double', (value) => value * 2).run(5, {
    onStep: (event) => events.push(event),
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'double');
  assert.equal(events[0].value, 10);
  assert.ok(events[0].duration >= 0);
});

test('empty pipelines pass their input through', async () => {
  assert.equal(await new Pipeline().run(4), 4);
});

test('pipeline rejects empty names, duplicate names, and invalid handlers', () => {
  const pipeline = new Pipeline().use('one', (value) => value);
  assert.throws(() => pipeline.use('', () => 1), /must/);
  assert.throws(() => pipeline.use('one', () => 1), /duplicate/);
  assert.throws(() => pipeline.use('two', null), /must/);
});
