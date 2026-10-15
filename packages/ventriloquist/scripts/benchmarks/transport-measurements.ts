import type { ObservedWorkload } from '../../../../scripts/terminal/evidence-schema.ts';
import { hostFor } from '../../src/bun/bun-process.test-support.ts';
import { shellProfile } from '../../src/bun/fixtures/bun-pipe-stdin.ts';
import { STUBBORN_DESCENDANT, pidsIn } from '../../src/bun/fixtures/terminal-output.ts';
import { createPtyProcess } from '../../src/bun/pty-process.ts';
import {
  createRig,
  type ProcessMode,
  type Rig,
  type TransportPath,
} from '../../src/conformance/conformance.test-support.ts';
import { scriptedProcess } from '../../src/websocket/websocket.test-support.ts';
import { SAMPLES, hostConditions, percentile } from './benchmark-report.ts';

const MEBIBYTE = 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
/** Chunks the producer keeps in flight: a quarter of the 1 MiB output budget, so the benchmark measures the path and not an overflow. */
const WINDOW_CHUNKS = 4;
const LATENCY_PAYLOAD = 'x';

const idle = shellProfile('true');

function observation(
  durationMilliseconds: number,
  sampleCount: number,
  warmupCount: number,
  metrics: ObservedWorkload['metrics'],
  raw: Record<string, unknown>,
): ObservedWorkload {
  return {
    durationMilliseconds,
    sampleCount,
    warmupCount,
    metrics,
    raw: { ...raw, host: hostConditions() },
  };
}

async function finish(rig: Rig): Promise<void> {
  rig.client.sendResult(rig.client.endpoint.terminate());
  await rig.client.waitForKind('cleanup-result');
  await rig.stop();
}

async function scriptedRig(path: TransportPath, pauseConsuming = false) {
  const scripted = scriptedProcess();
  const rig = createRig(path, { profile: idle, mode: 'pty', hosted: scripted.hosted });
  if (pauseConsuming) rig.pauseConsuming();
  await rig.client.handshake();
  return { scripted, rig };
}

/**
 * Forget the frames the client has already handled. The test clients keep every frame so a test
 * can inspect it, which for megabytes of output would measure the client's retention, not the host's.
 */
function discardHandled(rig: Rig): void {
  rig.client.frames.splice(0);
  rig.client.messages.splice(0);
}

type Transfer = { bytes: number; duration: number; queuePeak: number; rssPeakBytes: number };

/**
 * Push `totalBytes` through a path in 64 KiB chunks, never more than a window ahead of what the
 * client has reported parsed, and stop the clock when the last byte has been parsed.
 */
async function transfer(path: TransportPath, totalBytes: number): Promise<Transfer> {
  const { scripted, rig } = await scriptedRig(path);
  const chunk = new Uint8Array(CHUNK_BYTES).fill(97);
  const chunks = totalBytes / CHUNK_BYTES;
  let pushed = 0;
  let queuePeak = 0;
  let rssPeakBytes = process.memoryUsage().rss;
  const startedAt = performance.now();
  while (pushed < chunks) {
    const outstanding = pushed - Math.floor(rig.client.endpoint.outputBytes.consumed / CHUNK_BYTES);
    if (outstanding >= WINDOW_CHUNKS) {
      discardHandled(rig);
      await rig.client.waitForFrames(rig.client.frames.length + 1);
      continue;
    }
    scripted.stream.push(chunk);
    pushed += 1;
    queuePeak = Math.max(queuePeak, outstanding + 1);
    if (pushed % 8 === 0) rssPeakBytes = Math.max(rssPeakBytes, process.memoryUsage().rss);
  }
  while (rig.client.endpoint.outputBytes.consumed < totalBytes) {
    discardHandled(rig);
    await rig.client.waitForFrames(rig.client.frames.length + 1);
  }
  const duration = performance.now() - startedAt;
  discardHandled(rig);
  await finish(rig);
  return { bytes: totalBytes, duration, queuePeak, rssPeakBytes };
}

const TRANSFER_BYTES = 8 * MEBIBYTE;

export function throughputObservation(bytes: number, duration: number, queuePeak: number) {
  return observation(
    duration,
    SAMPLES.transfer,
    0,
    {
      throughput: { value: bytes / (duration / 1_000), unit: 'bytes/second' },
      queuePeak: { value: queuePeak, unit: 'chunks' },
    },
    { bytes, duration, queuePeak, chunkBytes: CHUNK_BYTES, windowChunks: WINDOW_CHUNKS },
  );
}

export async function measureThroughput(path: TransportPath): Promise<ObservedWorkload> {
  const result = await transfer(path, TRANSFER_BYTES);
  return throughputObservation(result.bytes, result.duration, result.queuePeak);
}

/** Round trips for one-byte input, acknowledged into the host FIFO, one thousand times. */
export async function measureAcknowledgementLatency(
  path: TransportPath,
): Promise<ObservedWorkload> {
  const { rig } = await scriptedRig(path);
  const samples: number[] = [];
  const startedAt = performance.now();
  for (let sample = 0; sample < SAMPLES.latency; sample += 1) {
    const from = rig.client.messages.length;
    const sampleStartedAt = performance.now();
    rig.client.sendResult(rig.client.endpoint.input(LATENCY_PAYLOAD));
    await rig.client.waitFor((message) => message.kind === 'operation-ack', from);
    samples.push(performance.now() - sampleStartedAt);
  }
  const duration = performance.now() - startedAt;
  await finish(rig);
  return latencyObservation(samples, duration);
}

