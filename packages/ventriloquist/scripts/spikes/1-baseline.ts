/* oxlint-disable -- COR-1522 throwaway spike: measures behavior, is not production code, and is deleted or promoted by the implementation. */
/**
 * Spike 1: what does Bun 1.4.2 do today when nothing consumes a flooding producer's output?
 *
 *   bun 1-baseline.ts <case> [seconds]
 *
 * Cases:
 *   pipe-untouched    stdout: 'pipe', child.stdout never touched
 *   pipe-reader-idle  child.stdout.getReader() taken, read() never called
 *   pipe-access-only  child.stdout read as a property (so the stream exists) but no reader taken
 *   pipe-read-n       read N chunks, then stop pulling (shows read-ahead depth)
 *   pty-count         terminal data callback only counts (cannot stop it): the production shape
 *   pty-hold          data callback retains every chunk (the status quo when nothing drains)
 *   pty-unref         terminal.unref() after spawn, data callback counts
 *   pty-nodata        terminal given no data callback at all
 *
 * Samples host RSS, bytes seen by the host, and the producer's kernel state twice a second.
 */
import { GATE_STDIO, gatedCommand, releaseGate } from '../../src/bun/pty-start-gate.ts';
import {
  cpuTimeOf,
  guard,
  kill,
  killGroup,
  report,
  residentKilobytes,
  sleep,
  stateOf,
} from './spike-support.ts';

const [caseName = 'pipe-untouched', secondsArgument = '6'] = process.argv.slice(2);
const seconds = Number(secondsArgument);
guard({ maximumRssMegabytes: 500, maximumSeconds: seconds + 20 });

let seen = 0;
let chunks = 0;
const held: Uint8Array[] = [];
let child: ReturnType<typeof Bun.spawn>;
let detail: Record<string, unknown> = {};

if (caseName.startsWith('pipe')) {
  child = Bun.spawn(['yes'], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', detached: true });
  if (caseName === 'pipe-access-only') void child.stdout;
  if (caseName === 'pipe-reader-idle') (child.stdout as ReadableStream<Uint8Array>).getReader();
  if (caseName === 'pipe-read-n') {
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    const sizes: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const result = await reader.read();
      sizes.push(result.value?.length ?? -1);
      seen += result.value?.length ?? 0;
    }
    detail = { firstChunkSizes: sizes };
  }
} else {
  const onData = (_t: unknown, bytes: Uint8Array): void => {
    seen += bytes.length;
    chunks += 1;
    if (caseName === 'pty-hold') held.push(bytes.slice());
  };
  child = Bun.spawn(gatedCommand(['yes']), {
    stdio: [...GATE_STDIO],
    terminal:
      caseName === 'pty-nodata' ? { cols: 80, rows: 24 } : { cols: 80, rows: 24, data: onData },
  });
  releaseGate(child as never);
  if (caseName === 'pty-unref') (child.terminal as { unref(): void }).unref();
}

const pid = child.pid;
const samples: { t: number; rssMb: number; seenMb: number; producer: string }[] = [];
const start = performance.now();
while (performance.now() - start < seconds * 1000) {
  await sleep(500);
  samples.push({
    t: Math.round((performance.now() - start) / 100) / 10,
    rssMb: Math.round((residentKilobytes(process.pid) ?? 0) / 1024),
    seenMb: Math.round(seen / 1048576),
    producer: stateOf(pid),
  });
}
const producerCpu = cpuTimeOf(pid);
for (const s of samples) console.log(JSON.stringify(s));
// `yes` is the session leader (pty) or a detached group leader (pipe): kill its group, then it alone.
killGroup(pid);
kill(pid);
report(`baseline:${caseName}`, {
  seconds,
  finalRssMb: samples.at(-1)?.rssMb,
  startRssMb: samples[0]?.rssMb,
  seenMb: Math.round(seen / 1048576),
  chunks,
  heldMb: Math.round(held.reduce((n, c) => n + c.length, 0) / 1048576),
  lastProducerState: samples.at(-1)?.producer,
  producerCpu,
  ...detail,
});
process.exit(0);
