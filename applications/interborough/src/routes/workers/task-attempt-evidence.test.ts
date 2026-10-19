import { describe, expect, test } from 'bun:test';
import { pathToFileURL } from 'node:url';

import {
  buildAttemptHistory,
  buildLeaseClocks,
  describeCancellation,
  describeIdentityChange,
  exactTimestamp,
  GRACE_PERIOD_SETTLEMENT_REASON,
  isTaskAttemptList,
  isTaskAttemptRecord,
  orderAttempts,
  owningAttempt,
} from './task-attempt-evidence.ts';
import type { TaskAttemptRecord, TaskLedgerDetail } from './worker-catalog-types.ts';

const NOW = 1_700_000_000_000;

const EXECUTION_IDENTITY = {
  workerId: 'worker-a',
  manifestDigest: 'sha256:manifest',
  sdkVersion: '1.0.0',
  runtimeName: 'bun',
  runtimeVersion: '1.3.0',
  deploymentName: 'payments',
  buildId: 'build-42',
  artifactDigest: 'sha256:artifact',
  workflowType: 'orders',
  workflowRevision: 'rev-7',
  activityName: 'charge',
  activityContractHash: 'sha256:contract',
  protocolVersion: 1,
} as const;

function attempt(overrides: Partial<TaskAttemptRecord> = {}): TaskAttemptRecord {
  return {
    attempt: 1,
    attemptTokenDigest: 'sha256:token',
    claimedAt: NOW - 60_000,
    disposition: 'requeued',
    dispositionAt: NOW - 50_000,
    ...overrides,
  };
}

function task(overrides: Partial<TaskLedgerDetail> = {}): TaskLedgerDetail {
  return {
    state: 'leased',
    operationId: 'op_1',
    workflowType: 'orders',
    activityName: 'charge',
    queue: 'payments',
    headerKeys: [],
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: NOW - 120_000,
    attempt: 2,
    attempts: [],
    ...overrides,
  };
}

describe('attempt record validation', () => {
  test('accepts a complete record with optional evidence', () => {
    expect(
      isTaskAttemptRecord(
        attempt({ dispositionReason: 'expired', lastHeartbeatAt: NOW, sessionGeneration: 2 }),
      ),
    ).toBe(true);
  });

  test('rejects records with malformed optional evidence', () => {
    expect(isTaskAttemptRecord({ ...attempt(), dispositionReason: 7 })).toBe(false);
    expect(isTaskAttemptRecord({ ...attempt(), lastHeartbeatAt: Number.NaN })).toBe(false);
    expect(isTaskAttemptRecord({ ...attempt(), executionIdentity: 'worker-a' })).toBe(false);
  });

  test('accepts an attempt whose execution identity has its full published shape', () => {
    expect(isTaskAttemptRecord({ ...attempt(), executionIdentity: EXECUTION_IDENTITY })).toBe(true);
  });

  test('rejects an execution identity that drifts from its published shape', () => {
    const drifted = [
      {},
      { ...EXECUTION_IDENTITY, workerId: 7 },
      { ...EXECUTION_IDENTITY, buildId: undefined },
      { ...EXECUTION_IDENTITY, protocolVersion: '1' },
    ];
    for (const executionIdentity of drifted) {
      expect(isTaskAttemptRecord({ ...attempt(), executionIdentity })).toBe(false);
    }
    expect(isTaskAttemptRecord(null)).toBe(false);
    expect(isTaskAttemptList({})).toBe(false);
    expect(isTaskAttemptList([attempt(), { attempt: 2 }])).toBe(false);
  });
});

