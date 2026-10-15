/* oxlint-disable -- COR-1522 throwaway spike: measures behavior, is not production code, and is deleted or promoted by the implementation. */
/**
 * Spike 7: a blocking-descriptor reader (fs.createReadStream / tty.ReadStream on a master left in
 * blocking mode) parks one thread per idle session. Does that starve other asynchronous file work?
 *
 *   bun 7-threadpool.ts <sessions> <fs|tty>
 */
import { readFile } from 'node:fs/promises';
import { spawnOnPty } from './own-pty.ts';
import { fsReadStreamReader, ttyReadStreamReader } from './readers.ts';
import { guard, killGroup, report, sleep } from './spike-support.ts';

guard({ maximumRssMegabytes: 800, maximumSeconds: 60 });
const sessions = Number(process.argv[2] ?? 16);
const kind = process.argv[3] ?? 'fs';
const runs: { pid: number }[] = [];
const timeOf = async (
  label: string,
  work: () => Promise<unknown>,
): Promise<[string, number | string]> => {
  const start = performance.now();
  const outcome = await Promise.race([work().then(() => 'ok'), sleep(4000).then(() => 'TIMEOUT')]);
  return [label, outcome === 'ok' ? Math.round(performance.now() - start) : 'TIMEOUT>4000ms'];
};
const baseline = await timeOf('readFile-before', () => readFile('/etc/hosts'));
for (let i = 0; i < sessions; i += 1) {
  const { child, pair } = spawnOnPty(['sleep', '30'], { nonBlocking: false });
  const reader =
    kind === 'tty'
      ? ttyReadStreamReader(pair.masterFd, () => undefined)
      : fsReadStreamReader(pair.masterFd, () => undefined);
  reader.resume();
  runs.push({ pid: child.pid });
}
await sleep(500);
const results = [
  baseline,
  await timeOf('readFile-after', () => readFile('/etc/hosts')),
  await timeOf('Bun.file.text-after', () => Bun.file('/etc/hosts').text()),
  await timeOf('spawn-after', () => Bun.spawn(['true']).exited),
];
report(`threadpool:${kind}`, { sessions, results });
for (const run of runs) killGroup(run.pid);
process.exit(0);
