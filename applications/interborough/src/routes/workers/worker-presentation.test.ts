import { describe, expect, test } from 'bun:test';

import type { WorkerSummary } from './worker-catalog-types.ts';
import {
  countByTransport,
  HEARTBEAT_ELEVATED_AFTER_MS,
  HEARTBEAT_STALE_AFTER_MS,
  heartbeatSeverity,
  queueBacklogVariant,
  TRANSPORT_LABEL,
  workerHealthPresentation,
  workersSummaryLine,
} from './worker-presentation.ts';

function worker(overrides: Partial<WorkerSummary> = {}): WorkerSummary {
  return {
    id: 'wkr_1',
    transport: 'websocket',
    queue: 'default',
    activities: ['Workflow.activity'],
    concurrency: 4,
    inFlight: 1,
    availableCapacity: 3,
    connectedAt: 0,
    lastHeartbeatAt: 0,
    startedAt: 0,
    heartbeatAgeMs: 1_000,
    capabilities: {},
    health: 'active',
    ...overrides,
  };
}

describe('heartbeatSeverity', () => {
  test('fresh below the elevated threshold', () => {
    expect(heartbeatSeverity(HEARTBEAT_ELEVATED_AFTER_MS - 1)).toBe('fresh');
  });

  test('elevated at/above the elevated threshold, below stale', () => {
    expect(heartbeatSeverity(HEARTBEAT_ELEVATED_AFTER_MS)).toBe('elevated');
    expect(heartbeatSeverity(HEARTBEAT_STALE_AFTER_MS - 1)).toBe('elevated');
  });

  test('stale at/above the stale threshold', () => {
    expect(heartbeatSeverity(HEARTBEAT_STALE_AFTER_MS)).toBe('stale');
  });
});

describe('workerHealthPresentation — priority order', () => {
  test('draining wins even with a fresh heartbeat', () => {
    expect(workerHealthPresentation(worker({ health: 'draining', heartbeatAgeMs: 500 }))).toEqual({
      label: 'Draining',
      variant: 'warning',
    });
  });

  test('draining wins even with a stale heartbeat (design mock: 1m12s draining worker)', () => {
    expect(
      workerHealthPresentation(worker({ health: 'draining', heartbeatAgeMs: 72_000 })),
    ).toEqual({ label: 'Draining', variant: 'warning' });
  });

  test('drained wins over heartbeat state', () => {
    expect(
      workerHealthPresentation(
        worker({ health: 'drained', heartbeatAgeMs: HEARTBEAT_STALE_AFTER_MS }),
      ),
    ).toEqual({ label: 'Drained', variant: 'neutral' });
  });

  test('active + stale heartbeat renders Stale', () => {
    expect(
      workerHealthPresentation(
        worker({ health: 'active', heartbeatAgeMs: HEARTBEAT_STALE_AFTER_MS }),
      ),
    ).toEqual({ label: 'Stale', variant: 'danger' });
  });

  test('active + fresh/elevated heartbeat renders Healthy', () => {
    expect(workerHealthPresentation(worker({ health: 'active', heartbeatAgeMs: 4_000 }))).toEqual({
      label: 'Healthy',
      variant: 'success',
    });
    expect(
      workerHealthPresentation(
        worker({ health: 'active', heartbeatAgeMs: HEARTBEAT_ELEVATED_AFTER_MS }),
      ),
    ).toEqual({ label: 'Healthy', variant: 'success' });
  });
});

describe('workersSummaryLine', () => {
  test('an empty fleet reads zero of zero, with nothing running', () => {
    expect(workersSummaryLine({ workers: [] })).toBe('0 of 0 connected · 0 running');
  });

  test('counts every listed worker as connected, the tasks they hold, and the queue and dead-letter figures', () => {
    const workers = [
      worker({ health: 'active', inFlight: 3 }),
      worker({ health: 'draining', inFlight: 4 }),
      worker({ health: 'active', inFlight: 0 }),
      worker({ health: 'drained', inFlight: 0 }),
    ];
    expect(workersSummaryLine({ workers, waiting: 12, failedForGood: 2 })).toBe(
      '4 of 4 connected · 7 running · 12 waiting · 2 failed for good',
    );
  });

  test('counts a drained worker as connected, since it stays registered until it disconnects', () => {
    const workers = [worker({ health: 'drained', inFlight: 0 })];
    expect(workersSummaryLine({ workers })).toBe('1 of 1 connected · 0 running');
  });

  test('leaves out a figure that could not be read instead of reporting zero', () => {
    const workers = [worker({ inFlight: 2 })];
    expect(workersSummaryLine({ workers, failedForGood: 1 })).toBe(
      '1 of 1 connected · 2 running · 1 failed for good',
    );
    expect(workersSummaryLine({ workers, waiting: 0 })).toBe(
      '1 of 1 connected · 2 running · 0 waiting',
    );
  });
});

describe('queueBacklogVariant', () => {
  test('zero is neutral, some backlog is warning, over 50 is danger', () => {
    expect(queueBacklogVariant(0)).toBe('neutral');
    expect(queueBacklogVariant(1)).toBe('warning');
    expect(queueBacklogVariant(50)).toBe('warning');
    expect(queueBacklogVariant(51)).toBe('danger');
  });
});

describe('transport presentation (COR-160)', () => {
  test('counts workers per transport and spells each transport out', () => {
    expect(
      countByTransport([
        worker({ transport: 'websocket' }),
        worker({ transport: 'long-poll' }),
        worker({ transport: 'long-poll' }),
      ]),
    ).toEqual({ websocket: 1, 'long-poll': 2 });
    expect(countByTransport([])).toEqual({ websocket: 0, 'long-poll': 0 });
    expect(TRANSPORT_LABEL['long-poll']).toBe('HTTP long-poll');
  });
});
