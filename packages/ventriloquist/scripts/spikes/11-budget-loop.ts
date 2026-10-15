/* oxlint-disable -- COR-1522 throwaway spike: measures behavior, is not production code, and is deleted or promoted by the implementation. */
/**
 * Spike 11: the recommended pump against the session core's real `OutputBudget`.
 *
 * The pump reads a source only while the budget has headroom, slices an oversized chunk to what
 * fits (the remainder is carried, at most one source chunk), and a consumer acknowledges chunks
 * after a delay, including a full stall. Run against:
 *   pipe  Bun.spawn pipe, pulled through a ReadableStream reader (pause = not calling read())
 *   pty   owned PTY master read by the worker reader (pause = the reader's credit window)
 *
 *   bun 11-budget-loop.ts <pipe|pty> <finite|flood>
 *
 * finite: `cat` of a base64 corpus; every byte must arrive once, in order (sha256), with pending
 *         bytes never above the budget and no overflow, despite a 2.5 s consumer stall.
 * flood:  `yes` for 6 s with the same consumer; memory stays flat, producer stays alive, then a
 *         stalled consumer is shown to leave the producer blocked.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutputBudget } from '../../src/session/output-budget.ts';
import { spawnOnPty } from './own-pty.ts';
import { workerReader, type PausableReader } from './readers.ts';
import {
  cpuTimeOf,
  guard,
  killGroup,
  report,
  residentKilobytes,
  sha256OfCommand,
  sleep,
  stateOf,
} from './spike-support.ts';

const [mode = 'pipe', scenario = 'finite'] = process.argv.slice(2);
guard({ maximumRssMegabytes: 400, maximumSeconds: 120 });
const LIMIT = 1024 * 1024; // the session's default output budget
const LOW_WATER = 64 * 1024; // only pull when at least this much headroom exists

const directory = mkdtempSync(join(tmpdir(), 'cor-1522-budget-'));
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
const corpus = join(directory, 'corpus.txt');
spawnSync('sh', ['-c', `head -c 24000000 /dev/urandom | base64 > '${corpus}'`]);
const corpusBytes = statSync(corpus).size;
const command = scenario === 'finite' ? ['cat', corpus] : ['yes'];

// ---- source: a pull function over either backend -------------------------------------------------
type Pull = () => Promise<Uint8Array | null>;
let pull: Pull;
let pid: number;
let stop: () => void;
if (mode === 'pipe') {
  const child = Bun.spawn(command, {
    stdout: 'pipe',
    stderr: 'ignore',
    stdin: 'ignore',
    detached: true,
  });
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader(); // taken in the spawn tick
  pid = child.pid;
  pull = async () => {
    const result = await reader.read();
    return result.done ? null : result.value;
  };
  stop = () => killGroup(pid);
} else {
  const { child, pair } = spawnOnPty(command, {});
  pid = child.pid;
  // Pull-by-credit adapter: the worker reader is resumed only for the duration of one read().
  const queue: Uint8Array[] = [];
  let waiter: ((chunk: Uint8Array | null) => void) | undefined;
  let ended = false;
  let reader: PausableReader;
  reader = workerReader(pair.masterFd, (chunk) => {
    if (waiter !== undefined) {
      const w = waiter;
      waiter = undefined;
      reader.pause();
      w(chunk);
    } else {
      queue.push(chunk);
      reader.pause();
    }
  });
  void reader.done.then(() => {
    ended = true;
    waiter?.(null);
  });
  pull = () => {
    const next = queue.shift();
    if (next !== undefined) return Promise.resolve(next);
    if (ended) return Promise.resolve(null);
    return new Promise((resolve) => {
      waiter = resolve;
      reader.resume();
    });
  };
  stop = () => {
    killGroup(pid);
    reader.resume();
  };
}

// ---- the pump and a consumer ---------------------------------------------------------------------
const budget = new OutputBudget(LIMIT);
const hasher = new Bun.CryptoHasher('sha256');
let delivered = 0;
let maxPending = 0;
let overflows = 0;
let reads = 0;
let waitsForHeadroom = 0;
let stalledUntil = 0;
let wake: (() => void) | undefined;
const outstanding = new Map<number, number>(); // chunk id -> byte length

function ackLater(chunkId: number, bytes: number): void {
  const now = performance.now();
  const delay = Math.max(stalledUntil - now, 0) + Math.random() * 2;
  setTimeout(() => {
    budget.release(chunkId);
    outstanding.delete(chunkId);
    wake?.();
  }, delay);
  void bytes;
}

function strip(bytes: Uint8Array): Uint8Array {
  if (mode !== 'pty' || scenario !== 'finite') return bytes;
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (const byte of bytes) if (byte !== 13) out[n++] = byte;
  return out.subarray(0, n);
}

let finished = false;
const pumpDone = (async () => {
  let carry: Uint8Array | undefined;
  while (!finished) {
    if (carry === undefined) {
      while (LIMIT - budget.pendingBytes < LOW_WATER && !finished) {
        waitsForHeadroom += 1;
        await new Promise<void>((resolve) => (wake = resolve));
      }
      if (finished) break;
      const chunk = await pull();
      reads += 1;
      if (chunk === null) break;
      carry = chunk;
    }
    const room = LIMIT - budget.pendingBytes;
    if (room <= 0) {
      waitsForHeadroom += 1;
      await new Promise<void>((resolve) => (wake = resolve));
      continue;
    }
    const part = carry.subarray(0, room);
    carry = part.length < carry.length ? carry.subarray(part.length) : undefined;
    const chunkId = budget.reserve(part.length);
    if (chunkId === undefined) {
      overflows += 1; // would have been output-overflow
      break;
    }
    maxPending = Math.max(maxPending, budget.pendingBytes);
    outstanding.set(chunkId, part.length);
    delivered += part.length;
    hasher.update(strip(part));
    ackLater(chunkId, part.length);
  }
})();

// ---- drive the scenario --------------------------------------------------------------------------
const rss = (): number => Math.round((residentKilobytes(process.pid) ?? 0) / 1024);
const startRss = rss();
let peakRss = startRss;
const sampler = setInterval(() => (peakRss = Math.max(peakRss, rss())), 400);
const startedAt = performance.now();
const result: Record<string, unknown> = { mode, scenario };

if (scenario === 'finite') {
  setTimeout(() => (stalledUntil = performance.now() + 2500), 300); // a 2.5 s consumer stall mid-stream
  await Promise.race([pumpDone, sleep(90_000)]);
  // Wait for every outstanding acknowledgement.
  for (let i = 0; i < 400 && budget.pendingChunks > 0; i += 1) await sleep(10);
  const expected = sha256OfCommand(`cat '${corpus}'`);
  const digest = hasher.digest('hex');
  Object.assign(result, {
    ok: digest === expected && overflows === 0 && maxPending <= LIMIT && delivered >= corpusBytes,
    deliveredBytes: delivered,
    expectedBytes: corpusBytes,
    hashMatches: digest === expected,
    seconds: Math.round(((performance.now() - startedAt) / 1000) * 10) / 10,
  });
} else {
  await sleep(2000);
  stalledUntil = performance.now() + 4500;
  await sleep(1500); // inside the stall: pending is full and the pump is waiting
  const pendingDuringStall = budget.pendingBytes;
  const deliveredBefore = delivered;
  const cpuBefore = cpuTimeOf(pid);
  await sleep(1000);
  const flatDuringStall = delivered === deliveredBefore;
  const producerDuringStall = { state: stateOf(pid), cpuBefore, cpuAfter: cpuTimeOf(pid) };
  await sleep(3000); // the stall ends inside this wait: acknowledgements resume and the pump drains again
  const deliveredAfterStall = delivered;
  Object.assign(result, {
    resumedAfterStall: deliveredAfterStall > deliveredBefore,
    ok:
      overflows === 0 &&
      maxPending <= LIMIT &&
      flatDuringStall &&
      deliveredAfterStall > deliveredBefore &&
      peakRss - startRss < 40 &&
      stateOf(pid) !== 'gone',
    deliveredMb: Math.round(delivered / 1048576),
    pendingDuringStallKb: Math.round(pendingDuringStall / 1024),
    flatDuringStall,
    producerDuringStall,
  });
}
clearInterval(sampler);
Object.assign(result, {
  overflows,
  maxPendingKb: Math.round(maxPending / 1024),
  limitKb: LIMIT / 1024,
  reads,
  waitsForHeadroom,
  startRssMb: startRss,
  peakRssMb: peakRss,
});
report(`budget:${mode}:${scenario}`, result);
finished = true;
wake?.();
stop();
await sleep(300);
process.exit(0);
