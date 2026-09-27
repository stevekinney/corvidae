import { describe, expect, test } from 'bun:test';
import {
  boundedQueue,
  inputLatency,
  overflow,
  percentile,
  throughputAndQueues,
} from './resource-probe.ts';

describe('terminal resource probe primitives', () => {
  test('uses finite percentile values from sorted samples', () => {
    expect(percentile([9, 1, 4, 2], 0.5)).toBe(2);
    expect(Number.isFinite(percentile([1, 2, 3], 0.99))).toBe(true);
  });

  test('reports visible typed overflow without dropping queued operations', () => {
    const queue = boundedQueue(1);
    expect(queue.push(new Uint8Array([1]))).toEqual({ ok: true });
    expect(queue.push(new Uint8Array([2]))).toEqual({ ok: false, code: 'input-overflow' });
    expect(queue.size()).toBe(1);
    expect(overflow().passed).toBe(true);
  });

  test('returns finite unit-bearing measurements for throughput and latency', () => {
    const throughput = throughputAndQueues();
    const latency = inputLatency();
    expect(throughput.metrics['throughput']?.unit).toBe('bytes/second');
    expect(latency.metrics['p99']?.unit).toBe('milliseconds');
    expect(Number.isFinite(throughput.metrics['throughput']?.value)).toBe(true);
    expect(Number.isFinite(latency.metrics['p99']?.value)).toBe(true);
  });
});
