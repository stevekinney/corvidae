import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { createAgentSession, createSessionStore, type SessionStore } from '@lostgradient/operative';
import {
  type ConditionalTextValueStore,
  resolveStorage,
  type Storage,
  textValueStore,
  type TextValueStoreBatchOperation,
  type TextValueStoreCondition,
} from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import {
  admitSessionInput,
  createSessionInputMailbox,
  type SessionInputAdmissionAttempt,
} from './session-input-durability';
import {
  claimSessionInputDeliveries,
  promoteSessionInputs,
  readSessionInputPromotion,
  SESSION_INPUT_DELIVERIES_METADATA_KEY,
  SESSION_INPUT_DELIVERY_RETENTION_MS,
  SESSION_INPUT_PROMOTION_OUTBOX_NAMESPACE,
} from './session-input-promotion';
import { throwingRejectionOf } from './testing/promise-outcome.test-support.ts';

/**
 * COR-435 AC6/AC7, COR-1476 — the delivery record's own crash-safety contract,
 * tested directly against `SessionStore` rather than through a full `Bureau`.
 * See `session-input-promotion.ts`'s module doc for why AC6's literal
 * `ctx.memo` wording does not apply here and what replaces it, and for the
 * argument that each crash window below is safe.
 *
 * Scope note: this file proves the record's OWN atomicity and idempotency. The
 * trigger that decides WHEN to claim and promote an input at a run's next step
 * boundary lives in `packages/operative`'s run workflow and is covered by
 * `run-workflow-session-input.test.ts` there.
 */

const FIXED_NOW_ISO = '2026-01-01T00:00:00.000Z';
const fixedNowISO = () => FIXED_NOW_ISO;

async function createFixture(): Promise<{
  storage: Storage;
  sessionStore: SessionStore;
  sessionId: string;
}> {
  const storage = await resolveStorage({ type: 'memory' });
  const sessionStore = createSessionStore(textValueStore(storage));
  const sessionId = 'promotion-session';
  await sessionStore.save(
    createAgentSession({
      id: sessionId,
      agentName: 'agent',
      conversationHistory: createConversationHistory({ id: sessionId }),
    }),
  );
  return { storage, sessionStore, sessionId };
}

const COMMAND = 'command-1';

function deliveryFor(commandId = COMMAND, id = 'input-1') {
  return { id, commandId, conversationMessageId: `message-for-${commandId}`, providerTurn: 0 };
}

/**
 * Filters a `SessionStore.outbox.pending()` listing down to this module's
 * own attachments. `sessionStore.save()` in `createFixture()` already
 * appends its own `'session.created'` entry, so raw `pending().length`
 * is not a meaningful assertion anywhere in this file.
 */
function promotionAttachments(
  entries: Awaited<ReturnType<SessionStore['outbox']['pending']>>,
): readonly unknown[] {
  return entries.filter(
    (entry) =>
      entry.kind === 'session.attachment' &&
      entry.namespace === SESSION_INPUT_PROMOTION_OUTBOX_NAMESPACE,
  );
}

/**
 * Wraps a `ConditionalTextValueStore` so its `conditionalBatch` throws for
 * the first `failCount` calls, then behaves normally — simulating a crash
 * during the durable write itself (crash window (a)), without any real
 * sleep or wall-clock dependency.
 */
function withFaultyConditionalBatch(
  base: ConditionalTextValueStore,
  failCount: number,
): ConditionalTextValueStore {
  let calls = 0;
  return {
    ...base,
    async conditionalBatch(
      conditions: TextValueStoreCondition[],
      operations: TextValueStoreBatchOperation[],
    ) {
      calls += 1;
      if (calls <= failCount) {
        throw new Error('simulated crash before the promotion batch commits');
      }
      return base.conditionalBatch(conditions, operations);
    },
  };
}

