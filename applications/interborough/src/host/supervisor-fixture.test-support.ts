/**
 * A stand-in for the host, run by `supervisor.test.ts` under the real supervisor. Each start
 * appends a line to the log named by the first argument. With `exit` and a list of codes it exits
 * with the next code of the list on each start (the last one repeats). With `wait` it writes the
 * file named by the second argument once its signal handler is installed, then waits: SIGINT or SIGTERM ends
 * it with the code named by the third argument, and a second argument of `unhandled` installs no
 * handler at all.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const [log, behavior, ...rest] = process.argv.slice(2);
if (log === undefined) throw new Error('The fixture needs a log file.');

appendFileSync(log, 'start\n');
const starts = readFileSync(log, 'utf8').trim().split('\n').length;

if (behavior === 'exit') {
  const codes = rest.map(Number);
  process.exit(codes[Math.min(starts, codes.length) - 1] ?? 0);
}

if (behavior === 'wait') {
  const [readyFile, exitCode] = rest;
  if (readyFile === undefined) throw new Error('The wait behavior needs a ready file.');
  if (exitCode !== 'unhandled') {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => process.exit(Number(exitCode)));
    }
  }
  writeFileSync(readyFile, 'ready');
  setInterval(() => {}, 1000);
}
