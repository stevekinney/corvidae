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
  createAgent,
} from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import { waitForCondition } from './test';
import { rejectionOf } from './testing/promise-outcome.test-support.ts';
import type { AgentDefinitions } from './agent-catalog';

const generate: GenerateFunction = async () => ({ content: 'Done.', toolCalls: [] });
const ALICE = 'api-key:alice';
const BOB = 'api-key:bob';
const SIDE_RECORD_PREFIX = 'session-deletion-owner:v1:';

async function openBureau() {
  const directory = await mkdtemp(join(tmpdir(), 'owner-of-record-session-expiry-'));
  const bureau = await createBureau<AgentDefinitions>({
    id: 'session-expiry',
    agents: {
      default: createAgent({ generate, stopWhen: stopWhen.noToolCalls() }),
    },
    storage: { type: 'sqlite', path: join(directory, 'bureau.sqlite') },
    durable: true,
    durableOwnership: { ownership: 'none' },
  });
  return { bureau, directory };
}

type OpenBureau = Awaited<ReturnType<typeof openBureau>>['bureau'];

async function settled(bureau: OpenBureau, principal: string, sessionId: string) {
  const run = await bureau.createRun({
    agentName: 'default',
    message: 'hello',
    sessionId,
    principal,
  });
  await waitForCondition(
    () => bureau.tasks.detail(run.id)?.status !== 'running',
    `run ${run.id} never settled`,
  );
  return run;
}

async function read(
  bureau: OpenBureau,
  sessionId: string,
  options: { principal?: string; since?: string } = {},
) {
  return bureau.contexts.events(sessionId, options);
}

function eventsOf(page: Awaited<ReturnType<typeof read>>): readonly DurableEventEnvelope[] {
  if (!('events' in page)) throw new Error(`expected events, got ${JSON.stringify(page)}`);
  return page.events;
}

const sequences = (events: readonly DurableEventEnvelope[]) =>
  events.map((event) => event.sequence);

/** Expires every session, whatever its age: a negative age keeps nothing. */
async function expireEverything(bureau: OpenBureau): Promise<number> {
  return bureau.internals.sessionStore!.cleanup({ olderThan: -60_000 });
}

