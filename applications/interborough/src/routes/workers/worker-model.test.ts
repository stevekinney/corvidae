import { describe, expect, test } from 'bun:test';

import type { WorkerSummary } from './worker-catalog-types.ts';
import {
  drainSuccessor,
  heardAgoPhrase,
  humanizeWorkerId,
  lastHeardPhrase,
  matchesWorkerFilter,
  orderWorkers,
  queueHasNoRunner,
  truncateMiddle,
  workerName,
  workerRowMeta,
  workerRowTime,
  workerRowTitle,
  workerStatusLine,
  workerStatusOf,
} from './worker-model.ts';

function worker(overrides: Partial<WorkerSummary> = {}): WorkerSummary {
  return {
    id: 'payments-worker-1',
    transport: 'websocket',
    queue: 'payments',
    activities: [],
    concurrency: 4,
    inFlight: 3,
    availableCapacity: 1,
    connectedAt: 0,
    lastHeartbeatAt: 1_000,
    startedAt: 0,
    heartbeatAgeMs: 0,
    capabilities: {},
    health: 'active',
    ...overrides,
  };
}

describe('workerStatusOf', () => {
  test('a worker that takes work is Connected, and one finishing its tasks is Draining', () => {
    expect(workerStatusOf(worker())).toBe('Connected');
    expect(workerStatusOf(worker({ health: 'draining' }))).toBe('Draining');
  });

  test('a worker that went away is Disconnected', () => {
    expect(workerStatusOf(worker({ disconnectedAt: 5 }))).toBe('Disconnected');
  });

  test('a worker that finished draining is Stopped, connected or not, never Disconnected', () => {
    expect(workerStatusOf(worker({ health: 'drained', inFlight: 0 }))).toBe('Stopped');
    expect(workerStatusOf(worker({ health: 'drained', inFlight: 0, disconnectedAt: 5 }))).toBe(
      'Stopped',
    );
  });
});

describe('names', () => {
  test('a worker is named by what it advertised, or by its id as a sentence', () => {
    expect(workerName(worker({ name: 'Payments worker EU' }))).toBe('Payments worker EU');
    expect(workerName(worker({ id: 'reports-worker' }))).toBe('Reports worker');
    expect(humanizeWorkerId('search_worker.2')).toBe('Search worker 2');
  });

  test('a row cuts a long id from the middle, so its end still tells workers apart', () => {
    const id = 'payments-worker-eu-west-1b-7f3a9c2e-4d81-4b06-a9e2-1c5d0f7b3a68';
    expect(workerRowTitle(worker({ id, name: 'Payments worker EU' }))).toBe(
      'payments-worker-eu-w…3a68',
    );
    expect(workerRowTitle(worker({ id: 'reports-worker' }))).toBe('Reports worker');
    expect(truncateMiddle('short')).toBe('short');
  });
});

describe('a row', () => {
  test('line two says what each state needs said', () => {
    expect(workerRowMeta(worker())).toBe('payments, 3 running');
    expect(workerRowMeta(worker({ queue: 'reports', disconnectedAt: 1, inFlight: 0 }))).toBe(
      'reports queue',
    );
    expect(workerRowMeta(worker({ health: 'draining', inFlight: 2 }))).toBe(
      'Finishing 2 tasks, then stops',
    );
    expect(workerRowMeta(worker({ health: 'draining', inFlight: 1 }))).toBe(
      'Finishing 1 task, then stops',
    );
    expect(workerRowMeta(worker({ health: 'drained', inFlight: 0, drainFinishedTasks: 2 }))).toBe(
      'Drained, finished its 2 tasks',
    );
  });

  test('its time is when the worker was last heard from, or finished draining', () => {
    expect(workerRowTime(worker({ lastHeartbeatAt: 10 }))).toBe(10);
    expect(workerRowTime(worker({ health: 'drained', drainedAt: 50, lastHeartbeatAt: 10 }))).toBe(
      50,
    );
  });
});

describe('when a worker was last heard from', () => {
  test('reads in words from just now to days', () => {
    expect(heardAgoPhrase(2_000)).toBe('just now');
    expect(heardAgoPhrase(40_000)).toBe('40 seconds ago');
    expect(heardAgoPhrase(60_000)).toBe('a minute ago');
    expect(heardAgoPhrase(5 * 60_000)).toBe('5 minutes ago');
    expect(heardAgoPhrase(3_600_000)).toBe('an hour ago');
    expect(heardAgoPhrase(3 * 3_600_000)).toBe('3 hours ago');
    expect(heardAgoPhrase(86_400_000)).toBe('a day ago');
    expect(heardAgoPhrase(3 * 86_400_000)).toBe('3 days ago');
  });

  test('adds the clock once it has been a minute', () => {
    const at = Date.UTC(2026, 10, 2, 15, 41);
    expect(lastHeardPhrase(at, at + 3_000)).toBe('just now');
    expect(lastHeardPhrase(at, at + 3_600_000)).toMatch(/^an hour ago, at \d{1,2}:41 [AP]M$/u);
  });

  test('the status line says what a draining or stopped worker is doing instead', () => {
    expect(workerStatusLine(worker({ lastHeartbeatAt: 1_000 }), 3_000)).toBe(
      'Last heard from just now',
    );
    expect(workerStatusLine(worker({ health: 'draining', inFlight: 2 }), 0)).toBe(
      'Finishing 2 tasks, then it stops.',
    );
    expect(
      workerStatusLine(worker({ health: 'drained', inFlight: 0, drainFinishedTasks: 2 }), 0),
    ).toBe('It finished its 2 tasks and stopped. Nothing is waiting on it.');
  });
});

describe('the list', () => {
  const reports = worker({ id: 'reports-worker', queue: 'reports', disconnectedAt: 1 });
  const one = worker({ id: 'payments-worker-1', name: 'Payments worker 1' });
  const two = worker({ id: 'payments-worker-2', name: 'Payments worker 2' });
  const search = worker({ id: 'search-worker', queue: 'search', health: 'draining' });
  const stopped = worker({ id: 'old-worker', health: 'drained', inFlight: 0 });

  test('puts the worker that went away first, then those taking work, then the stopped, by name', () => {
    expect(orderWorkers([stopped, search, two, one, reports]).map((entry) => entry.id)).toEqual([
      'reports-worker',
      'payments-worker-1',
      'payments-worker-2',
      'search-worker',
      'old-worker',
    ]);
  });

  test('filters by name, id or queue, ignoring case and spaces around it', () => {
    expect(matchesWorkerFilter(one, ' PAYMENTS ')).toBe(true);
    expect(matchesWorkerFilter(one, 'worker-1')).toBe(true);
    expect(matchesWorkerFilter(search, 'search')).toBe(true);
    expect(matchesWorkerFilter(one, 'billing')).toBe(false);
    expect(matchesWorkerFilter(one, '   ')).toBe(true);
  });

  test('names who takes a drained worker’s new tasks', () => {
    expect(drainSuccessor([one, two, reports], one)).toBe('Payments worker 2');
    expect(drainSuccessor([one, reports], one)).toBeNull();
    expect(drainSuccessor([one, two, worker({ id: 'payments-worker-3' })], one)).toBe(
      'the other payments workers',
    );
  });

  test('a queue has no runner when no other worker on it still takes work', () => {
    expect(queueHasNoRunner([reports, one], reports)).toBe(true);
    expect(queueHasNoRunner([reports, worker({ queue: 'reports' })], reports)).toBe(false);
    expect(
      queueHasNoRunner([reports, worker({ queue: 'reports', disconnectedAt: 2 })], reports),
    ).toBe(true);
  });
});
