import { startChallengeListener } from './challenge-listener.js';

let listener;
const interrupt = () => { listener?.close(); };
try {
  listener = await startChallengeListener({
    token: process.env.SHELL_LAB_TOKEN,
    port: Number(process.env.SHELL_LAB_PORT ?? 8787),
    timeoutMs: Number(process.env.SHELL_LAB_LISTENER_TIMEOUT_MS ?? 120000),
  });
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  console.log(`Fixed-challenge listener ready at ${listener.url}`);
  console.log('Waiting for one authenticated lab shell. The challenge sends printf and exit only.');
  const result = await listener.completed;
  console.log(`Challenge passed: ${result.marker}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  await listener?.close();
}