describe('claimSessionInputDeliveries (COR-1476)', () => {
  it('gives a command to the first run to claim it and never to a second', async () => {
    const { sessionStore, sessionId } = await createFixture();

    const first = await claimSessionInputDeliveries(
      sessionStore,
      sessionId,
      'run-1',
      [COMMAND, 'command-2'],
      fixedNowISO,
    );
    expect([...first]).toEqual([
      [COMMAND, 'claimed'],
      ['command-2', 'claimed'],
    ]);

    // The claiming run's own replay finds its claim, and delivers again.
    const replay = await claimSessionInputDeliveries(
      sessionStore,
      sessionId,
      'run-1',
      [COMMAND],
      fixedNowISO,
    );
    expect(replay.get(COMMAND)).toBe('owned');

    // Another run, or a run recovering a crashed peer, must not append it.
    const other = await claimSessionInputDeliveries(
      sessionStore,
      sessionId,
      'run-2',
      [COMMAND],
      fixedNowISO,
    );
    expect(other.get(COMMAND)).toBe('foreign');

    const session = await sessionStore.load(sessionId);
    expect(session?.metadata[SESSION_INPUT_DELIVERIES_METADATA_KEY]).toEqual({
      [COMMAND]: { runId: 'run-1', claimedAt: FIXED_NOW_ISO },
      'command-2': { runId: 'run-1', claimedAt: FIXED_NOW_ISO },
    });
  });

  it('reports a promoted command as promoted whichever run asks', async () => {
    const { sessionStore, sessionId } = await createFixture();
    await claimSessionInputDeliveries(sessionStore, sessionId, 'run-1', [COMMAND], fixedNowISO);
    await promoteSessionInputs(sessionStore, sessionId, 'run-1', [deliveryFor()], fixedNowISO);

    for (const owner of ['run-1', 'run-2']) {
      const outcomes = await claimSessionInputDeliveries(
        sessionStore,
        sessionId,
        owner,
        [COMMAND],
        fixedNowISO,
      );
      expect(outcomes.get(COMMAND)).toBe('promoted');
    }
  });

  it('throws for a session that no longer exists', async () => {
    const { sessionStore } = await createFixture();
    const attempt = claimSessionInputDeliveries(
      sessionStore,
      'no-such-session',
      'run-1',
      [COMMAND],
      fixedNowISO,
    );
    expect(await throwingRejectionOf(attempt)).toThrow('no longer exists');
  });

  it('prunes records past retention on the next write, so session metadata does not grow forever', async () => {
    const { sessionStore, sessionId } = await createFixture();
    await claimSessionInputDeliveries(sessionStore, sessionId, 'run-1', ['old'], fixedNowISO);
    await promoteSessionInputs(
      sessionStore,
      sessionId,
      'run-1',
      [deliveryFor('old', 'old-input')],
      fixedNowISO,
    );

    const later = () =>
      new Date(Date.parse(FIXED_NOW_ISO) + SESSION_INPUT_DELIVERY_RETENTION_MS + 1).toISOString();
    await claimSessionInputDeliveries(sessionStore, sessionId, 'run-1', ['new'], later);

    const session = await sessionStore.load(sessionId);
    expect(Object.keys(session?.metadata[SESSION_INPUT_DELIVERIES_METADATA_KEY] as object)).toEqual(
      ['new'],
    );
  });
});

