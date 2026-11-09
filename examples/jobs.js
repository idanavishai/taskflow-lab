import { LruCache, Pipeline, mapConcurrent, retry } from '../src/index.js';

const cache = new LruCache({ maxSize: 50, ttl: 60000 });
const attempts = new Map();
const pipeline = new Pipeline()
  .use('normalize', (job) => ({ ...job, label: job.label.trim().toLowerCase() }))
  .use('calculate', (job) => ({ ...job, total: job.quantity * job.unitPrice }))
  .use('format', (job) => ({ id: job.id, label: job.label, total: job.total.toFixed(2) }));

const jobs = [
  { id: 'order-1', label: ' NOTEBOOK ', quantity: 3, unitPrice: 4.5 },
  { id: 'order-2', label: ' Pencil ', quantity: 10, unitPrice: 0.8 },
  { id: 'order-3', label: ' Pen ', quantity: 4, unitPrice: 1.2 },
];

const result = await mapConcurrent(jobs, (job) => cache.getOrLoad(job.id, () => retry(async () => {
  const count = (attempts.get(job.id) ?? 0) + 1;
  attempts.set(job.id, count);
  if (job.id === 'order-2' && count === 1) throw new Error('Simulated transient failure');
  return pipeline.run(job);
}, { attempts: 3, minDelay: 5 })), { concurrency: 2 });

console.log(JSON.stringify({ result, attempts: Object.fromEntries(attempts) }, null, 2));