export function latencyObservation(samples: number[], duration: number): ObservedWorkload {
  return observation(
    duration,
    samples.length,
    0,
    {
      p50: { value: percentile(samples, 0.5), unit: 'milliseconds' },
      p95: { value: percentile(samples, 0.95), unit: 'milliseconds' },
      p99: { value: percentile(samples, 0.99), unit: 'milliseconds' },
    },
    { samples },
  );
}

/** One byte typed into a real PTY and the terminal's own echo coming back, one thousand times. */
export async function measureTerminalEchoLatency(path: TransportPath): Promise<ObservedWorkload> {
  const profile = shellProfile("printf 'ready '; exec cat");
  const rig = createRig(path, { profile, mode: 'pty', hosted: hostFor('pty', profile) });
  await rig.client.handshake();
  await rig.client.waitForOutput('ready ');
  const samples: number[] = [];
  const startedAt = performance.now();
  for (let sample = 0; sample < SAMPLES.latency; sample += 1) {
    const received = rig.client.endpoint.outputBytes.received;
    const sampleStartedAt = performance.now();
    rig.client.sendResult(rig.client.endpoint.input(LATENCY_PAYLOAD));
    while (rig.client.endpoint.outputBytes.received <= received) {
      await rig.client.waitForFrames(rig.client.frames.length + 1);
    }
    samples.push(performance.now() - sampleStartedAt);
  }
  const duration = performance.now() - startedAt;
  await finish(rig);
  return latencyObservation(samples, duration);
}

export function memoryObservation(before: number, after: number, duration: number) {
  const delta = Math.max(0, after - before) / MEBIBYTE;
  return observation(
    duration,
    SAMPLES.transfer,
    SAMPLES.memoryWarmup,
    { memoryDelta: { value: delta, unit: 'MiB' } },
    { before, after, delta },
  );
}

/** Resident memory growth across a sustained transfer, after one identical warmup transfer. */
export async function measureMemoryPlateau(path: TransportPath): Promise<ObservedWorkload> {
  const sustained = 4 * TRANSFER_BYTES;
  await transfer(path, sustained);
  const before = process.memoryUsage().rss;
  const startedAt = performance.now();
  const run = await transfer(path, sustained);
  const duration = performance.now() - startedAt;
  // The peak is read during the run, so a heap that grew and was collected still counts.
  return memoryObservation(before, Math.max(before, run.rssPeakBytes), duration);
}

export function cleanupObservation(duration: number, extra: Record<string, unknown> = {}) {
  return observation(
    duration,
    SAMPLES.transfer,
    0,
    { cleanup: { value: duration, unit: 'milliseconds' } },
    { duration, ...extra },
  );
}

/** From the stop request until the host's cleanup result, for a real PTY child. */
export async function measureCleanup(
  path: TransportPath,
  mode: ProcessMode,
  stubborn: boolean,
): Promise<ObservedWorkload> {
  const script = stubborn ? STUBBORN_DESCENDANT : 'printf \'leader=%s \' "$$"; exec sleep 7919';
  const profile = shellProfile(script);
  // The default grace: a child that ignores TERM costs one full grace period before KILL.
  const hosted =
    mode === 'pty' && stubborn
      ? createPtyProcess({ profile, dimensions: { columns: 80, rows: 24 } })
      : hostFor(mode, profile, { terminationGraceMilliseconds: 1_000 });
  const rig = createRig(path, { profile, mode, hosted });
  await rig.client.handshake();
  const pids = pidsIn(await rig.client.waitForOutput(/leader=\d+ /));
  const startedAt = performance.now();
  rig.client.sendResult(rig.client.endpoint.terminate());
  const cleanup = await rig.client.waitForKind('cleanup-result');
  const duration = performance.now() - startedAt;
  await rig.stop();
  return cleanupObservation(duration, { outcome: cleanup.outcome, pids, stubborn });
}

/** Stop, sent while a half-budget backlog of output is unparsed and the input FIFO is full. */
export async function measureControlPath(path: TransportPath): Promise<ObservedWorkload> {
  const { scripted, rig } = await scriptedRig(path, true);
  scripted.stallWrites();
  const backlog = new Uint8Array(CHUNK_BYTES).fill(98);
  for (let index = 0; index < 8; index += 1) scripted.stream.push(backlog);
  while (rig.client.endpoint.outputBytes.received < 8 * CHUNK_BYTES) {
    await rig.client.waitForFrames(rig.client.frames.length + 1);
  }
  for (let index = 0; index < 64; index += 1) {
    const from = rig.client.messages.length;
    rig.client.sendResult(rig.client.endpoint.input(LATENCY_PAYLOAD));
    await rig.client.waitFor((message) => message.kind === 'operation-ack', from);
  }
  const startedAt = performance.now();
  rig.client.sendResult(rig.client.endpoint.terminate());
  const cleanup = await rig.client.waitForKind('cleanup-result');
  const duration = performance.now() - startedAt;
  scripted.releaseWrites();
  await rig.stop();
  return cleanupObservation(duration, { outcome: cleanup.outcome, backlogBytes: 8 * CHUNK_BYTES });
}
