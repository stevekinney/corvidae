/**
 * COR-424 — the command ledger's identity, digest, and conflict semantics,
 * over the memory backend. The persistent backends' fault-point coverage
 * lives in `run-creation-fault-points.test.ts`; this file is the unit layer
 * those tests build on.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { type ConditionalTextValueStore, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import {
  BureauLedgerConflictError,
  type CommandLedgerIdentity,
  createCommandLedger,
  createRunCreationLedger,
  digestCommandPayload,
  digestRunCreationPayload,
  RUN_CREATION_OPERATION_VERSION,
  type RunCreationClaim,
  type RunCreationObservation,
} from './command-ledger';
import { BureauError } from './create-bureau';
import { createMemoryStorageFixture } from './test/storage-fixtures';
import { rejectionOf, throwingRejectionOf } from './testing/promise-outcome.test-support.ts';
import type { RunSummary } from './types';

const ORIGIN = '2026-10-13T00:00:00.000Z';

interface TestClaim {
  readonly runId: string;
}

interface TestResult {
  readonly status: string;
}

function identity(overrides: Partial<CommandLedgerIdentity> = {}): CommandLedgerIdentity {
  return {
    callerId: 'alice',
    requestId: 'request-1',
    operationVersion: RUN_CREATION_OPERATION_VERSION,
    ...overrides,
  };
}

function memoryLedger() {
  const fixture = createMemoryStorageFixture();
  const kv = textValueStore(fixture.configuration, { disposeUnderlyingStorage: false });
  const runtime = createManualRuntimeServices({ origin: ORIGIN });
  const ledger = createCommandLedger<TestClaim, TestResult>({
    kv,
    now: () => runtime.clock.nowISO(),
    nextConflictId: () => runtime.identifiers.next('ledger-conflict'),
  });
  return { fixture, kv, runtime, ledger };
}

/** Every key the ledger has written, with its raw stored value. */
async function snapshot(kv: ConditionalTextValueStore): Promise<Record<string, string | null>> {
  const keys = await kv.list('');
  const entries: Record<string, string | null> = {};
  for (const key of keys.toSorted()) entries[key] = await kv.get(key);
  return entries;
}

describe('digestCommandPayload', () => {
  it('is stable across key order and ignores absent fields', () => {
    expect(digestCommandPayload({ message: 'hi', maximumSteps: 3 })).toBe(
      digestCommandPayload({ maximumSteps: 3, message: 'hi', systemPrompt: undefined }),
    );
  });

  it('changes when any field value changes', () => {
    const base = digestCommandPayload({ message: 'hi', maximumSteps: 3 });
    expect(digestCommandPayload({ message: 'hi!', maximumSteps: 3 })).not.toBe(base);
    expect(digestCommandPayload({ message: 'hi', maximumSteps: 4 })).not.toBe(base);
    expect(digestCommandPayload({ message: 'hi', maximumSteps: 3, agentName: 'a' })).not.toBe(base);
  });

  it('distinguishes a string from the number it spells', () => {
    expect(digestCommandPayload({ value: '3' })).not.toBe(digestCommandPayload({ value: 3 }));
  });
});

describe('digestRunCreationPayload', () => {
  it('digests what decides the run, and not who asked or how they authenticated', () => {
    const base = digestRunCreationPayload({ message: 'hi', sessionId: 'session-1' });
    expect(
      digestRunCreationPayload({
        message: 'hi',
        sessionId: ' session-1 ',
        principal: 'alice',
        runCreationRequestId: 'request-1',
        requestContext: undefined,
      }),
    ).toBe(base);
    expect(digestRunCreationPayload({ message: 'hi', sessionId: 'session-2' })).not.toBe(base);
    expect(
      digestRunCreationPayload({ message: 'hi', sessionId: 'session-1', systemPrompt: 'x' }),
    ).not.toBe(base);
    expect(
      digestRunCreationPayload({ message: 'hi', sessionId: 'session-1', maximumTokens: 10 }),
    ).not.toBe(base);
  });
});