describe('attempt ordering and fencing', () => {
  test('orders by attempt, then claim time, without mutating the input', () => {
    const input = [
      attempt({ attempt: 2, claimedAt: NOW - 10_000 }),
      attempt({ attempt: 1, claimedAt: NOW - 5_000 }),
      attempt({ attempt: 1, claimedAt: NOW - 20_000 }),
    ];
    expect(orderAttempts(input).map((record) => [record.attempt, record.claimedAt])).toEqual([
      [1, NOW - 20_000],
      [1, NOW - 5_000],
      [2, NOW - 10_000],
    ]);
    expect(input[0]?.attempt).toBe(2);
  });

  test("closes a superseded attempt's window at the next claim even when it never recorded a disposition", () => {
    const history = buildAttemptHistory(
      [
        attempt({ attempt: 1, disposition: 'leased', dispositionAt: NOW - 60_000 }),
        attempt({ attempt: 2, claimedAt: NOW - 30_000, disposition: 'leased' }),
      ],
      2,
    );
    expect(history[0]?.windowEnd).toBe(NOW - 30_000);
    expect(history[0]?.dispositionFenced).toBe(false);
    expect(history[0]?.owning).toBe(false);
    expect(history[1]?.windowEnd).toBeUndefined();
    expect(history[1]?.owning).toBe(true);
  });

  test('ends a window at its own disposition when that precedes the next claim', () => {
    const history = buildAttemptHistory(
      [
        attempt({ attempt: 1, dispositionAt: NOW - 55_000 }),
        attempt({
          attempt: 2,
          claimedAt: NOW - 30_000,
          disposition: 'resolved',
          dispositionAt: NOW - 1_000,
        }),
      ],
      2,
    );
    expect(history[0]?.windowEnd).toBe(NOW - 55_000);
    expect(history[1]?.windowEnd).toBe(NOW - 1_000);
    expect(history.map((entry) => entry.dispositionLabel)).toEqual(['Requeued', 'Resolved']);
  });

  test('never ends a window before it starts when a lower attempt was claimed after the next one', () => {
    // Attempt 1's claim is later than attempt 2's (clock skew between servers,
    // or a recovered record): the next claim must not pull attempt 1's window
    // end before its own start.
    const history = buildAttemptHistory(
      [
        attempt({ attempt: 1, claimedAt: NOW - 5_000, disposition: 'leased' }),
        attempt({ attempt: 2, claimedAt: NOW - 20_000, disposition: 'leased' }),
      ],
      2,
    );
    expect(history.map((entry) => entry.record.attempt)).toEqual([1, 2]);
    expect(history[0]?.windowStart).toBe(NOW - 5_000);
    expect(history[0]?.windowEnd).toBe(NOW - 5_000);
    for (const entry of history) {
      if (entry.windowEnd !== undefined) {
        expect(entry.windowEnd).toBeGreaterThanOrEqual(entry.windowStart);
      }
    }
  });

  test('never ends a window before it starts when its own disposition predates its claim', () => {
    const [entry] = buildAttemptHistory(
      [attempt({ attempt: 1, claimedAt: NOW - 5_000, dispositionAt: NOW - 9_000 })],
      1,
    );
    expect(entry?.windowEnd).toBe(NOW - 5_000);
  });

  test('has no owning attempt until the ledger records the current attempt number', () => {
    expect(owningAttempt(task({ attempts: [attempt({ attempt: 1 })] }))).toBeUndefined();
  });
});

describe('exactTimestamp', () => {
  test('formats a representable instant as ISO 8601', () => {
    expect(exactTimestamp(NOW)).toBe(new Date(NOW).toISOString());
  });

  test('names an unrepresentable instant instead of throwing a RangeError', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 1e20, 'bad' as unknown as number]) {
      expect(exactTimestamp(value)).toBe('Invalid timestamp');
    }
  });
});

describe('cancellation evidence', () => {
  test('without a request and without an owning cancellation there is nothing to acknowledge', () => {
    const evidence = describeCancellation(task());
    expect(evidence.status).toBe('not-requested');
    expect(evidence.acknowledgement).toBe('No cancellation to acknowledge');
  });

  test('an owning cancelled attempt is acknowledgement even before the task leaves leased', () => {
    const evidence = describeCancellation(
      task({ attempts: [attempt({ attempt: 2, disposition: 'cancelled', dispositionAt: NOW })] }),
    );
    expect(evidence.status).toBe('acknowledged');
    expect(evidence.acknowledgement).toBe(
      `Acknowledged by attempt 2 at ${new Date(NOW).toISOString()}`,
    );
  });

  test('a grace-period force settlement of the owning attempt is not acknowledgement', () => {
    const evidence = describeCancellation(
      task({
        state: 'terminal',
        disposition: 'cancelled',
        cancellationReason: 'stop',
        attempts: [
          attempt({
            attempt: 2,
            disposition: 'cancelled',
            dispositionAt: NOW,
            dispositionReason: GRACE_PERIOD_SETTLEMENT_REASON,
          }),
        ],
      }),
    );
    expect(evidence.status).toBe('settled-after-grace-period');
    expect(evidence.statusLabel).toBe('Settled after grace period · no worker acknowledgement');
    expect(evidence.variant).toBe('warning');
    expect(evidence.acknowledgement).toBe(
      `Not acknowledged · Weft settled attempt 2 at ${new Date(NOW).toISOString()} after the cancellation grace period elapsed`,
    );
  });

  test("matches the reason Weft's reconciliation records when it force-settles a cancellation", async () => {
    const weftEntry = Bun.resolveSync('@lostgradient/weft', import.meta.dir);
    const reconciliation = await Bun.file(
      new URL('./server/runtime/task-reconciliation.ts', pathToFileURL(weftEntry)),
    ).text();
    const sites = reconciliation.split(`dispositionReason: '${GRACE_PERIOD_SETTLEMENT_REASON}'`);
    expect(sites.length - 1).toBeGreaterThan(0);
  });

  test('a requested cancellation with no record for the current attempt waits for one', () => {
    const evidence = describeCancellation(
      task({ state: 'cancelling', cancellationReason: 'stop', cancellationRequestedAt: NOW }),
    );
    expect(evidence.status).toBe('requested');
    expect(evidence.acknowledgement).toBe('No record for attempt 2 yet');
  });
});

