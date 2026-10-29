/**
 * COR-424 — the command ledger's retention window. A binding is held for
 * `terminalRetentionMs` (24 hours by default, matching Weft's mailbox) after
 * its command settles; once that window has passed, a query reports the
 * binding `expired` and the same request id admits a new command. Time is the
 * injected runtime clock, moved with `setTime`, so nothing here reads the wall
 * clock.
 */
import { createManualRuntimeServices, type ManualRuntimeServices } from '@lostgradient/lifecycle';
import { type ConditionalTextValueStore, textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import {
  type BeginRunCreationInput,
  BureauLedgerConflictError,
  COMMAND_LEDGER_DEFAULT_TERMINAL_RETENTION_MS,
  type CommandLedgerEntry,
  type CommandLedgerIdentity,
  createCommandLedger,
  createRunCreationLedger,
  RUN_CREATION_OPERATION_VERSION,
  type RunCreationClaim,
  type RunCreationObservation,
  type RunCreationReceipt,
  type RunCreationReceiptLocation,
} from './command-ledger';
import { createMemoryStorageFixture } from './test/storage-fixtures';
import { rejectionOf, throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import type { RunSummary } from './types';

const ORIGIN = '2026-10-13T00:00:00.000Z';
const ORIGIN_MS = Date.parse(ORIGIN);
const DAY_MS = 86_400_000;

interface TestClaim {
  readonly runId: string;
}

interface TestResult {
  readonly status: string;
}

const IDENTITY: CommandLedgerIdentity = {
  callerId: 'alice',
  target: 'bureau',
  requestId: 'request-1',
  operationVersion: RUN_CREATION_OPERATION_VERSION,
};

interface LedgerOptions {
  readonly terminalRetentionMs?: number;
  readonly retentionStart?: (
    entry: CommandLedgerEntry<TestClaim, TestResult>,
  ) => Promise<number | undefined>;
}

function memoryLedger(options: LedgerOptions = {}) {
  const fixture = createMemoryStorageFixture();
  const kv = textValueStore(fixture.storage, { disposeUnderlyingStorage: false });
  const runtime = createManualRuntimeServices({ origin: ORIGIN });
  const ledger = createCommandLedger<TestClaim, TestResult>({
    kv,
    clock: runtime.clock,
    nextConflictId: () => runtime.identifiers.next('ledger-conflict'),
    ...options,
  });
  return { fixture, kv, runtime, ledger };
}

/** Claims and completes `IDENTITY` with `digest`, returning the completed entry. */
async function completedBinding(
  ledger: ReturnType<typeof memoryLedger>['ledger'],
  digest = 'digest-a',
  runId = 'run-1',
) {
  const claimed = await ledger.claim(IDENTITY, digest, { runId });
  if (claimed.outcome !== 'claimed') throw new Error('expected a fresh claim');
  return ledger.complete(claimed.entry, { status: 'running' });
}

async function keys(kv: ConditionalTextValueStore): Promise<string[]> {
  const listed = await kv.list('');
  return listed.toSorted();
}

describe('command ledger retention', () => {
  it('defaults the window to 24 hours, the same as Weft mailbox terminalRetentionMs', () => {
    expect(COMMAND_LEDGER_DEFAULT_TERMINAL_RETENTION_MS).toBe(DAY_MS);
  });

  it('keeps a binding for the whole window: an exact retry replays and a different payload conflicts', async () => {
    const { fixture, runtime, ledger } = memoryLedger();
    try {
      const completed = await completedBinding(ledger);
      runtime.setTime(ORIGIN_MS + DAY_MS - 1);

      expect(await ledger.claim(IDENTITY, 'digest-a', { runId: 'run-2' })).toEqual({
        outcome: 'existing',
        entry: completed,
      });
      expect(
        await rejectionOf(ledger.claim(IDENTITY, 'digest-b', { runId: 'run-2' })),
      ).toBeInstanceOf(BureauLedgerConflictError);
      expect(await ledger.locate(IDENTITY)).toEqual({ state: 'retained', entry: completed });
    } finally {
      await fixture.dispose();
    }
  });

  it('reports the binding expired once the window has passed, and the same request id claims afresh', async () => {
    const { fixture, runtime, ledger } = memoryLedger();
    try {
      const completed = await completedBinding(ledger);
      runtime.setTime(ORIGIN_MS + DAY_MS);

      expect(await ledger.locate(IDENTITY)).toEqual({
        state: 'expired',
        entry: completed,
        expiredAt: new Date(ORIGIN_MS + DAY_MS).toISOString(),
      });
      const fresh = await ledger.claim(IDENTITY, 'digest-a', { runId: 'run-2' });
      expect(fresh).toEqual({
        outcome: 'claimed',
        entry: {
          state: 'pending',
          identity: IDENTITY,
          payloadDigest: 'digest-a',
          claimedAt: new Date(ORIGIN_MS + DAY_MS).toISOString(),
          claim: { runId: 'run-2' },
        },
      });
      expect(await ledger.read(IDENTITY)).toEqual(fresh.entry);
      expect(await ledger.locate(IDENTITY)).toEqual({ state: 'retained', entry: fresh.entry });
    } finally {
      await fixture.dispose();
    }
  });

  it('lets a payload that conflicted with the expired binding claim afresh, and drops its conflict records', async () => {
    const { fixture, kv, runtime, ledger } = memoryLedger();
    try {
      await completedBinding(ledger);
      await rejectionOf(ledger.claim(IDENTITY, 'digest-b', { runId: 'run-2' }));
      expect(await ledger.listConflicts(IDENTITY)).toHaveLength(1);

      runtime.setTime(ORIGIN_MS + DAY_MS);
      const fresh = await ledger.claim(IDENTITY, 'digest-b', { runId: 'run-3' });

      expect(fresh.outcome).toBe('claimed');
      expect(fresh.entry.payloadDigest).toBe('digest-b');
      expect(await ledger.listConflicts(IDENTITY)).toEqual([]);
      const remaining = await keys(kv);
      expect(remaining.filter((key) => key.includes(':conflict:'))).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  it('ignores conflict records once the binding they conflicted with has expired', async () => {
    const { fixture, runtime, ledger } = memoryLedger();
    try {
      await completedBinding(ledger);
      await rejectionOf(ledger.claim(IDENTITY, 'digest-b', { runId: 'run-2' }));

      runtime.setTime(ORIGIN_MS + DAY_MS);
      expect(await ledger.listConflicts(IDENTITY)).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  it('honors a configured window', async () => {
    const { fixture, runtime, ledger } = memoryLedger({ terminalRetentionMs: 1_000 });
    try {
      await completedBinding(ledger);
      runtime.setTime(ORIGIN_MS + 999);
      expect(await ledger.locate(IDENTITY)).toMatchObject({ state: 'retained' });
      expect(await ledger.claim(IDENTITY, 'digest-a', { runId: 'run-2' })).toMatchObject({
        outcome: 'existing',
      });

      runtime.setTime(ORIGIN_MS + 1_000);
      expect(await ledger.locate(IDENTITY)).toMatchObject({ state: 'expired' });
      expect(await ledger.claim(IDENTITY, 'digest-a', { runId: 'run-2' })).toMatchObject({
        outcome: 'claimed',
      });
    } finally {
      await fixture.dispose();
    }
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['not finite', Number.POSITIVE_INFINITY],
  ])('rejects a %s window', async (_label, terminalRetentionMs) => {
    const runtime: ManualRuntimeServices = createManualRuntimeServices({ origin: ORIGIN });
    await using fixture = createMemoryStorageFixture();
    const kv = textValueStore(fixture.storage, { disposeUnderlyingStorage: false });
    expect(() =>
      createCommandLedger({
        kv,
        clock: runtime.clock,
        nextConflictId: () => 'conflict',
        terminalRetentionMs,
      }),
    ).toThrow('"terminalRetentionMs" must be a positive integer');
  });

  it('holds a binding past the window while its command is still in progress', async () => {
    let start: number | undefined;
    const { fixture, runtime, ledger } = memoryLedger({ retentionStart: async () => start });
    try {
      const completed = await completedBinding(ledger);
      runtime.setTime(ORIGIN_MS + 3 * DAY_MS);
      expect(await ledger.locate(IDENTITY)).toEqual({ state: 'retained', entry: completed });
      expect(await ledger.claim(IDENTITY, 'digest-a', { runId: 'run-2' })).toMatchObject({
        outcome: 'existing',
      });

      // The command settles now: the window runs from here, not from the claim.
      start = ORIGIN_MS + 3 * DAY_MS;
      runtime.setTime(start + DAY_MS - 1);
      expect(await ledger.locate(IDENTITY)).toMatchObject({ state: 'retained' });
      runtime.setTime(start + DAY_MS);
      expect(await ledger.locate(IDENTITY)).toMatchObject({
        state: 'expired',
        expiredAt: new Date(start + DAY_MS).toISOString(),
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('records when a command settled once, and measures the window from it', async () => {
    const { fixture, runtime, ledger } = memoryLedger();
    try {
      const completed = await completedBinding(ledger);
      runtime.setTime(ORIGIN_MS + 9_000);
      const settled = await ledger.settle(completed, new Date(ORIGIN_MS + 5_000).toISOString());
      if (settled === undefined) throw new Error('expected the settlement to be recorded');
      expect(settled).toEqual({
        ...completed,
        settledAt: new Date(ORIGIN_MS + 5_000).toISOString(),
      });

      const later = new Date(ORIGIN_MS + 9_000).toISOString();
      expect(await ledger.settle(completed, later)).toEqual(settled);
      expect(await ledger.settle(settled, later)).toEqual(settled);

      runtime.setTime(ORIGIN_MS + 5_000 + DAY_MS - 1);
      expect(await ledger.locate(IDENTITY)).toMatchObject({ state: 'retained' });
      runtime.setTime(ORIGIN_MS + 5_000 + DAY_MS);
      expect(await ledger.locate(IDENTITY)).toMatchObject({ state: 'expired' });
    } finally {
      await fixture.dispose();
    }
  });

  it('refuses to complete a claim whose binding expired and was claimed again', async () => {
    const { fixture, runtime, ledger } = memoryLedger();
    try {
      const stale = await ledger.claim(IDENTITY, 'digest-a', { runId: 'run-1' });
      if (stale.outcome !== 'claimed') throw new Error('expected a fresh claim');
      runtime.setTime(ORIGIN_MS + DAY_MS);
      const fresh = await ledger.claim(IDENTITY, 'digest-a', { runId: 'run-2' });
      expect(fresh.outcome).toBe('claimed');

      expect(
        await throwingRejectionOf(ledger.complete(stale.entry, { status: 'running' })),
      ).toThrow('no longer pending as claimed');
      expect(await ledger.read(IDENTITY)).toEqual(fresh.entry);
    } finally {
      await fixture.dispose();
    }
  });

  it('reports an identity with no binding as not found', async () => {
    const { fixture, ledger } = memoryLedger();
    try {
      expect(await ledger.locate(IDENTITY)).toEqual({ state: 'not-found' });
    } finally {
      await fixture.dispose();
    }
  });

  it('prunes expired bindings with their conflict records and keeps retained ones', async () => {
    const { fixture, kv, runtime, ledger } = memoryLedger();
    const other: CommandLedgerIdentity = { ...IDENTITY, requestId: 'request-2' };
    try {
      await completedBinding(ledger);
      await rejectionOf(ledger.claim(IDENTITY, 'digest-b', { runId: 'run-2' }));
      runtime.setTime(ORIGIN_MS + 1_000);
      const retained = await ledger.claim(other, 'digest-a', { runId: 'run-3' });

      runtime.setTime(ORIGIN_MS + DAY_MS);
      expect(await ledger.prune()).toEqual({ entries: 1, conflicts: 1 });

      expect(await ledger.locate(IDENTITY)).toEqual({ state: 'not-found' });
      expect(await ledger.locate(other)).toEqual({ state: 'retained', entry: retained.entry });
      expect(await keys(kv)).toHaveLength(1);
      expect(await ledger.prune()).toEqual({ entries: 0, conflicts: 0 });
    } finally {
      await fixture.dispose();
    }
  });
});

const CLAIM: RunCreationClaim = { runId: 'run-1', sessionId: 'session-1' };

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    status: 'running',
    steps: 0,
    usage: { prompt: 0, completion: 0, total: 0 },
    finishReason: undefined,
    error: undefined,
    actionCount: 1,
    agentName: 'bureau',
    principal: 'alice',
    startedAt: 1,
    ...overrides,
  };
}

function beginInput(overrides: Partial<BeginRunCreationInput> = {}): BeginRunCreationInput {
  return {
    callerId: 'alice',
    agentName: 'bureau',
    requestId: 'request-1',
    payloadDigest: 'digest-a',
    claim: CLAIM,
    ...overrides,
  };
}

/** The location of a recorded receipt; fails when the run carried none. */
function recorded(receipt: RunCreationReceipt | undefined): RunCreationReceiptLocation {
  if (receipt === undefined) throw new Error('expected the run to carry a receipt');
  return { status: 'recorded', receipt, sessionId: expect.any(String) as string };
}

const LOCATE = { callerId: 'alice', agentName: 'bureau', requestId: 'request-1' } as const;

function runCreationLedger(
  observe: (claim: RunCreationClaim) => Promise<RunCreationObservation>,
  terminalRetentionMs?: number,
) {
  const fixture = createMemoryStorageFixture();
  const kv = textValueStore(fixture.storage, { disposeUnderlyingStorage: false });
  const runtime = createManualRuntimeServices({ origin: ORIGIN });
  const create = (observeWith = observe) =>
    createRunCreationLedger({
      kv,
      clock: runtime.clock,
      identifiers: runtime.identifiers,
      observe: observeWith,
      ...(terminalRetentionMs === undefined ? {} : { terminalRetentionMs }),
    });
  return { fixture, kv, runtime, ledger: create(), create };
}

describe('run-creation ledger retention', () => {
  it('holds the binding of a run still running past the window', async () => {
    const { fixture, runtime, ledger } = runCreationLedger(async () => ({
      live: summary(),
      durableStatus: undefined,
    }));
    try {
      const attempt = await ledger.begin(beginInput());
      if (attempt.kind !== 'claimed') throw new Error('expected a fresh claim');
      const created = await attempt.complete(summary());

      runtime.setTime(ORIGIN_MS + 3 * DAY_MS);
      const retry = await ledger.begin(beginInput({ claim: { runId: 'run-2', sessionId: 's-2' } }));

      expect(retry).toEqual({ kind: 'replay', result: created });
      expect(await ledger.locate(LOCATE)).toEqual(recorded(created.receipt));
    } finally {
      await fixture.dispose();
    }
  });

  it('starts the window when it first observes the run settled at a time it cannot see, then admits the request id afresh', async () => {
    let live: RunSummary | undefined = summary();
    const { fixture, runtime, ledger } = runCreationLedger(async () => ({
      live,
      durableStatus: undefined,
    }));
    try {
      const attempt = await ledger.begin(beginInput());
      if (attempt.kind !== 'claimed') throw new Error('expected a fresh claim');
      const created = await attempt.complete(summary());

      // The run settles; the receipt query at +1h is the first to see it.
      live = summary({ status: 'completed', steps: 1 });
      const settledAt = ORIGIN_MS + 3_600_000;
      runtime.setTime(settledAt);
      expect(await ledger.locate(LOCATE)).toEqual(recorded(created.receipt));

      runtime.setTime(settledAt + DAY_MS - 1);
      expect(
        await ledger.begin(beginInput({ claim: { runId: 'run-2', sessionId: 's-2' } })),
      ).toEqual({ kind: 'replay', result: { ...live, receipt: created.receipt } });

      runtime.setTime(settledAt + DAY_MS);
      expect(await ledger.locate(LOCATE)).toEqual({
        status: 'expired',
        requestId: 'request-1',
        expiredAt: new Date(settledAt + DAY_MS).toISOString(),
      });
      const fresh = await ledger.begin(beginInput({ claim: { runId: 'run-2', sessionId: 's-2' } }));
      expect(fresh.kind).toBe('claimed');
    } finally {
      await fixture.dispose();
    }
  });

  it('starts the window of a run that settled before its receipt was recorded at the recording', async () => {
    // A restart's retry finds the claim pending and the run already finished.
    const { fixture, runtime, ledger, create } = runCreationLedger(async () => ({
      live: undefined,
      durableStatus: null,
    }));
    try {
      expect(await ledger.begin(beginInput())).toMatchObject({ kind: 'claimed' });

      const after = create(async () => ({ live: undefined, durableStatus: 'completed' }));
      runtime.setTime(ORIGIN_MS + 1_000);
      const recovered = await after.begin(
        beginInput({ claim: { runId: 'run-2', sessionId: 's-2' } }),
      );
      expect(recovered).toMatchObject({
        kind: 'replay',
        result: { id: 'run-1', status: 'completed' },
      });

      runtime.setTime(ORIGIN_MS + 1_000 + DAY_MS - 1);
      expect(await after.locate(LOCATE)).toMatchObject({ status: 'recorded' });
      runtime.setTime(ORIGIN_MS + 1_000 + DAY_MS);
      expect(await after.locate(LOCATE)).toMatchObject({ status: 'expired' });
    } finally {
      await fixture.dispose();
    }
  });

  it("starts the window at the run's terminal time when nobody observed the run settle", async () => {
    // The run settled at +1s and nothing queried it until a week later.
    const settledAt = ORIGIN_MS + 1_000;
    const { fixture, runtime, ledger } = runCreationLedger(async () => ({
      live: summary({ status: 'completed', steps: 1 }),
      durableStatus: undefined,
      settledAt,
    }));
    try {
      const attempt = await ledger.begin(beginInput());
      if (attempt.kind !== 'claimed') throw new Error('expected a fresh claim');
      await attempt.complete(summary());

      runtime.setTime(ORIGIN_MS + 7 * DAY_MS);
      expect(await ledger.locate(LOCATE)).toEqual({
        status: 'expired',
        requestId: 'request-1',
        expiredAt: new Date(settledAt + DAY_MS).toISOString(),
      });
      const fresh = await ledger.begin(beginInput({ claim: { runId: 'run-2', sessionId: 's-2' } }));
      expect(fresh.kind).toBe('claimed');
    } finally {
      await fixture.dispose();
    }
  });

  it("keeps the binding until the window measured from the run's terminal time has passed", async () => {
    const settledAt = ORIGIN_MS + 1_000;
    const { fixture, runtime, ledger } = runCreationLedger(async () => ({
      live: summary({ status: 'completed', steps: 1 }),
      durableStatus: undefined,
      settledAt,
    }));
    try {
      const attempt = await ledger.begin(beginInput());
      if (attempt.kind !== 'claimed') throw new Error('expected a fresh claim');
      const created = await attempt.complete(summary());

      runtime.setTime(settledAt + DAY_MS - 1);
      expect(await ledger.locate(LOCATE)).toEqual(recorded(created.receipt));
      runtime.setTime(settledAt + DAY_MS);
      expect(await ledger.locate(LOCATE)).toMatchObject({ status: 'expired' });
    } finally {
      await fixture.dispose();
    }
  });

  it('lists the run id of every stored binding, expired ones included, and fails closed on a claim with no readable run id (COR-1477)', async () => {
    const { fixture, kv, ledger } = runCreationLedger(async () => ({
      live: summary({ status: 'completed', steps: 1 }),
      durableStatus: undefined,
    }));
    try {
      const attempt = await ledger.begin(beginInput());
      if (attempt.kind !== 'claimed') throw new Error('expected a fresh claim');
      const created = await attempt.complete(summary());
      expect(await ledger.boundRunIds()).toEqual(new Set([created.id]));

      // A persisted entry whose claim names no run (`{}`, or a non-string id)
      // cannot be ruled out as a task's binding.
      for (const claim of [{}, { runId: 42 }, { runId: '' }, null]) {
        const listed = await kv.list('');
        const key = listed.find((candidate) => candidate.includes(':entry:'));
        if (key === undefined) throw new Error('expected a stored entry');
        const stored = JSON.parse((await kv.get(key)) ?? '{}');
        await kv.set(key, JSON.stringify({ ...stored, claim }));
        expect(await rejectionOf(ledger.boundRunIds())).toBeInstanceOf(Error);
      }
    } finally {
      await fixture.dispose();
    }
  });

  it('prunes a settled binding nobody observed in one pass', async () => {
    const settledAt = ORIGIN_MS + 1_000;
    const { fixture, kv, runtime, ledger } = runCreationLedger(async () => ({
      live: summary({ status: 'completed', steps: 1 }),
      durableStatus: undefined,
      settledAt,
    }));
    try {
      const attempt = await ledger.begin(beginInput());
      if (attempt.kind !== 'claimed') throw new Error('expected a fresh claim');
      await attempt.complete(summary());

      runtime.setTime(settledAt + DAY_MS - 1);
      expect(await ledger.prune()).toEqual({ entries: 0, conflicts: 0 });
      runtime.setTime(settledAt + DAY_MS);
      expect(await ledger.prune()).toEqual({ entries: 1, conflicts: 0 });
      expect(await ledger.locate(LOCATE)).toEqual({ status: 'not-found', requestId: 'request-1' });
      expect(await keys(kv)).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  it("prunes a pending claim whose run settled after its claimant died, from the run's terminal time", async () => {
    const settledAt = ORIGIN_MS + 2_000;
    const { fixture, runtime, ledger, create } = runCreationLedger(async () => ({
      live: undefined,
      durableStatus: null,
    }));
    try {
      // The claimant dies after the run started: its claim is never completed.
      expect(await ledger.begin(beginInput())).toMatchObject({ kind: 'claimed' });
      const after = create(async () => ({
        live: summary({ status: 'completed', steps: 1 }),
        durableStatus: undefined,
        settledAt,
      }));

      runtime.setTime(settledAt + DAY_MS);
      expect(await after.prune()).toEqual({ entries: 1, conflicts: 0 });
      expect(await after.locate(LOCATE)).toMatchObject({ status: 'not-found' });
    } finally {
      await fixture.dispose();
    }
  });

  it('records the receipt of a pending claim whose run settled at a time it cannot see, and prunes it a window later', async () => {
    const { fixture, runtime, ledger, create } = runCreationLedger(async () => ({
      live: undefined,
      durableStatus: null,
    }));
    try {
      expect(await ledger.begin(beginInput())).toMatchObject({ kind: 'claimed' });
      // After a restart the run is only in the durable engine, already finished.
      const after = create(async () => ({ live: undefined, durableStatus: 'completed' }));

      const firstPrune = ORIGIN_MS + 30 * DAY_MS;
      runtime.setTime(firstPrune);
      expect(await after.prune()).toEqual({ entries: 0, conflicts: 0 });
      expect(await after.ledger.read(IDENTITY)).toMatchObject({
        state: 'completed',
        settledAt: new Date(firstPrune).toISOString(),
        result: { receipt: { runId: 'run-1', status: 'completed' } },
      });

      runtime.setTime(firstPrune + DAY_MS);
      expect(await after.prune()).toEqual({ entries: 1, conflicts: 0 });
    } finally {
      await fixture.dispose();
    }
  });

  it('expires a claim whose run never started from its claim time, so the request id admits a new run', async () => {
    const { fixture, runtime, ledger, create } = runCreationLedger(async () => ({
      live: undefined,
      durableStatus: null,
    }));
    try {
      expect(await ledger.begin(beginInput())).toMatchObject({ kind: 'claimed' });
      const after = create();

      runtime.setTime(ORIGIN_MS + DAY_MS - 1);
      expect(await after.locate(LOCATE)).toEqual({
        status: 'pending',
        receipt: { runId: 'run-1', requestId: 'request-1', createdAt: ORIGIN, status: 'pending' },
        sessionId: CLAIM.sessionId,
      });
      expect(
        await after.begin(beginInput({ claim: { runId: 'run-2', sessionId: 's-2' } })),
      ).toMatchObject({ kind: 'replay' });

      runtime.setTime(ORIGIN_MS + DAY_MS);
      expect(await after.locate(LOCATE)).toMatchObject({ status: 'expired' });
      expect(
        await after.begin(beginInput({ claim: { runId: 'run-2', sessionId: 's-2' } })),
      ).toMatchObject({ kind: 'claimed' });
    } finally {
      await fixture.dispose();
    }
  });

  it('never expires a claim this process is still settling', async () => {
    const { fixture, runtime, ledger } = runCreationLedger(async () => ({
      live: undefined,
      durableStatus: null,
    }));
    try {
      const attempt = await ledger.begin(beginInput());
      if (attempt.kind !== 'claimed') throw new Error('expected a fresh claim');
      runtime.setTime(ORIGIN_MS + 2 * DAY_MS);

      expect(await ledger.locate(LOCATE)).toMatchObject({ status: 'pending' });
      const waiting = ledger.begin(beginInput({ claim: { runId: 'run-2', sessionId: 's-2' } }));
      const created = await attempt.complete(summary());
      expect(await waiting).toEqual({ kind: 'replay', result: created });
    } finally {
      await fixture.dispose();
    }
  });

  it('lets a conflicting payload start a new run once the original binding has expired', async () => {
    const { fixture, runtime, ledger } = runCreationLedger(async () => ({
      live: undefined,
      durableStatus: 'completed',
    }));
    try {
      const attempt = await ledger.begin(beginInput());
      if (attempt.kind !== 'claimed') throw new Error('expected a fresh claim');
      await attempt.complete(summary());
      const conflict = await rejectionOf(ledger.begin(beginInput({ payloadDigest: 'digest-b' })));
      expect(conflict).toBeInstanceOf(BureauLedgerConflictError);

      // The first observation of the settled run starts its window.
      expect(await ledger.locate(LOCATE)).toMatchObject({ status: 'recorded' });
      runtime.setTime(ORIGIN_MS + DAY_MS);
      const fresh = await ledger.begin(
        beginInput({ payloadDigest: 'digest-b', claim: { runId: 'run-2', sessionId: 's-2' } }),
      );
      expect(fresh.kind).toBe('claimed');
      expect(
        await ledger.ledger.listConflicts({
          callerId: 'alice',
          target: 'bureau',
          requestId: 'request-1',
          operationVersion: RUN_CREATION_OPERATION_VERSION,
        }),
      ).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  it('honors a configured window', async () => {
    const { fixture, runtime, ledger } = runCreationLedger(
      async () => ({ live: undefined, durableStatus: 'completed' }),
      60_000,
    );
    try {
      const attempt = await ledger.begin(beginInput());
      if (attempt.kind !== 'claimed') throw new Error('expected a fresh claim');
      await attempt.complete(summary());
      expect(await ledger.locate(LOCATE)).toMatchObject({ status: 'recorded' });

      runtime.setTime(ORIGIN_MS + 59_999);
      expect(await ledger.locate(LOCATE)).toMatchObject({ status: 'recorded' });
      runtime.setTime(ORIGIN_MS + 60_000);
      expect(await ledger.locate(LOCATE)).toMatchObject({ status: 'expired' });
    } finally {
      await fixture.dispose();
    }
  });

  it('reports a request id it never saw as not found', async () => {
    const { fixture, ledger } = runCreationLedger(async () => ({
      live: undefined,
      durableStatus: null,
    }));
    try {
      expect(await ledger.locate(LOCATE)).toEqual({ status: 'not-found', requestId: 'request-1' });
    } finally {
      await fixture.dispose();
    }
  });
});