describe('createCommandLedger (memory backend)', () => {
  it('claims a fresh identity as a pending entry carrying the payload digest', async () => {
    const { fixture, ledger } = memoryLedger();
    try {
      const outcome = await ledger.claim(identity(), 'digest-a', { runId: 'run-1' });
      expect(outcome).toEqual({
        outcome: 'claimed',
        entry: {
          state: 'pending',
          identity: identity(),
          payloadDigest: 'digest-a',
          claimedAt: ORIGIN,
          claim: { runId: 'run-1' },
        },
      });
      expect(await ledger.read(identity())).toEqual(outcome.entry);
    } finally {
      await fixture.dispose();
    }
  });

  it('returns the original completed entry for an exact retry and leaves it untouched', async () => {
    const { fixture, kv, ledger } = memoryLedger();
    try {
      const first = await ledger.claim(identity(), 'digest-a', { runId: 'run-1' });
      if (first.outcome !== 'claimed') throw new Error('expected a fresh claim');
      const completed = await ledger.complete(first.entry, { status: 'running' });
      const before = await snapshot(kv);

      const retry = await ledger.claim(identity(), 'digest-a', { runId: 'run-2' });

      expect(retry).toEqual({ outcome: 'existing', entry: completed });
      expect(completed).toMatchObject({
        state: 'completed',
        claim: { runId: 'run-1' },
        result: { status: 'running' },
      });
      expect(await snapshot(kv)).toEqual(before);
    } finally {
      await fixture.dispose();
    }
  });

  it('observes a pending entry on retry without claiming again, and the original stays completable', async () => {
    // The after-claim fault point at the unit layer: an entry exists but
    // its work has not been acknowledged. A retry must see that entry, not
    // proceed as a fresh attempt with its own run.
    const { fixture, kv, ledger } = memoryLedger();
    try {
      const first = await ledger.claim(identity(), 'digest-a', { runId: 'run-1' });
      if (first.outcome !== 'claimed') throw new Error('expected a fresh claim');
      const before = await snapshot(kv);

      const retry = await ledger.claim(identity(), 'digest-a', { runId: 'run-2' });
      expect(retry).toEqual({ outcome: 'existing', entry: first.entry });
      expect(await snapshot(kv)).toEqual(before);

      const completed = await ledger.complete(first.entry, { status: 'running' });
      expect(completed.claim).toEqual({ runId: 'run-1' });
      expect(await ledger.read(identity())).toEqual(completed);
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects a payload mismatch with a typed conflict, records it separately, and never mutates the original', async () => {
    const { fixture, ledger } = memoryLedger();
    try {
      const first = await ledger.claim(identity(), 'digest-a', { runId: 'run-1' });
      if (first.outcome !== 'claimed') throw new Error('expected a fresh claim');
      const original = await ledger.complete(first.entry, { status: 'running' });

      let caught: unknown;
      try {
        await ledger.claim(identity(), 'digest-b', { runId: 'run-2' });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(BureauLedgerConflictError);
      expect(caught).not.toBeInstanceOf(BureauError);
      const conflict = caught as BureauLedgerConflictError;
      expect(conflict.name).toBe('BureauLedgerConflictError');
      expect(conflict.requestId).toBe('request-1');
      expect(conflict.reason).toBe('payload-mismatch');

      expect(await ledger.read(identity())).toEqual(original);
      expect(await ledger.listConflicts(identity())).toEqual([
        {
          state: 'failed',
          identity: identity(),
          conflictId: conflict.conflictId,
          reason: 'payload-mismatch',
          payloadDigest: 'digest-b',
          originalPayloadDigest: 'digest-a',
          recordedAt: ORIGIN,
        },
      ]);

      // A second conflicting attempt is its own failed entry, not an
      // overwrite of the first.
      expect(
        await throwingRejectionOf(ledger.claim(identity(), 'digest-c', { runId: 'run-3' })),
      ).toThrow(BureauLedgerConflictError);
      const conflicts = await ledger.listConflicts(identity());
      expect(conflicts.map((entry) => entry.payloadDigest).toSorted()).toEqual([
        'digest-b',
        'digest-c',
      ]);
      expect(await ledger.read(identity())).toEqual(original);
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps a pending original completable after a conflicting attempt', async () => {
    const { fixture, ledger } = memoryLedger();
    try {
      const first = await ledger.claim(identity(), 'digest-a', { runId: 'run-1' });
      if (first.outcome !== 'claimed') throw new Error('expected a fresh claim');

      expect(
        await throwingRejectionOf(ledger.claim(identity(), 'digest-b', { runId: 'run-2' })),
      ).toThrow(BureauLedgerConflictError);

      expect(await ledger.read(identity())).toEqual(first.entry);
      const completed = await ledger.complete(first.entry, { status: 'running' });
      expect(completed).toMatchObject({ state: 'completed', payloadDigest: 'digest-a' });
    } finally {
      await fixture.dispose();
    }
  });

  it('keys identity on caller, request id, and operation version together', async () => {
    const { fixture, ledger } = memoryLedger();
    try {
      await ledger.claim(identity(), 'digest-a', { runId: 'run-1' });

      const otherCaller = await ledger.claim(identity({ callerId: 'bob' }), 'digest-b', {
        runId: 'run-2',
      });
      const otherRequest = await ledger.claim(identity({ requestId: 'request-10' }), 'digest-c', {
        runId: 'run-3',
      });
      const otherVersion = await ledger.claim(
        identity({ operationVersion: 'bureau.run-creation.v2' }),
        'digest-d',
        { runId: 'run-4' },
      );

      expect(otherCaller.outcome).toBe('claimed');
      expect(otherRequest.outcome).toBe('claimed');
      expect(otherVersion.outcome).toBe('claimed');
      expect(await ledger.listConflicts(identity())).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  it('encodes key components so a delimiter in one cannot collide with another identity', async () => {
    const { fixture, ledger } = memoryLedger();
    try {
      await ledger.claim(identity({ callerId: 'a:b', requestId: 'c' }), 'digest-a', {
        runId: 'run-1',
      });
      const other = await ledger.claim(identity({ callerId: 'a', requestId: 'b:c' }), 'digest-b', {
        runId: 'run-2',
      });
      expect(other.outcome).toBe('claimed');
    } finally {
      await fixture.dispose();
    }
  });

  it('releases a pending entry so a later attempt claims afresh', async () => {
    const { fixture, kv, ledger } = memoryLedger();
    try {
      const first = await ledger.claim(identity(), 'digest-a', { runId: 'run-1' });
      if (first.outcome !== 'claimed') throw new Error('expected a fresh claim');

      expect(await ledger.release(first.entry)).toBe(true);
      expect(await ledger.read(identity())).toBeUndefined();
      expect(await snapshot(kv)).toEqual({});

      const again = await ledger.claim(identity(), 'digest-b', { runId: 'run-2' });
      expect(again.outcome).toBe('claimed');
    } finally {
      await fixture.dispose();
    }
  });

  it('never releases or re-completes an entry that is no longer the pending one it claimed', async () => {
    const { fixture, ledger } = memoryLedger();
    try {
      const first = await ledger.claim(identity(), 'digest-a', { runId: 'run-1' });
      if (first.outcome !== 'claimed') throw new Error('expected a fresh claim');
      const completed = await ledger.complete(first.entry, { status: 'running' });

      expect(await ledger.release(first.entry)).toBe(false);
      expect(
        await throwingRejectionOf(ledger.complete(first.entry, { status: 'completed' })),
      ).toThrow(/no longer pending/);
      expect(await ledger.read(identity())).toEqual(completed);
    } finally {
      await fixture.dispose();
    }
  });

  it('fails closed on an unreadable entry instead of treating it as absent', async () => {
    const { fixture, kv, ledger } = memoryLedger();
    try {
      const first = await ledger.claim(identity(), 'digest-a', { runId: 'run-1' });
      if (first.outcome !== 'claimed') throw new Error('expected a fresh claim');
      const [key] = await kv.list('');
      await kv.set(key!, '{not json');

      expect(
        await throwingRejectionOf(ledger.claim(identity(), 'digest-a', { runId: 'run-2' })),
      ).toThrow(/unreadable/);
      expect(await kv.get(key!)).toBe('{not json');
    } finally {
      await fixture.dispose();
    }
  });
});

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

const CLAIM: RunCreationClaim = { runId: 'run-1', sessionId: 'session-1', agentName: 'bureau' };

function runCreationLedger(observe: (claim: RunCreationClaim) => Promise<RunCreationObservation>) {
  const fixture = createMemoryStorageFixture();
  const kv = textValueStore(fixture.configuration, { disposeUnderlyingStorage: false });
  const runtime = createManualRuntimeServices({ origin: ORIGIN });
  const ledger = createRunCreationLedger({
    kv,
    clock: runtime.clock,
    identifiers: runtime.identifiers,
    observe,
  });
  return { fixture, kv, runtime, ledger };
}

const notObserved = async (): Promise<RunCreationObservation> => ({
  live: undefined,
  durableStatus: undefined,
});

describe('createRunCreationLedger', () => {
  it('returns a durable receipt with the run id, request id, creation time, and status', async () => {
    const { fixture, ledger } = runCreationLedger(notObserved);
    try {
      const attempt = await ledger.begin({
        callerId: 'alice',
        requestId: 'request-1',
        payloadDigest: 'digest-a',
        claim: CLAIM,
      });
      if (attempt.kind !== 'claimed') throw new Error('expected a fresh claim');
      const created = await attempt.complete(summary());

      expect(created).toEqual({
        ...summary(),
        receipt: { runId: 'run-1', requestId: 'request-1', createdAt: ORIGIN, status: 'running' },
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('replays the original receipt for an exact retry', async () => {
    let live: RunSummary | undefined;
    const { fixture, ledger } = runCreationLedger(async () => ({ live, durableStatus: undefined }));
    try {
      const attempt = await ledger.begin({
        callerId: 'alice',
        requestId: 'request-1',
        payloadDigest: 'digest-a',
        claim: CLAIM,
      });
      if (attempt.kind !== 'claimed') throw new Error('expected a fresh claim');
      const created = await attempt.complete(summary());
      live = summary({ status: 'completed', steps: 1 });

      const retry = await ledger.begin({
        callerId: 'alice',
        requestId: 'request-1',
        payloadDigest: 'digest-a',
        claim: { ...CLAIM, runId: 'run-2', sessionId: 'session-2' },
      });

      // The receipt is the original one; the summary is the run as it is now.
      expect(retry).toEqual({
        kind: 'replay',
        result: { ...live, receipt: created.receipt },
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('replays the stored summary with the durable status when the run is not live here', async () => {
    const { fixture, ledger } = runCreationLedger(async () => ({
      live: undefined,
      durableStatus: 'cancelled',
    }));
    try {
      const attempt = await ledger.begin({
        callerId: 'alice',
        requestId: 'request-1',
        payloadDigest: 'digest-a',
        claim: CLAIM,
      });
      if (attempt.kind !== 'claimed') throw new Error('expected a fresh claim');
      const created = await attempt.complete(summary());

      const retry = await ledger.begin({
        callerId: 'alice',
        requestId: 'request-1',
        payloadDigest: 'digest-a',
        claim: { ...CLAIM, runId: 'run-2' },
      });

      expect(retry).toEqual({
        kind: 'replay',
        result: { ...summary(), status: 'aborted', receipt: created.receipt },
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('waits for an in-flight attempt in this process and returns its outcome', async () => {
    const { fixture, ledger } = runCreationLedger(notObserved);
    try {
      const first = await ledger.begin({
        callerId: 'alice',
        requestId: 'request-1',
        payloadDigest: 'digest-a',
        claim: CLAIM,
      });
      if (first.kind !== 'claimed') throw new Error('expected a fresh claim');

      const retry = ledger.begin({
        callerId: 'alice',
        requestId: 'request-1',
        payloadDigest: 'digest-a',
        claim: { ...CLAIM, runId: 'run-2' },
      });
      let retrySettled = false;
      void retry.then(() => {
        retrySettled = true;
      });
      for (let turn = 0; turn < 10; turn++) await Promise.resolve();
      expect(retrySettled).toBe(false);

      const created = await first.complete(summary());
      expect(await retry).toEqual({ kind: 'replay', result: created });
    } finally {
      await fixture.dispose();
    }
  });

  it('hands an in-flight waiter the original failure, and the identity is claimable again', async () => {
    const { fixture, ledger } = runCreationLedger(notObserved);
    try {
      const first = await ledger.begin({
        callerId: 'alice',
        requestId: 'request-1',
        payloadDigest: 'digest-a',
        claim: CLAIM,
      });
      if (first.kind !== 'claimed') throw new Error('expected a fresh claim');
      const retry = ledger.begin({
        callerId: 'alice',
        requestId: 'request-1',
        payloadDigest: 'digest-a',
        claim: { ...CLAIM, runId: 'run-2' },
      });

      const failure = new Error('session store unavailable');
      await first.release(failure);
      expect(await rejectionOf(retry)).toBe(failure);

      const again = await ledger.begin({
        callerId: 'alice',
        requestId: 'request-1',
        payloadDigest: 'digest-a',
        claim: { ...CLAIM, runId: 'run-3' },
      });
      expect(again.kind).toBe('claimed');
    } finally {
      await fixture.dispose();
    }
  });

  it('reports a claimed-but-never-started run as pending instead of starting another', async () => {
    // The after-claim fault point across a restart: a second ledger over the
    // same store has no in-flight attempt to wait for, and the run never
    // reached the durable engine.
    const fixture = createMemoryStorageFixture();
    const kv = textValueStore(fixture.configuration, { disposeUnderlyingStorage: false });
    const runtime = createManualRuntimeServices({ origin: ORIGIN });
    try {
      const before = createRunCreationLedger({
        kv,
        clock: runtime.clock,
        identifiers: runtime.identifiers,
        observe: notObserved,
      });
      const claimed = await before.begin({
        callerId: 'alice',
        requestId: 'request-1',
        payloadDigest: 'digest-a',
        claim: CLAIM,
      });
      expect(claimed.kind).toBe('claimed');

      const after = createRunCreationLedger({
        kv,
        clock: runtime.clock,
        identifiers: runtime.identifiers,
        observe: async () => ({ live: undefined, durableStatus: null }),
      });
      const retry = await after.begin({
        callerId: 'alice',
        requestId: 'request-1',
        payloadDigest: 'digest-a',
        claim: { ...CLAIM, runId: 'run-2', sessionId: 'session-2' },
      });

      expect(retry).toEqual({
        kind: 'replay',
        result: {
          id: 'run-1',
          sessionId: 'session-1',
          status: 'pending',
          steps: 0,
          usage: { prompt: 0, completion: 0, total: 0 },
          finishReason: undefined,
          error: undefined,
          actionCount: 0,
          agentName: 'bureau',
          principal: 'alice',
          startedAt: undefined,
          receipt: { runId: 'run-1', requestId: 'request-1', createdAt: ORIGIN, status: 'pending' },
        },
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects a conflicting attempt even while the original is in flight', async () => {
    const { fixture, ledger } = runCreationLedger(notObserved);
    try {
      const first = await ledger.begin({
        callerId: 'alice',
        requestId: 'request-1',
        payloadDigest: 'digest-a',
        claim: CLAIM,
      });
      if (first.kind !== 'claimed') throw new Error('expected a fresh claim');

      const conflict = await rejectionOf(
        ledger.begin({
          callerId: 'alice',
          requestId: 'request-1',
          payloadDigest: 'digest-b',
          claim: { ...CLAIM, runId: 'run-2' },
        }),
      );
      expect(conflict).toBeInstanceOf(BureauLedgerConflictError);
      expect(conflict).toMatchObject({ requestId: 'request-1', reason: 'payload-mismatch' });

      const created = await first.complete(summary());
      expect(created.receipt?.runId).toBe('run-1');
    } finally {
      await fixture.dispose();
    }
  });
});