describe('lease clocks', () => {
  test('reports a deadline equal to now as expired', () => {
    const clocks = buildLeaseClocks(task({ leaseDeadline: NOW }), NOW);
    expect(clocks.map((clock) => [clock.id, clock.state])).toEqual([
      ['session-lease', 'expired'],
      ['attempt-lease', 'not-set'],
      ['execution-deadline', 'not-set'],
    ]);
  });

  test('settles every clock once the task is dead-lettered', () => {
    const clocks = buildLeaseClocks(
      task({ state: 'deadLettered', leaseDeadline: NOW + 1_000, attemptDeadline: NOW - 1 }),
      NOW,
    );
    expect(clocks.every((clock) => clock.state === 'settled')).toBe(true);
  });
});

describe('attempt routing requirement validation', () => {
  test('accepts a per-attempt routing requirement and rejects a malformed one', () => {
    expect(
      isTaskAttemptRecord({
        ...attempt(),
        executionRequirement: { deploymentName: 'payments', buildId: 'build-42' },
      }),
    ).toBe(true);
    expect(isTaskAttemptRecord({ ...attempt(), executionRequirement: 'payments' })).toBe(false);
    expect(isTaskAttemptRecord({ ...attempt(), executionRequirement: { buildId: 7 } })).toBe(false);
  });
});

describe('cross-build retry detection', () => {
  const first = attempt({ attempt: 1, executionIdentity: EXECUTION_IDENTITY });

  test('flags a retry that moved to another deployment, build, or artifact digest', () => {
    const moved = attempt({
      attempt: 2,
      claimedAt: NOW - 30_000,
      executionIdentity: {
        ...EXECUTION_IDENTITY,
        deploymentName: 'payments-eu',
        buildId: 'build-43',
        artifactDigest: 'sha256:artifact-2',
      },
    });
    const change = describeIdentityChange(first, moved);
    expect(change?.fields).toEqual(['deploymentName', 'buildId', 'artifactDigest']);
    expect(change?.previousAttempt).toBe(1);
    expect(change?.summary).toBe(
      'deployment payments → payments-eu; build build-42 → build-43; artifact digest sha256:artifact → sha256:artifact-2',
    );
  });

  test.each(['deploymentName', 'buildId', 'artifactDigest'] as const)(
    'flags a change in %s alone',
    (field) => {
      const next = attempt({
        attempt: 2,
        executionIdentity: { ...EXECUTION_IDENTITY, [field]: 'changed' },
      });
      expect(describeIdentityChange(first, next)?.fields).toEqual([field]);
    },
  );

  test('does not flag a different worker on the same build', () => {
    const next = attempt({
      attempt: 2,
      executionIdentity: { ...EXECUTION_IDENTITY, workerId: 'worker-b' },
    });
    expect(describeIdentityChange(first, next)).toBeUndefined();
  });

  test('does not flag when either attempt recorded no identity', () => {
    expect(describeIdentityChange(first, attempt({ attempt: 2 }))).toBeUndefined();
    expect(describeIdentityChange(attempt({ attempt: 1 }), first)).toBeUndefined();
  });

  test('buildAttemptHistory compares each attempt with the nearest earlier recorded identity', () => {
    const history = buildAttemptHistory(
      [
        first,
        attempt({ attempt: 2, claimedAt: NOW - 50_000 }),
        attempt({
          attempt: 3,
          claimedAt: NOW - 40_000,
          executionIdentity: { ...EXECUTION_IDENTITY, buildId: 'build-43' },
        }),
      ],
      3,
    );
    expect(history[0]?.identityChange).toBeUndefined();
    expect(history[1]?.identityChange).toBeUndefined();
    expect(history[2]?.identityChange?.previousAttempt).toBe(1);
    expect(history[2]?.identityChange?.fields).toEqual(['buildId']);
  });
});
