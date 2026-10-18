/**
 * COR-718 — an expired session's durable history. `SessionStore.cleanup()` is
 * the documented expiry primitive, reachable from the public `bureau.sessionStore`,
 * and it removes a session without going through `deleteSession`. Its history
 * must still close to a principal that later recreates the id, and its deletion
 * must still be audited with the owner the session had.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type DurableEventEnvelope,
  type GenerateFunction,
  stopWhen,
} from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import { waitForCondition } from './test';
import { rejectionOf } from './testing/promise-outcome.test-support.ts';

const generate: GenerateFunction = async () => ({ content: 'Done.', toolCalls: [] });
const ALICE = 'api-key:alice';
const BOB = 'api-key:bob';
const SIDE_RECORD_PREFIX = 'session-deletion-owner:v1:';

async function openBureau() {
  const directory = await mkdtemp(join(tmpdir(), 'owner-of-record-session-expiry-'));
  const bureau = await createBureau({
    id: 'session-expiry',
    agents: {},
    generate,
    storage: { type: 'sqlite', path: join(directory, 'bureau.sqlite') },
    durableExecution: true,
    durableOwnership: { ownership: 'none' },
    stopWhen: stopWhen.noToolCalls(),
  });
  return { bureau, directory };
}

type OpenBureau = Awaited<ReturnType<typeof openBureau>>['bureau'];

async function settled(bureau: OpenBureau, principal: string, sessionId: string) {
  const run = await bureau.createRun({ message: 'hello', sessionId, principal });
  await waitForCondition(
    () => bureau.getRun(run.id)?.status !== 'running',
    `run ${run.id} never settled`,
  );
  return run;
}

async function read(
  bureau: OpenBureau,
  sessionId: string,
  options: { principal?: string; since?: string } = {},
) {
  return bureau.eventHistory({ kind: 'session', id: sessionId }, options);
}

function eventsOf(page: Awaited<ReturnType<typeof read>>): readonly DurableEventEnvelope[] {
  if (!('events' in page)) throw new Error(`expected events, got ${JSON.stringify(page)}`);
  return page.events;
}

const sequences = (events: readonly DurableEventEnvelope[]) =>
  events.map((event) => event.sequence);

/** Expires every session, whatever its age: a negative age keeps nothing. */
async function expireEverything(bureau: OpenBureau): Promise<number> {
  return bureau.sessionStore!.cleanup({ olderThan: -60_000 });
}