describe('promoteSessionInputs (COR-435 AC6/AC7, COR-1476)', () => {
  it('commits the promotion atomically with exactly one session outbox entry per command (AC6, reframed)', async () => {
    const { sessionStore, sessionId } = await createFixture();
    await claimSessionInputDeliveries(sessionStore, sessionId, 'run-1', [COMMAND], fixedNowISO);

    await promoteSessionInputs(sessionStore, sessionId, 'run-1', [deliveryFor()], fixedNowISO);

    const session = await sessionStore.load(sessionId);
    expect(readSessionInputPromotion(session?.metadata ?? {}, COMMAND)).toEqual({
      promotedAt: FIXED_NOW_ISO,
      conversationMessageId: `message-for-${COMMAND}`,
      providerTurn: 0,
    });
    const attachments = promotionAttachments(await sessionStore.outbox.pending());
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      payload: {
        sessionId,
        id: 'input-1',
        commandId: COMMAND,
        conversationMessageId: `message-for-${COMMAND}`,
        providerTurn: 0,
      },
    });
  });

  it('throws for an unknown session, writing nothing', async () => {
    const { sessionStore } = await createFixture();
    const attempt = promoteSessionInputs(
      sessionStore,
      'no-such-session',
      'run-1',
      [deliveryFor()],
      fixedNowISO,
    );
    expect(await throwingRejectionOf(attempt)).toThrow('no longer exists');
    expect(promotionAttachments(await sessionStore.outbox.pending())).toHaveLength(0);
  });

  it('crash window (a): a write that fails before the batch commits leaves nothing durable, and a clean retry commits exactly once', async () => {
    const { storage, sessionId } = await createFixture();

    const faultySessionStore = createSessionStore(
      withFaultyConditionalBatch(textValueStore(storage), 1),
    );
    const attempt = promoteSessionInputs(
      faultySessionStore,
      sessionId,
      'run-1',
      [deliveryFor()],
      fixedNowISO,
    );
    expect(await throwingRejectionOf(attempt)).toThrow(
      'simulated crash before the promotion batch commits',
    );

    const realSessionStore = createSessionStore(textValueStore(storage));
    const afterFailure = await realSessionStore.load(sessionId);
    expect(readSessionInputPromotion(afterFailure?.metadata ?? {}, COMMAND)).toBeUndefined();
    expect(promotionAttachments(await realSessionStore.outbox.pending())).toHaveLength(0);

    await promoteSessionInputs(realSessionStore, sessionId, 'run-1', [deliveryFor()], fixedNowISO);
    const afterRetry = await realSessionStore.load(sessionId);
    expect(readSessionInputPromotion(afterRetry?.metadata ?? {}, COMMAND)).toBeDefined();
    expect(promotionAttachments(await realSessionStore.outbox.pending())).toHaveLength(1);
  });

  it('crash window (b): re-promoting after the batch committed changes nothing and appends no second outbox entry', async () => {
    const { sessionStore, sessionId } = await createFixture();
    await promoteSessionInputs(sessionStore, sessionId, 'run-1', [deliveryFor()], fixedNowISO);
    const first = await sessionStore.load(sessionId);

    // The caller does not know whether its first call landed, so it calls again,
    // later, and the stamp it finds is the first one.
    const later = () => '2026-01-02T00:00:00.000Z';
    await promoteSessionInputs(sessionStore, sessionId, 'run-1', [deliveryFor()], later);

    const second = await sessionStore.load(sessionId);
    expect(readSessionInputPromotion(second?.metadata ?? {}, COMMAND)).toEqual(
      readSessionInputPromotion(first?.metadata ?? {}, COMMAND),
    );
    expect(promotionAttachments(await sessionStore.outbox.pending())).toHaveLength(1);
  });
});

