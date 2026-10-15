import type { ObservedWorkload } from '../../../../scripts/terminal/evidence-schema.ts';
import { SAMPLES } from './benchmark-report.ts';
import {
  cleanupObservation,
  latencyObservation,
  memoryObservation,
  throughputObservation,
} from './transport-measurements.ts';

/**
 * The control for each workload: the same measurement taken on a trivial in-memory stand-in that
 * involves no session, process or socket. It must satisfy the same comparator on any host, which
 * shows the measurement itself works before a candidate result is interpreted.
 */
const nonZero = (startedAt: number): number =>
  Math.max(performance.now() - startedAt, Number.EPSILON);

export function throughputControl(): ObservedWorkload {
  const bytes = 8 * 1024 * 1024;
  const chunk = new Uint8Array(64 * 1024);
  const queue: Uint8Array[] = [];
  let queuePeak = 0;
  const startedAt = performance.now();
  for (let offset = 0; offset < bytes; offset += chunk.byteLength) {
    queue.push(chunk);
    queuePeak = Math.max(queuePeak, queue.length);
    if (queue.length >= 4) queue.length = 0;
  }
  return throughputObservation(bytes, nonZero(startedAt), queuePeak);
}

export function latencyControl(): ObservedWorkload {
  const queue: Uint8Array[] = [];
  const samples: number[] = [];
  const startedAt = performance.now();
  for (let index = 0; index < SAMPLES.latency; index += 1) {
    const sampleStartedAt = performance.now();
    queue.push(new Uint8Array([index % 256]));
    if (queue.length > 256) queue.length = 0;
    samples.push(performance.now() - sampleStartedAt);
  }
  return latencyObservation(samples, nonZero(startedAt));
}

export function memoryControl(): ObservedWorkload {
  const startedAt = performance.now();
  const before = process.memoryUsage().rss;
  const retained = Array.from({ length: 2_000 }, (_, index) => `control-${index}`);
  const after = Math.max(before, process.memoryUsage().rss);
  retained.length = 0;
  return memoryObservation(before, after, nonZero(startedAt));
}

/** A stand-in for a stop: one awaited step, with no session, process or socket behind it. */
export async function cleanupControl(): Promise<ObservedWorkload> {
  const startedAt = performance.now();
  await Promise.resolve('complete');
  return cleanupObservation(nonZero(startedAt), 'complete', { standIn: true });
}