describe('the history of an expired session (COR-718)', () => {
  it('shows the next owner of an expired id none of the former owner’s events on a page', async () => {
    const { bureau, directory } = await openBureau();
    try {
      await settled(bureau, ALICE, 'expired');
      const former = eventsOf(await read(bureau, 'expired'));
      const lastFormer = Math.max(...sequences(former));

      expect(await expireEverything(bureau)).toBe(1);
      expect(await bureau.sessionStore!.load('expired')).toBeUndefined();

      await settled(bureau, BOB, 'expired');
      const asBob = eventsOf(await read(bureau, 'expired', { principal: BOB }));
      const sinceStart = eventsOf(
        await read(bureau, 'expired', { principal: BOB, since: former[0]!.cursor }),
      );

      expect(asBob.length).toBeGreaterThan(0);
      expect(asBob.filter((event) => event.sequence <= lastFormer)).toEqual([]);
      expect(sequences(sinceStart)).toEqual(sequences(asBob));
      // A trusted call still reads both incarnations.
      expect(Math.min(...sequences(eventsOf(await read(bureau, 'expired'))))).toBeLessThanOrEqual(
        lastFormer,
      );
    } finally {
      await bureau.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('delivers the next owner of an expired id none of the former owner’s events on a subscription', async () => {
    const { bureau, directory } = await openBureau();
    try {
      await settled(bureau, ALICE, 'expired-sub');
      const former = eventsOf(await read(bureau, 'expired-sub'));
      const lastFormer = Math.max(...sequences(former));
      expect(await expireEverything(bureau)).toBe(1);
      await settled(bureau, BOB, 'expired-sub');
      const own = eventsOf(await read(bureau, 'expired-sub', { principal: BOB }));

      const received: DurableEventEnvelope[] = [];
      const subscription = bureau.subscribeEventHistory(
        { kind: 'session', id: 'expired-sub' },
        (event) => {
          received.push(event);
        },
        { principal: BOB },
      );
      try {
        await waitForCondition(
          () => received.some((event) => event.sequence === Math.max(...sequences(own))),
          "Bob's own events never arrived",
        );
        expect(received.filter((event) => event.sequence <= lastFormer)).toEqual([]);
        expect(sequences(received)).toEqual(sequences(own));
      } finally {
        subscription.unsubscribe();
      }
    } finally {
      await bureau.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('records the expiry as a deletion: a trusted read sees the deleted aggregate, and the audit entry carries the owner', async () => {
    const { bureau, directory } = await openBureau();
    try {
      await settled(bureau, ALICE, 'audited');
      expect(await expireEverything(bureau)).toBe(1);
      await bureau.runDurableMaintenance();

      const trusted = await read(bureau, 'audited');
      expect(trusted).toMatchObject({ outcome: 'deleted-aggregate' });
      expect(await read(bureau, 'audited', { principal: ALICE })).toEqual({
        outcome: 'not-found',
      });

      const runId = 'session:audited';
      await waitForCondition(async () => {
        const entries = await bureau.auditTrail?.query({ runId, type: 'session.deleted' });
        return entries?.length === 1;
      }, 'the audit trail never held the expiry');
      const [entry] = (await bureau.auditTrail?.query({ runId, type: 'session.deleted' })) ?? [];
      expect(entry?.detail).toMatchObject({ sessionId: 'audited', owner: ALICE });
      expect(await bureau.getOwner({ kind: 'audit', runId, detail: entry?.detail })).toBe(ALICE);
      await waitForCondition(async () => {
        const remaining = await bureau.kv?.list(SIDE_RECORD_PREFIX);
        return remaining?.length === 0;
      }, 'the side record outlived the audit entry');
    } finally {
      await bureau.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('expires nothing when the owner of an expiring session cannot be recorded', async () => {
    const { bureau, directory } = await openBureau();
    try {
      await settled(bureau, ALICE, 'kept');
      const kv = bureau.kv!;
      const originalSet = kv.set.bind(kv);
      kv.set = async (key: string, value: string) => {
        if (key.startsWith(SIDE_RECORD_PREFIX)) throw new Error('injected: owner store down');
        return originalSet(key, value);
      };

      const refusal = await rejectionOf(expireEverything(bureau));
      expect(refusal).toBeInstanceOf(Error);
      expect(await bureau.sessionStore!.load('kept')).toBeDefined();
      const pending = await bureau.sessionStore!.outbox.pending();
      expect(pending.filter((entry) => entry.kind === 'session.deleted')).toEqual([]);

      // Once the store is back, the same expiry goes through.
      kv.set = originalSet;
      expect(await expireEverything(bureau)).toBe(1);
      expect(await bureau.sessionStore!.load('kept')).toBeUndefined();
    } finally {
      await bureau.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('never shows a principal an event that records no incarnation, and shows one that records the live incarnation', async () => {
    const { bureau, directory } = await openBureau();
    try {
      const run = await settled(bureau, ALICE, 'stamped');
      const live = await bureau.sessionStore!.load('stamped');
      // `Store.recordAction` is the one way a `session.*` action reaches the
      // durable producer today; the action's detail is what it knows about the
      // session, so the incarnation comes from there or not at all.
      bureau.store.recordAction(run.id, 'session.loaded', {
        sessionId: 'stamped',
        agentName: 'agent',
      });
      bureau.store.recordAction(run.id, 'session.loaded', {
        sessionId: 'stamped',
        agentName: 'agent',
        incarnation: live!.incarnation,
      });
      await waitForCondition(
        async () =>
          eventsOf(await read(bureau, 'stamped')).filter((event) => event.kind === 'session.loaded')
            .length === 2,
        'the loaded actions never reached the history',
      );

      const asAlice = eventsOf(await read(bureau, 'stamped', { principal: ALICE }));
      const loaded = asAlice.filter((event) => event.kind === 'session.loaded');
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.payload).toMatchObject({ incarnation: live!.incarnation });
    } finally {
      await bureau.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
