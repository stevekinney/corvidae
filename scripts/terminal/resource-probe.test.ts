import { describe, expect, test } from 'bun:test';
import { validateBrowserAssetEvidence } from './engine-probe.ts';
import {
  boundedQueue,
  createCleanupQueue,
  deriveCleanupResult,
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

  test('keeps user and reserved control capacity independent', () => {
    const queue = createCleanupQueue(2, 1);
    expect(queue.enqueueUser()).toBe(true);
    expect(queue.enqueueUser()).toBe(true);
    expect(queue.enqueueUser()).toBe(false);
    expect(queue.reserveControl()).toBe(true);
    expect(queue.reserveControl()).toBe(false);
  });

  test('derives one cleanup state and enforces quarantine for uncertainty', () => {
    const complete = deriveCleanupResult({
      authorityRevoked: true,
      controlCapacityReserved: true,
      userQueueCanceled: true,
      processGroupSignaled: true,
      parentExited: true,
      descendantObservedGone: true,
      handlesClosed: true,
    });
    expect(complete.state).toBe('complete');
    expect(complete.quarantined).toBe(false);
    const unknown = deriveCleanupResult({
      authorityRevoked: true,
      controlCapacityReserved: true,
      userQueueCanceled: true,
      processGroupSignaled: false,
      parentExited: false,
      descendantObservedGone: undefined,
      handlesClosed: false,
    });
    expect(unknown.state).toBe('unknown');
    expect(unknown.quarantined).toBe(true);
  });

  test('accepts only the exact local xterm asset tuple and CSP', () => {
    const valid = {
      origin: 'http://127.0.0.1:1234',
      csp: "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; script-src 'self'; connect-src 'self'",
      requests: [
        { method: 'GET', url: 'http://127.0.0.1:1234/', path: '/' },
        { method: 'GET', url: 'http://127.0.0.1:1234/candidate.css', path: '/candidate.css' },
        { method: 'GET', url: 'http://127.0.0.1:1234/probe.js', path: '/probe.js' },
      ],
      responses: [
        { url: 'http://127.0.0.1:1234/', status: 200, contentType: 'text/html' },
        { url: 'http://127.0.0.1:1234/candidate.css', status: 200, contentType: 'text/css' },
        { url: 'http://127.0.0.1:1234/probe.js', status: 200, contentType: 'text/javascript' },
      ],
      failures: [],
    };
    expect(validateBrowserAssetEvidence(valid)).toBe(true);
    expect(
      validateBrowserAssetEvidence({
        ...valid,
        requests: [
          ...valid.requests,
          { method: 'GET', url: 'https://cdn.example/x.js', path: '/x.js' },
        ],
      }),
    ).toBe(false);
    expect(
      validateBrowserAssetEvidence({
        ...valid,
        responses: [{ ...valid.responses[1]!, status: 404 }],
      }),
    ).toBe(false);
    expect(
      validateBrowserAssetEvidence({
        ...valid,
        responses: [{ ...valid.responses[1]!, contentType: 'text/html' }],
      }),
    ).toBe(false);
    expect(validateBrowserAssetEvidence({ ...valid, csp: 'default-src *' })).toBe(false);
  });
});
