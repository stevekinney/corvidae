/**
 * COR-424 — the command ledger's identity, digest, and conflict semantics,
 * over the memory backend. The persistent backends' fault-point coverage
 * lives in `run-creation-fault-points.test.ts`; this file is the unit layer
 * those tests build on.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { type ConditionalTextValueStore, textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import {
  type BeginRunCreationInput,
  BureauLedgerConflictError,
  COMMAND_LEDGER_DEFAULT_TERMINAL_RETENTION_MS,
  type CommandLedgerIdentity,
  createCommandLedger,
  createRunCreationLedger,
  digestCommandPayload,
  digestRunCreationPayload,
  serializeTaskInput,
  serializeTaskRequestContext,
  RUN_CREATION_OPERATION_VERSION,
  type RunCreationClaim,
  type RunCreationObservation,
  RunCreationReceiptUnrecordedError,
} from './command-ledger';
import { BureauError } from './create-bureau';
import { createMemoryStorageFixture } from './test/storage-fixtures';
import { rejectionOf, throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import type { RunSummary } from './types';

const authority = {
  principalId: 'alice',
  tenantId: 'bureau',
  ownerId: 'researcher',
  capabilities: ['tools:execute'],
  authorizationRevision: '1',
};

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
    target: 'bureau',
    requestId: 'request-1',
    operationVersion: RUN_CREATION_OPERATION_VERSION,
    ...overrides,
  };
}

function memoryLedger() {
  const fixture = createMemoryStorageFixture();
  const kv = textValueStore(fixture.storage, { disposeUnderlyingStorage: false });
  const runtime = createManualRuntimeServices({ origin: ORIGIN });
  const ledger = createCommandLedger<TestClaim, TestResult>({
    kv,
    clock: runtime.clock,
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

  it('refuses a non-finite number, which JSON would spell as null', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => digestCommandPayload({ value })).toThrow(/finite number/);
    }
    expect(digestCommandPayload({ value: null })).toBe(digestCommandPayload({ value: null }));
  });
});

describe('digestRunCreationPayload', () => {
  const base = {
    agentName: 'researcher',
    input: serializeTaskInput('hi'),
    contextId: 'context-1',
    requestContext: serializeTaskRequestContext(undefined),
  };

  it('digests the agent, input, context, and request context', () => {
    const digest = digestRunCreationPayload(base);
    expect(digestRunCreationPayload({ ...base, agentName: 'writer' })).not.toBe(digest);
    expect(digestRunCreationPayload({ ...base, input: serializeTaskInput('bye') })).not.toBe(
      digest,
    );
    expect(digestRunCreationPayload({ ...base, contextId: 'context-2' })).not.toBe(digest);
    expect(
      digestRunCreationPayload({
        ...base,
        requestContext: serializeTaskRequestContext({ authority, audience: 'tenant' }),
      }),
    ).not.toBe(digest);
  });

  it('ignores the per-attempt fields of a request context', () => {
    const first = serializeTaskRequestContext({
      authority,
      runId: 'run-1',
      requestId: 'a',
    } as never);
    const retry = serializeTaskRequestContext({
      authority,
      runId: 'run-2',
      requestId: 'b',
    } as never);
    expect(first).toBe(retry);
  });

  it('tells the input forms apart', () => {
    const forms = [
      serializeTaskInput('hi'),
      serializeTaskInput([{ type: 'text', text: 'hi' }]),
      serializeTaskInput({ append: [] }),
      serializeTaskInput({ continue: true }),
    ];
    expect(new Set(forms).size).toBe(forms.length);
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
          originalClaimedAt: ORIGIN,
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

  it('keys identity on caller, target, request id, and operation version together', async () => {
    const { fixture, ledger } = memoryLedger();
    try {
      await ledger.claim(identity(), 'digest-a', { runId: 'run-1' });

      const otherCaller = await ledger.claim(identity({ callerId: 'bob' }), 'digest-b', {
        runId: 'run-2',
      });
      const otherTarget = await ledger.claim(identity({ target: 'researcher' }), 'digest-b', {
        runId: 'run-5',
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
      expect(otherTarget.outcome).toBe('claimed');
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

  it('never releases or overwrites an entry that is no longer the pending one it claimed', async () => {
    const { fixture, ledger } = memoryLedger();
    try {
      const first = await ledger.claim(identity(), 'digest-a', { runId: 'run-1' });
      if (first.outcome !== 'claimed') throw new Error('expected a fresh claim');
      const completed = await ledger.complete(first.entry, { status: 'running' });

      expect(await ledger.release(first.entry)).toBe(false);
      // Completing the same claim again resolves with the record already
      // there; it does not replace that record's result.
      expect(await ledger.complete(first.entry, { status: 'completed' })).toEqual(completed);
      expect(await ledger.read(identity())).toEqual(completed);
    } finally {
      await fixture.dispose();
    }
  });

  it('refuses to complete a claim that was released or replaced by another claim', async () => {
    const { fixture, ledger } = memoryLedger();
    try {
      const first = await ledger.claim(identity(), 'digest-a', { runId: 'run-1' });
      if (first.outcome !== 'claimed') throw new Error('expected a fresh claim');
      expect(await ledger.release(first.entry)).toBe(true);

      expect(
        await throwingRejectionOf(ledger.complete(first.entry, { status: 'running' })),
      ).toThrow(/no longer pending/);
      expect(await ledger.read(identity())).toBeUndefined();

      const second = await ledger.claim(identity(), 'digest-a', { runId: 'run-2' });
      if (second.outcome !== 'claimed') throw new Error('expected a fresh claim');
      expect(
        await throwingRejectionOf(ledger.complete(first.entry, { status: 'running' })),
      ).toThrow(/no longer pending/);
      expect(await ledger.read(identity())).toEqual(second.entry);
    } finally {
      await fixture.dispose();
    }
  });

  it('re-reads and resolves against a concurrent claim that wins the compare-and-swap', async () => {
    const { fixture, kv, runtime } = memoryLedger();
    try {
      // The competitor's claim lands between this attempt's read and its
      // write, so its first compare-and-swap fails and it must re-read.
      let raced = false;
      let failedSwaps = 0;
      const racing: ConditionalTextValueStore = {
        ...kv,
        async conditionalBatch(conditions, operations) {
          if (!raced && conditions[0]?.key.includes(':entry:') === true) {
            raced = true;
            const competitor = createCommandLedger<TestClaim, TestResult>({
              kv,
              clock: runtime.clock,
              nextConflictId: () => runtime.identifiers.next('ledger-conflict'),
            });
            await competitor.claim(identity(), 'digest-a', { runId: 'run-competitor' });
          }
          const committed = await kv.conditionalBatch(conditions, operations);
          if (!committed) failedSwaps += 1;
          return committed;
        },
      };
      const ledger = createCommandLedger<TestClaim, TestResult>({
        kv: racing,
        clock: runtime.clock,
        nextConflictId: () => runtime.identifiers.next('ledger-conflict'),
      });

      const outcome = await ledger.claim(identity(), 'digest-a', { runId: 'run-mine' });

      expect(failedSwaps).toBe(1);
      expect(outcome).toMatchObject({
        outcome: 'existing',
        entry: { state: 'pending', claim: { runId: 'run-competitor' } },
      });
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

  it('fails closed on an entry whose timestamp does not parse, and never prunes it', async () => {
    const { fixture, kv, ledger, runtime } = memoryLedger();
    try {
      const first = await ledger.claim(identity(), 'digest-a', { runId: 'run-1' });
      if (first.outcome !== 'claimed') throw new Error('expected a fresh claim');
      const [key] = await kv.list('');
      const corrupted = JSON.stringify({ ...first.entry, claimedAt: 'not a time' });
      await kv.set(key!, corrupted);
      runtime.setTime(Date.parse(ORIGIN) + 365 * 24 * 60 * 60 * 1000);

      expect(
        await throwingRejectionOf(ledger.claim(identity(), 'digest-a', { runId: 'run-2' })),
      ).toThrow(/unreadable/);
      expect(await ledger.prune()).toEqual({ entries: 0, conflicts: 0 });
      expect(await kv.get(key!)).toBe(corrupted);
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

const CLAIM: RunCreationClaim = { runId: 'run-1', sessionId: 'session-1' };

function runCreationLedger(observe: (claim: RunCreationClaim) => Promise<RunCreationObservation>) {
  const fixture = createMemoryStorageFixture();
  const kv = textValueStore(fixture.storage, { disposeUnderlyingStorage: false });
  const runtime = createManualRuntimeServices({ origin: ORIGIN });
  const ledger = createRunCreationLedger({
    kv,
    clock: runtime.clock,
    identifiers: runtime.identifiers,
    observe,
  });
  return { fixture, kv, runtime, ledger };
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
        agentName: 'bureau',
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
        agentName: 'bureau',
        requestId: 'request-1',
        payloadDigest: 'digest-a',
        claim: CLAIM,
      });
      if (attempt.kind !== 'claimed') throw new Error('expected a fresh claim');
      const created = await attempt.complete(summary());
      live = summary({ status: 'completed', steps: 1 });

      const retry = await ledger.begin({
        callerId: 'alice',
        agentName: 'bureau',
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
        agentName: 'bureau',
        requestId: 'request-1',
        payloadDigest: 'digest-a',
        claim: CLAIM,
      });
      if (attempt.kind !== 'claimed') throw new Error('expected a fresh claim');
      const created = await attempt.complete(summary());

      const retry = await ledger.begin({
        callerId: 'alice',
        agentName: 'bureau',
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
        agentName: 'bureau',
        requestId: 'request-1',
        payloadDigest: 'digest-a',
        claim: CLAIM,
      });
      if (first.kind !== 'claimed') throw new Error('expected a fresh claim');

      const retry = ledger.begin({
        callerId: 'alice',
        agentName: 'bureau',
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
        agentName: 'bureau',
        requestId: 'request-1',
        payloadDigest: 'digest-a',
        claim: CLAIM,
      });
      if (first.kind !== 'claimed') throw new Error('expected a fresh claim');
      const retry = ledger.begin({
        callerId: 'alice',
        agentName: 'bureau',
        requestId: 'request-1',
        payloadDigest: 'digest-a',
        claim: { ...CLAIM, runId: 'run-2' },
      });

      // Let the retry find the pending entry and start waiting on it.
      for (let turn = 0; turn < 10; turn++) await Promise.resolve();
      const failure = new Error('session store unavailable');
      await first.release(failure);
      expect(await rejectionOf(retry)).toBe(failure);

      const again = await ledger.begin({
        callerId: 'alice',
        agentName: 'bureau',
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
    const kv = textValueStore(fixture.storage, { disposeUnderlyingStorage: false });
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
        agentName: 'bureau',
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
        agentName: 'bureau',
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
        agentName: 'bureau',
        requestId: 'request-1',
        payloadDigest: 'digest-a',
        claim: CLAIM,
      });
      if (first.kind !== 'claimed') throw new Error('expected a fresh claim');

      const conflict = await rejectionOf(
        ledger.begin({
          callerId: 'alice',
          agentName: 'bureau',
          requestId: 'request-1',
          payloadDigest: 'digest-b',
          claim: { ...CLAIM, runId: 'run-2' },
        }),
      );
      expect(conflict).toBeInstanceOf(BureauLedgerConflictError);
      expect(conflict).toMatchObject({ requestId: 'request-1', reason: 'payload-mismatch' });
      // The original has issued no receipt yet, so the conflict carries none.
      expect((conflict as BureauLedgerConflictError).originalReceipt).toBeUndefined();

      const created = await first.complete(summary());
      expect(created.receipt?.runId).toBe('run-1');
    } finally {
      await fixture.dispose();
    }
  });
  it('carries the original receipt on a conflict once the original is completed', async () => {
    const { fixture, ledger } = runCreationLedger(notObserved);
    try {
      const first = await ledger.begin(beginInput());
      if (first.kind !== 'claimed') throw new Error('expected a fresh claim');
      const created = await first.complete(summary());

      const conflict = await rejectionOf(ledger.begin(beginInput({ payloadDigest: 'digest-b' })));

      expect(conflict).toBeInstanceOf(BureauLedgerConflictError);
      expect((conflict as BureauLedgerConflictError).originalReceipt).toEqual(created.receipt);
    } finally {
      await fixture.dispose();
    }
  });

  it('attaches no receipt to a conflict when the binding it conflicted with was replaced', async () => {
    const fixture = createMemoryStorageFixture();
    const kv = textValueStore(fixture.storage, { disposeUnderlyingStorage: false });
    const runtime = createManualRuntimeServices({ origin: ORIGIN });
    try {
      const options = {
        clock: runtime.clock,
        identifiers: runtime.identifiers,
        observe: notObserved,
      };
      const first = await createRunCreationLedger({ kv, ...options }).begin(beginInput());
      if (first.kind !== 'claimed') throw new Error('expected a fresh claim');
      await first.complete(summary());
      const keys = await kv.list('');
      const entryKey = keys.find((key) => key.includes(':entry:'));
      const original = JSON.parse((await kv.get(entryKey!))!) as { claimedAt: string };
      // Between the conflict being recorded and its receipt being read, the
      // original binding is replaced by another run of the same identity.
      const replacing: ConditionalTextValueStore = {
        ...kv,
        async conditionalBatch(conditions, operations) {
          const committed = await kv.conditionalBatch(conditions, operations);
          if (operations.some((operation) => operation.key.includes(':conflict:'))) {
            const replacement = JSON.parse((await kv.get(entryKey!))!) as Record<string, unknown>;
            replacement['claimedAt'] = '2026-10-14T00:00:00.000Z';
            replacement['result'] = {
              summary: summary({ id: 'run-replacement' }),
              receipt: {
                runId: 'run-replacement',
                requestId: 'request-1',
                createdAt: '2026-10-14T00:00:00.000Z',
                status: 'running',
              },
            };
            await kv.set(entryKey!, JSON.stringify(replacement));
          }
          return committed;
        },
      };

      const conflict = await rejectionOf(
        createRunCreationLedger({ kv: replacing, ...options }).begin(
          beginInput({ payloadDigest: 'digest-b' }),
        ),
      );

      expect(conflict).toBeInstanceOf(BureauLedgerConflictError);
      expect((conflict as BureauLedgerConflictError).originalClaimedAt).toBe(original.claimedAt);
      expect((conflict as BureauLedgerConflictError).originalReceipt).toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });

  it('keys the request id on the published agent, so one request id for two agents is two commands', async () => {
    const { fixture, ledger } = runCreationLedger(notObserved);
    try {
      const forBureau = await ledger.begin(beginInput());
      const forResearcher = await ledger.begin(
        beginInput({
          agentName: 'researcher',
          payloadDigest: 'digest-b',
          claim: { runId: 'run-2', sessionId: 'session-2' },
        }),
      );

      expect(forBureau.kind).toBe('claimed');
      expect(forResearcher.kind).toBe('claimed');
    } finally {
      await fixture.dispose();
    }
  });

  it('makes a concurrent retry in this process wait for the attempt that claimed first', async () => {
    const fixture = createMemoryStorageFixture();
    const kv = textValueStore(fixture.storage, { disposeUnderlyingStorage: false });
    const runtime = createManualRuntimeServices({ origin: ORIGIN });
    // The first attempt's claim lands, but its acknowledgement is held, so
    // the retry reads the pending entry before the claimant has registered.
    const acknowledgement = Promise.withResolvers<void>();
    let claimLanded = false;
    const slow: ConditionalTextValueStore = {
      ...kv,
      async conditionalBatch(conditions, operations) {
        const committed = await kv.conditionalBatch(conditions, operations);
        if (!claimLanded) {
          claimLanded = true;
          await acknowledgement.promise;
        }
        return committed;
      },
    };
    try {
      const ledger = createRunCreationLedger({
        kv: slow,
        clock: runtime.clock,
        identifiers: runtime.identifiers,
        observe: notObserved,
      });
      const firstAttempt = ledger.begin(beginInput());
      for (let turn = 0; turn < 20 && !claimLanded; turn++) await Promise.resolve();
      expect(claimLanded).toBe(true);

      const retry = ledger.begin(beginInput({ claim: { runId: 'run-2', sessionId: 'session-2' } }));
      let retrySettled = false;
      void retry.then(() => {
        retrySettled = true;
      });
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
      expect(retrySettled).toBe(false);

      acknowledgement.resolve();
      const first = await firstAttempt;
      if (first.kind !== 'claimed') throw new Error('expected the first attempt to claim');
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
      expect(retrySettled).toBe(false);

      const created = await first.complete(summary());
      expect(await retry).toEqual({ kind: 'replay', result: created });
    } finally {
      await fixture.dispose();
    }
  });

  it('records the receipt of a started run a retry observes, so every later retry receives it unchanged', async () => {
    // The after-work-start and after-effect-before-ack fault points: the run
    // started, but the process died before the ledger recorded it.
    const fixture = createMemoryStorageFixture();
    const kv = textValueStore(fixture.storage, { disposeUnderlyingStorage: false });
    const runtime = createManualRuntimeServices({ origin: ORIGIN });
    try {
      const before = createRunCreationLedger({
        kv,
        clock: runtime.clock,
        identifiers: runtime.identifiers,
        observe: notObserved,
      });
      const claimed = await before.begin(beginInput());
      expect(claimed.kind).toBe('claimed');

      let durableStatus: RunCreationObservation['durableStatus'] = 'running';
      const after = createRunCreationLedger({
        kv,
        clock: runtime.clock,
        identifiers: runtime.identifiers,
        observe: async () => ({ live: undefined, durableStatus }),
      });
      const retry = await after.begin(
        beginInput({ claim: { runId: 'run-2', sessionId: 'session-2' } }),
      );
      const receipt = {
        runId: 'run-1',
        requestId: 'request-1',
        createdAt: ORIGIN,
        status: 'running',
      };
      expect(retry).toMatchObject({ kind: 'replay', result: { id: 'run-1', receipt } });
      expect(await after.ledger.read(identity())).toMatchObject({
        state: 'completed',
        result: { receipt },
      });

      durableStatus = 'completed';
      const later = await after.begin(
        beginInput({ claim: { runId: 'run-3', sessionId: 'session-3' } }),
      );
      expect(later).toMatchObject({
        kind: 'replay',
        result: { id: 'run-1', status: 'completed', receipt },
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('names the created run when its receipt cannot be recorded, and a retry records it', async () => {
    const fixture = createMemoryStorageFixture();
    const kv = textValueStore(fixture.storage, { disposeUnderlyingStorage: false });
    const runtime = createManualRuntimeServices({ origin: ORIGIN });
    const writeFailure = new Error('storage unavailable');
    let failNextCompletion = true;
    const failing: ConditionalTextValueStore = {
      ...kv,
      async conditionalBatch(conditions, operations) {
        const completing = operations.some(
          (operation) => operation.type === 'set' && operation.value.includes('"completed"'),
        );
        if (failNextCompletion && completing) {
          failNextCompletion = false;
          throw writeFailure;
        }
        return kv.conditionalBatch(conditions, operations);
      },
    };
    try {
      let live: RunSummary | undefined;
      const ledger = createRunCreationLedger({
        kv: failing,
        clock: runtime.clock,
        identifiers: runtime.identifiers,
        observe: async () => ({ live, durableStatus: undefined }),
      });
      const attempt = await ledger.begin(beginInput());
      if (attempt.kind !== 'claimed') throw new Error('expected a fresh claim');
      live = summary();

      const failure = await rejectionOf(attempt.complete(summary()));
      expect(failure).toBeInstanceOf(RunCreationReceiptUnrecordedError);
      expect(failure).toMatchObject({
        requestId: 'request-1',
        runId: 'run-1',
        cause: writeFailure,
      });

      const retry = await ledger.begin(
        beginInput({ claim: { runId: 'run-2', sessionId: 'session-2' } }),
      );
      const receipt = {
        runId: 'run-1',
        requestId: 'request-1',
        createdAt: ORIGIN,
        status: 'running',
      };
      expect(retry).toEqual({ kind: 'replay', result: { ...summary(), receipt } });
      expect(await ledger.ledger.read(identity())).toMatchObject({
        state: 'completed',
        result: { receipt },
      });
    } finally {
      await fixture.dispose();
    }
  });
});

describe('two ledgers over one store', () => {
  it('keep their entries, claims, and pruning apart when they use different key prefixes', async () => {
    const { kv, runtime, ledger } = memoryLedger();
    const other = createCommandLedger<{ readonly threadId: string }, TestResult>({
      kv,
      keyPrefix: 'command-ledger:other:v1',
      clock: runtime.clock,
      nextConflictId: () => runtime.identifiers.next('other-conflict'),
    });
    await ledger.claim(identity(), 'digest-a', { runId: 'run-1' });
    await other.claim(identity({ requestId: 'resume-1' }), 'digest-b', { threadId: 'thread-1' });

    expect(await ledger.listClaims()).toEqual([{ runId: 'run-1' }]);
    expect(await other.listClaims()).toEqual([{ threadId: 'thread-1' }]);
    expect(await ledger.read(identity({ requestId: 'resume-1' }))).toBeUndefined();

    // Both entries are past their retention window; only this ledger's is pruned.
    await runtime.advance(COMMAND_LEDGER_DEFAULT_TERMINAL_RETENTION_MS + 1);
    expect(await ledger.prune()).toEqual({ entries: 1, conflicts: 0 });
    expect(await other.listClaims()).toEqual([{ threadId: 'thread-1' }]);
  });
});