describe('the task history of an expired session (COR-1481)', () => {
  it('erases the originating message of each task of the session, as deleting the context does, and keeps the task', async () => {
    const { bureau, directory } = await openBureau();
    try {
      const run = await settled(bureau, ALICE, 'expiring-context');
      const before = await bureau.internals.taskRegistry.history(run.id);
      expect(before?.map((message) => message.text)).toEqual(['hello']);

      expect(await expireEverything(bureau)).toBe(1);

      expect(await bureau.internals.sessionStore!.load('expiring-context')).toBeUndefined();
      expect(await bureau.internals.taskRegistry.history(run.id)).toEqual([]);
      expect(await bureau.internals.taskRegistry.get(run.id)).toMatchObject({
        id: run.id,
        owner: ALICE,
      });
    } finally {
      await bureau.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('the history of an expired session (COR-718)', () => {
  it('shows the next owner of an expired id none of the former owner’s events on a page', async () => {
    const { bureau, directory } = await openBureau();
    try {
      await settled(bureau, ALICE, 'expired');
      const former = eventsOf(await read(bureau, 'expired'));
      const lastFormer = Math.max(...sequences(former));

      expect(await expireEverything(bureau)).toBe(1);
      expect(await bureau.internals.sessionStore!.load('expired')).toBeUndefined();

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
      const subscription = bureau.contexts.subscribeEvents(
        'expired-sub',
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
        const entries = await bureau.internals.auditTrail?.query({
          runId,
          type: 'session.deleted',
        });
        return entries?.length === 1;
      }, 'the audit trail never held the expiry');
      const [entry] =
        (await bureau.internals.auditTrail?.query({ runId, type: 'session.deleted' })) ?? [];
      expect(entry?.detail).toMatchObject({ sessionId: 'audited', owner: ALICE });
      expect(await bureau.getOwner({ kind: 'audit', runId, detail: entry?.detail })).toBe(ALICE);
      await waitForCondition(async () => {
        const remaining = await bureau.internals.kv?.list(SIDE_RECORD_PREFIX);
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
      const kv = bureau.internals.kv!;
      const originalSet = kv.set.bind(kv);
      kv.set = async (key: string, value: string) => {
        if (key.startsWith(SIDE_RECORD_PREFIX)) throw new Error('injected: owner store down');
        return originalSet(key, value);
      };

      const refusal = await rejectionOf(expireEverything(bureau));
      expect(refusal).toBeInstanceOf(Error);
      expect(await bureau.internals.sessionStore!.load('kept')).toBeDefined();
      const pending = await bureau.internals.sessionStore!.outbox.pending();
      expect(pending.filter((entry) => entry.kind === 'session.deleted')).toEqual([]);

      // Once the store is back, the same expiry goes through.
      kv.set = originalSet;
      expect(await expireEverything(bureau)).toBe(1);
      expect(await bureau.internals.sessionStore!.load('kept')).toBeUndefined();
    } finally {
      await bureau.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('never shows a principal an event that records no incarnation, and shows one that records the live incarnation', async () => {
    const { bureau, directory } = await openBureau();
    try {
      const run = await settled(bureau, ALICE, 'stamped');
      const live = await bureau.internals.sessionStore!.load('stamped');
      // `Store.recordAction` is the one way a `session.*` action reaches the
      // durable producer today; the action's detail is what it knows about the
      // session, so the incarnation comes from there or not at all.
      bureau.internals.store.recordAction(run.id, 'session.loaded', {
        sessionId: 'stamped',
        agentName: 'agent',
      });
      bureau.internals.store.recordAction(run.id, 'session.loaded', {
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

/**
 * The first generate call (the former owner's run) waits until released; every
 * later call answers at once.
 */
function gatedGenerate() {
  let calls = 0;
  const release = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();
  const generate: GenerateFunction = async () => {
    calls += 1;
    if (calls === 1) {
      reached.resolve();
      await release.promise;
      return { content: 'ALICE-SECRET-REPLY', toolCalls: [] };
    }
    return { content: 'bob reply', toolCalls: [] };
  };
  return { generate, release, reached };
}

type AnyBureau = Awaited<ReturnType<typeof createBureau>>;

/**
 * Alice's run is in flight when its session expires and Bob recreates the id.
 * Alice's run must settle without writing a word into Bob's session.
 */
async function expiryDuringRun(open: (generate: GenerateFunction) => Promise<AnyBureau>) {
  const { generate, release, reached } = gatedGenerate();
  const bureau = await open(generate);
  try {
    const aliceRun = await bureau.createRun({
      agentName: 'default',
      message: 'ALICE-SECRET-PROMPT',
      sessionId: 'shared',
      principal: ALICE,
    });
    await reached.promise;
    const aliceIncarnation = (await bureau.internals.sessionStore!.load('shared'))!.incarnation;

    // The session store knows nothing of runs: the expiry is Bureau's to handle.
    expect(await bureau.internals.sessionStore!.cleanup({ olderThan: -60_000 })).toBe(1);
    const bobRun = await bureau.createRun({
      agentName: 'default',
      message: 'bob prompt',
      sessionId: 'shared',
      principal: BOB,
    });
    await waitForCondition(
      () => bureau.tasks.detail(bobRun.id)?.status !== 'running',
      'bob never settled',
    );
    const bobIncarnation = (await bureau.internals.sessionStore!.load('shared'))!.incarnation;
    expect(bobIncarnation).not.toBe(aliceIncarnation);

    release.resolve();
    await waitForCondition(
      () => bureau.tasks.detail(aliceRun.id)?.status !== 'running',
      'alice never settled',
    );
    // Alice's terminal save, if one was started, was queued on the store before her
    // run left `running`; this update lands behind it.
    await bureau.internals.sessionStore!.update('shared', (session) => session);

    const session = await bureau.contexts.get('shared');
    expect(session?.incarnation).toBe(bobIncarnation);
    expect(JSON.stringify(session)).not.toContain('ALICE-SECRET');
    expect(await bureau.getOwner({ kind: 'session', id: 'shared' })).toBe(BOB);
    expect(bureau.tasks.detail(aliceRun.id)?.status).toBe('aborted');
  } finally {
    release.resolve();
    await bureau.dispose();
  }
}

describe('a run whose session expired and was recreated while it ran (COR-718)', () => {
  it('writes nothing into the new owner’s session on a KV-only Bureau, and settles as aborted', async () => {
    await expiryDuringRun((generate) =>
      createBureau<AgentDefinitions>({
        agents: {
          default: createAgent({ generate, stopWhen: stopWhen.noToolCalls() }),
        },
        storage: { type: 'memory' },
        durable: false,
      }),
    );
  });

  it('writes nothing into the new owner’s session on a durable Bureau either', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'owner-of-record-session-expiry-durable-'));
    try {
      await expiryDuringRun((generate) =>
        createBureau<AgentDefinitions>({
          id: 'session-expiry',
          agents: {
            default: createAgent({ generate, stopWhen: stopWhen.noToolCalls() }),
          },
          storage: { type: 'sqlite', path: join(directory, 'bureau.sqlite') },
          durable: true,
          durableOwnership: { ownership: 'none' },
        }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