describe("a replay's receipt follows the command, not the caller's id (COR-1476)", () => {
  function attemptFor(
    fixture: Awaited<ReturnType<typeof createFixture>>,
    mailbox: ReturnType<typeof createSessionInputMailbox>,
    nowMs: number,
  ): SessionInputAdmissionAttempt {
    return {
      storage: fixture.storage,
      kv: textValueStore(fixture.storage),
      sessionStore: fixture.sessionStore,
      sessionMailbox: mailbox,
      sessionId: fixture.sessionId,
      id: 'input-1',
      principal: 'alice',
      deliveryMode: 'steer',
      payload: { incarnation: 'incarnation-1', payload: 'hello' },
      principalBacklogLimit: 100,
      sessionBacklogLimitForCrossSessionRead: 100,
      nowMs,
    };
  }

  it('a replay of an already-promoted command reports state: promoted, not accepted/queued (coordinator-ruled correctness fix)', async () => {
    // Regression: `buildReceipt` used to derive `state` from `deliveryMode`
    // alone, so a caller idempotently retrying `(principal, id)` after its input
    // was promoted was told the input was still `accepted`.
    const fixture = await createFixture();
    const runtime = createManualRuntimeServices({ identifierSeed: 'session-input-promotion' });
    const mailbox = createSessionInputMailbox(fixture.storage, fixture.sessionId, 100);

    const admitted = await admitSessionInput(attemptFor(fixture, mailbox, runtime.clock.now()));
    expect(admitted.outcome).toBe('admitted');
    if (admitted.outcome !== 'admitted') return;
    expect(admitted.receipt.state).toBe('accepted');

    const [receipt] = await mailbox.list({ limit: 10 });
    await promoteSessionInputs(
      fixture.sessionStore,
      fixture.sessionId,
      'run-1',
      [deliveryFor(receipt!.commandId)],
      fixedNowISO,
    );

    const replay = await admitSessionInput(attemptFor(fixture, mailbox, runtime.clock.now()));
    expect(replay.outcome).toBe('replayed');
    if (replay.outcome === 'replayed') expect(replay.receipt.state).toBe('promoted');
  });

  it("a caller's reused id, admitted fresh after the mailbox retired the old record, is not reported delivered", async () => {
    const fixture = await createFixture();
    let now = Date.parse(FIXED_NOW_ISO);
    const mailbox = createSessionInputMailbox(fixture.storage, fixture.sessionId, 100, () => now);

    const first = await admitSessionInput(attemptFor(fixture, mailbox, now));
    expect(first.outcome).toBe('admitted');
    const [original] = await mailbox.list({ limit: 10 });
    await claimSessionInputDeliveries(
      fixture.sessionStore,
      fixture.sessionId,
      'run-1',
      [original!.commandId],
      fixedNowISO,
    );
    await promoteSessionInputs(
      fixture.sessionStore,
      fixture.sessionId,
      'run-1',
      [deliveryFor(original!.commandId)],
      fixedNowISO,
    );
    const claimed = await mailbox.claim();
    if (claimed.status !== 'claimed') throw new Error('expected a claim');
    await mailbox.acknowledge({
      commandId: claimed.claim.receipt.commandId,
      attemptToken: claimed.claim.attemptToken,
    });

    // Past the one-day identity TTL and terminal retention the id is reusable.
    now += 2 * 86_400_000;
    await mailbox.runMaintenance();
    const reused = await admitSessionInput(attemptFor(fixture, mailbox, now));
    expect(reused.outcome).toBe('admitted');
    if (reused.outcome === 'admitted') expect(reused.receipt.state).toBe('accepted');
  });

  it.each([
    ['a deadline passes', 8 * 86_400_000, 'expired'],
    ['the command is cancelled', 0, 'canceled'],
  ] as const)('reports an honest terminal state when %s', async (_name, advance, expected) => {
    const fixture = await createFixture();
    let now = Date.parse(FIXED_NOW_ISO);
    const mailbox = createSessionInputMailbox(fixture.storage, fixture.sessionId, 100, () => now);

    const admitted = await admitSessionInput(attemptFor(fixture, mailbox, now));
    expect(admitted.outcome).toBe('admitted');
    const [receipt] = await mailbox.list({ limit: 10 });
    if (advance === 0) {
      await mailbox.requestCancellation({ commandId: receipt!.commandId, reason: 'test' });
    } else {
      now += advance;
      await mailbox.runMaintenance();
    }

    const replay = await admitSessionInput(attemptFor(fixture, mailbox, now));
    expect(replay.outcome).toBe('replayed');
    if (replay.outcome === 'replayed') expect(replay.receipt.state).toBe(expected);
  });
});
