/* oxlint-disable -- COR-1522 throwaway spike: measures behavior, is not production code, and is deleted or promoted by the implementation. */
/**
 * Spike 8: native Bun.spawn({ terminal }) versus the owned PTY with the worker reader, measured
 * alternately in one process so host load affects both alike. Reports MB/s for a block-writing
 * producer (cat of a base64 corpus) and the time from spawning `echo hi` to its first byte.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GATE_STDIO, gatedCommand, releaseGate } from '../../src/bun/pty-start-gate.ts';
import { spawnOnPty } from './own-pty.ts';
import { workerReader } from './readers.ts';
import { guard, killGroup, report, sleep } from './spike-support.ts';

guard({ maximumRssMegabytes: 600, maximumSeconds: 200 });
const directory = mkdtempSync(join(tmpdir(), 'cor-1522-cmp-'));
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
const corpus = join(directory, 'corpus.txt');
spawnSync('sh', ['-c', `head -c 30000000 /dev/urandom | base64 > '${corpus}'`]);
const size = statSync(corpus).size;
const rounds = 3;

async function native(
  command: string[],
): Promise<{ bytes: number; seconds: number; firstByteMs: number }> {
  const started = performance.now();
  let bytes = 0;
  let first = 0;
  let resolveEnd!: () => void;
  const ended = new Promise<void>((resolve) => (resolveEnd = resolve));
  const child = Bun.spawn(gatedCommand(command), {
    stdio: [...GATE_STDIO],
    terminal: {
      cols: 80,
      rows: 24,
      data: (_t: unknown, chunk: Uint8Array) => {
        if (first === 0) first = performance.now();
        bytes += chunk.length;
      },
      exit: () => resolveEnd(),
    },
  });
  releaseGate(child as never);
  await Promise.race([ended, sleep(60_000)]);
  await child.exited;
  return {
    bytes,
    seconds: (performance.now() - started) / 1000,
    firstByteMs: Math.round(first - started),
  };
}

async function owned(
  command: string[],
): Promise<{ bytes: number; seconds: number; firstByteMs: number }> {
  const started = performance.now();
  let bytes = 0;
  let first = 0;
  const { child, pair } = spawnOnPty(command, {});
  const reader = workerReader(pair.masterFd, (chunk) => {
    if (first === 0) first = performance.now();
    bytes += chunk.length;
  });
  reader.resume();
  await Promise.race([reader.done, sleep(60_000)]);
  await child.exited;
  killGroup(child.pid);
  return {
    bytes,
    seconds: (performance.now() - started) / 1000,
    firstByteMs: Math.round(first - started),
  };
}

const rows: Record<string, number[]> = {
  nativeMbps: [],
  ownedMbps: [],
  nativeFirstByteMs: [],
  ownedFirstByteMs: [],
};
for (let round = 0; round < rounds; round += 1) {
  const a = await native(['cat', corpus]);
  const b = await owned(['cat', corpus]);
  rows['nativeMbps']!.push(Math.round((a.bytes / 1048576 / a.seconds) * 10) / 10);
  rows['ownedMbps']!.push(Math.round((b.bytes / 1048576 / b.seconds) * 10) / 10);
  const c = await native(['echo', 'hi']);
  const d = await owned(['echo', 'hi']);
  rows['nativeFirstByteMs']!.push(c.firstByteMs);
  rows['ownedFirstByteMs']!.push(d.firstByteMs);
  if (a.bytes < size || b.bytes < size) rows['short'] = [...(rows['short'] ?? []), round];
}
report('compare', rows);
process.exit(0);
