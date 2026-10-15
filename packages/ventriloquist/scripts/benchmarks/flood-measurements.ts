import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ObservedWorkload } from '../../../../scripts/terminal/evidence-schema.ts';
import { hostFor } from '../../src/bun/bun-process.test-support.ts';
import { ENDLESS_OUTPUT, outputProfile } from '../../src/bun/fixtures/terminal-output.ts';
import {
  createRig,
  type ProcessMode,
  type Rig,
  type TransportPath,
} from '../../src/conformance/conformance.test-support.ts';
import { DEFAULT_SESSION_BUDGETS } from '../../src/session/session-types.ts';
import { hostConditions } from './benchmark-report.ts';
import {
  latencyObservation,
  memoryObservation,
  throughputObservation,
} from './transport-measurements.ts';

const MEBIBYTE = 1024 * 1024;
const BUDGET = DEFAULT_SESSION_BUDGETS.outputQueueBytes;
/** The producer fills at least this much of the budget before it is called paused. */
const FULL_ENOUGH = BUDGET - 128 * 1024;
const FLOOD_BYTES = 16 * MEBIBYTE;
/** Stall and release cycles timed for the resume latency. */
export const RESUME_SAMPLES = 50;
const CHUNK_BYTES = 64 * 1024;

/** Forget the frames the client has handled, so megabytes of output measure the host and not the client's retention. */
function discardHandled(rig: Rig): void {
  rig.client.frames.splice(0);
  rig.client.messages.splice(0);
}

async function untilReceived(rig: Rig, count: number): Promise<void> {
  while (rig.client.endpoint.outputBytes.received < count) {
    await rig.client.waitForFrames(rig.client.frames.length + 1);
  }
}

/** Wait until nothing has arrived for four intervals in a row. */
async function untilQuiet(rig: Rig): Promise<number> {
  let last = -1;
  for (let quiet = 0; quiet < 4;) {
    await Bun.sleep(50);
    const now = rig.client.endpoint.outputBytes.received;
    quiet = now === last ? quiet + 1 : 0;
    last = now;
  }
  return last;
}

async function finish(rig: Rig): Promise<void> {
  rig.client.sendResult(rig.client.endpoint.terminate());
  await rig.client.waitForKind('cleanup-result');
  await rig.stop();
}

/**
 * A real process flooding `cat` of a sixteen mebibyte file through the host while the client parses
 * each chunk as it arrives, from the first byte until the last one is parsed.
 */
export async function measureFloodThroughput(
  path: TransportPath,
  mode: ProcessMode,
): Promise<ObservedWorkload> {
  const directory = mkdtempSync(join(tmpdir(), 'ventriloquist-flood-'));
  try {
    const file = join(directory, 'flood.bin');
    writeFileSync(file, new Uint8Array(FLOOD_BYTES).fill(97));
    const profile = outputProfile(mode, `cat '${file}'`);
    const rig = createRig(path, { profile, mode, hosted: hostFor(mode, profile) });
    let queuePeak = 0;
    const startedAt = performance.now();
    await rig.client.handshake();
    while (rig.client.endpoint.outputBytes.consumed < FLOOD_BYTES) {
      const { received, consumed } = rig.client.endpoint.outputBytes;
      queuePeak = Math.max(queuePeak, Math.ceil((received - consumed) / CHUNK_BYTES));
      discardHandled(rig);
      await rig.client.waitForFrames(rig.client.frames.length + 1);
    }
    const duration = performance.now() - startedAt;
    discardHandled(rig);
    await finish(rig);
    return throughputObservation(FLOOD_BYTES, duration, queuePeak);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** A producer that never stops, held back by a client that parses nothing until it is told to. */
async function stalledFlood(path: TransportPath, mode: ProcessMode): Promise<Rig> {
  const profile = outputProfile(mode, ENDLESS_OUTPUT);
  const rig = createRig(path, { profile, mode, hosted: hostFor(mode, profile) });
  rig.pauseConsuming();
  await rig.client.handshake();
  await untilReceived(rig, FULL_ENOUGH);
  await untilQuiet(rig);
  discardHandled(rig);
  return rig;
}

/**
 * From the client reporting what it holds parsed until the first new byte of output reaches it,
 * fifty times over, with the producer blocked by a full budget before each one.
 */
export async function measureResumeLatency(
  path: TransportPath,
  mode: ProcessMode,
): Promise<ObservedWorkload> {
  const rig = await stalledFlood(path, mode);
  const samples: number[] = [];
  const startedAt = performance.now();
  for (let sample = 0; sample < RESUME_SAMPLES; sample += 1) {
    const { received } = rig.client.endpoint.outputBytes;
    const sampleStartedAt = performance.now();
    rig.resumeConsuming();
    while (rig.client.endpoint.outputBytes.received <= received) {
      await rig.client.waitForFrames(rig.client.frames.length + 1);
    }
    samples.push(performance.now() - sampleStartedAt);
    rig.pauseConsuming();
    await untilQuiet(rig);
    discardHandled(rig);
  }
  const duration = performance.now() - startedAt;
  await finish(rig);
  return latencyObservation(samples, duration);
}

/** The same fifty samples taken on an in-memory stand-in, which must meet the same target on any host. */
export function resumeLatencyControl(): ObservedWorkload {
  const samples: number[] = [];
  const startedAt = performance.now();
  for (let sample = 0; sample < RESUME_SAMPLES; sample += 1) {
    const sampleStartedAt = performance.now();
    void new Uint8Array([sample]);
    samples.push(performance.now() - sampleStartedAt);
  }
  return latencyObservation(samples, Math.max(performance.now() - startedAt, Number.EPSILON));
}

/** One stall: how much the host held and how far its resident memory moved while the producer stayed blocked. */
async function stall(path: TransportPath, mode: ProcessMode) {
  const rssBefore = process.memoryUsage().rss;
  const rig = await stalledFlood(path, mode);
  const held = rig.client.endpoint.outputBytes.received;
  let rssPeak = process.memoryUsage().rss;
  for (let second = 0; second < 6; second += 1) {
    await Bun.sleep(500);
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  }
  const stillHeld = rig.client.endpoint.outputBytes.received;
  await finish(rig);
  return { rssBefore, rssPeak, held, grewWhilePaused: stillHeld - held };
}

/**
 * Resident memory growth across three seconds of a producer that is paused with a full budget,
 * after one identical warmup stall.
 */
export async function measurePausedMemory(
  path: TransportPath,
  mode: ProcessMode,
): Promise<ObservedWorkload> {
  await stall(path, mode);
  const startedAt = performance.now();
  const run = await stall(path, mode);
  const observed = memoryObservation(
    run.rssBefore,
    Math.max(run.rssBefore, run.rssPeak),
    performance.now() - startedAt,
  );
  return {
    ...observed,
    raw: {
      ...observed.raw,
      heldBytes: run.held,
      grewWhilePausedBytes: run.grewWhilePaused,
      host: hostConditions(),
    },
  };
}
