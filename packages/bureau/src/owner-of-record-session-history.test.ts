/**
 * COR-718 — a deleted session's durable history. History is keyed by session id
 * alone, so a caller that states a principal is held to the live session's owner:
 * a deleted session reads as not found, and a recreated id shows only the events
 * recorded for the live session's own incarnation.
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
import { createFleetEventFeed, resolveStorage } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import { waitForCondition } from './test';
import type { AgentDefinitions } from './agent-catalog';

const generate: GenerateFunction = async () => ({ content: 'Done.', toolCalls: [] });
const ALICE = 'api-key:alice';
const BOB = 'api-key:bob';

async function openBureau() {
  const directory = await mkdtemp(join(tmpdir(), 'owner-of-record-session-history-'));
  const bureau = await createBureau<AgentDefinitions>({
    id: 'session-history',
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
  return bureau.eventHistory({ kind: 'session', id: sessionId }, options);
}

function eventsOf(page: Awaited<ReturnType<typeof read>>): readonly DurableEventEnvelope[] {
  if (!('events' in page)) throw new Error(`expected events, got ${JSON.stringify(page)}`);
  return page.events;
}

const sequences = (events: readonly DurableEventEnvelope[]) =>
  events.map((event) => event.sequence);

describe('the history of a deleted session (COR-718)', () => {
  it('reads as not found to any caller that states a principal, and stays whole for a trusted caller', async () => {
    const { bureau, directory } = await openBureau();
    try {
      await settled(bureau, ALICE, 'deleted');
      await bureau.contexts.delete('deleted');

      expect(await read(bureau, 'deleted', { principal: BOB })).toEqual({ outcome: 'not-found' });
      // Not even the session's former owner: the owner is not stored beyond the session.
      expect(await read(bureau, 'deleted', { principal: ALICE })).toEqual({
        outcome: 'not-found',
      });
      const trusted = await read(bureau, 'deleted');
      expect(trusted).toMatchObject({ outcome: 'deleted-aggregate' });
      expect(eventsOf(trusted).length).toBeGreaterThan(0);
    } finally {
      await bureau.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('shows a recreated id only the events of its live incarnation', async () => {
    const { bureau, directory } = await openBureau();
    try {
      await settled(bureau, ALICE, 'reused');
      await bureau.contexts.delete('reused');
      const former = eventsOf(await read(bureau, 'reused'));
      const lastFormerSequence = Math.max(...sequences(former));
      const firstFormerCursor = former[0]!.cursor;
      await settled(bureau, BOB, 'reused');

      const everything = eventsOf(await read(bureau, 'reused', { principal: BOB }));
      const sinceBeforeMarker = eventsOf(
        await read(bureau, 'reused', { principal: BOB, since: firstFormerCursor }),
      );
      const trusted = eventsOf(await read(bureau, 'reused'));

      expect(everything.length).toBeGreaterThan(0);
      expect(Math.min(...sequences(everything))).toBeGreaterThan(lastFormerSequence);
      expect(sequences(sinceBeforeMarker)).toEqual(sequences(everything));
      // A trusted call still sees the whole history, both incarnations.
      expect(Math.min(...sequences(trusted))).toBeLessThanOrEqual(lastFormerSequence);
      // The former owner no longer reads the id, now Bob's.
      expect(await read(bureau, 'reused', { principal: ALICE })).toEqual({ outcome: 'not-found' });
    } finally {
      await bureau.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('pages a recreated id’s live incarnation even when the page limit is small', async () => {
    const { bureau, directory } = await openBureau();
    try {
      await settled(bureau, ALICE, 'paged');
      await bureau.contexts.delete('paged');
      const lastFormerSequence = Math.max(...sequences(eventsOf(await read(bureau, 'paged'))));
      await settled(bureau, BOB, 'paged');
      const wanted = eventsOf(await read(bureau, 'paged', { principal: BOB }));

      const collected: DurableEventEnvelope[] = [];
      let since: string | undefined;
      for (;;) {
        const page = await bureau.eventHistory(
          { kind: 'session', id: 'paged' },
          { principal: BOB, limit: 1, ...(since === undefined ? {} : { since }) },
        );
        if (!('events' in page)) throw new Error(`expected events, got ${JSON.stringify(page)}`);
        collected.push(...page.events);
        if (!page.hasMore || page.nextCursor === undefined) break;
        since = page.nextCursor;
      }

      expect(Math.min(...sequences(collected))).toBeGreaterThan(lastFormerSequence);
      expect(sequences(collected)).toEqual(sequences(wanted));
    } finally {
      await bureau.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('never delivers the former incarnation’s events to a subscription on the recreated id', async () => {
    const { bureau, directory } = await openBureau();
    try {
      await settled(bureau, ALICE, 'followed');
      await bureau.contexts.delete('followed');
      const lastFormerSequence = Math.max(...sequences(eventsOf(await read(bureau, 'followed'))));
      await settled(bureau, BOB, 'followed');
      const wanted = eventsOf(await read(bureau, 'followed', { principal: BOB }));

      const received: DurableEventEnvelope[] = [];
      const subscription = bureau.subscribeEventHistory(
        { kind: 'session', id: 'followed' },
        (event) => {
          received.push(event);
        },
        { principal: BOB },
      );
      try {
        await waitForCondition(
          () => received.length >= wanted.length,
          'the subscription never replayed the current incarnation',
        );
        // Let anything still queued behind the replay arrive before judging it.
        await settled(bureau, BOB, 'followed');
        await waitForCondition(() => received.length > wanted.length, 'a live event never arrived');

        expect(Math.min(...sequences(received))).toBeGreaterThan(lastFormerSequence);
        expect(sequences(received).slice(0, wanted.length)).toEqual(sequences(wanted));
      } finally {
        subscription.unsubscribe();
      }
    } finally {
      await bureau.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('delivers nothing to a subscription on a session that does not exist, once its chain has drained', async () => {
    const { bureau, directory } = await openBureau();
    try {
      await settled(bureau, ALICE, 'gone');
      await bureau.contexts.delete('gone');
      const former = eventsOf(await read(bureau, 'gone'));
      const lastFormerSequence = Math.max(...sequences(former));

      const received: DurableEventEnvelope[] = [];
      const subscription = bureau.subscribeEventHistory(
        { kind: 'session', id: 'gone' },
        (event) => {
          received.push(event);
        },
        { principal: BOB },
      );
      try {
        // Bob's own session on a different id: its events prove his chain is live and in
        // order, so everything of Alice's queued ahead of them has been judged by now.
        const witnessReceived: DurableEventEnvelope[] = [];
        const witness = bureau.subscribeEventHistory({ kind: 'session', id: 'gone' }, (event) => {
          witnessReceived.push(event);
        });
        await waitForCondition(
          () => witnessReceived.length >= former.length,
          'the trusted replay never arrived',
        );
        witness.unsubscribe();
        // Recreate the id under Bob: his chain now sees Alice's backlog and then his own.
        await settled(bureau, BOB, 'gone');
        await waitForCondition(() => received.length > 0, "Bob's own events never arrived");

        expect(received.filter((event) => event.sequence <= lastFormerSequence)).toEqual([]);
      } finally {
        subscription.unsubscribe();
      }
    } finally {
      await bureau.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses a principal-stated read whose cursor is below the retention floor as not found, never as a gap', async () => {
    const { bureau, directory } = await openBureau();
    try {
      await settled(bureau, ALICE, 'retained');
      await bureau.contexts.delete('retained');
      const former = eventsOf(await read(bureau, 'retained'));
      const adminStorage = await resolveStorage({
        type: 'sqlite',
        path: join(directory, 'bureau.sqlite'),
      });
      const adminFeed = createFleetEventFeed(adminStorage);
      try {
        await adminFeed.retain({ beforeSequence: Math.max(...sequences(former)) + 1 });
      } finally {
        adminFeed.dispose();
        adminStorage[Symbol.dispose]();
      }

      const asBob = await read(bureau, 'retained', { principal: BOB, since: '0' });
      const asTrusted = await read(bureau, 'retained', { since: '0' });

      expect(asBob).toEqual({ outcome: 'not-found' });
      expect(asTrusted).toMatchObject({ outcome: 'gap' });
    } finally {
      await bureau.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('delivers the gap event to the owner of a live session whose cursor fell below the retention floor, and nothing to a stranger', async () => {
    const { bureau, directory } = await openBureau();
    try {
      await settled(bureau, ALICE, 'retained-live');
      const own = eventsOf(await read(bureau, 'retained-live', { principal: ALICE }));
      const adminStorage = await resolveStorage({
        type: 'sqlite',
        path: join(directory, 'bureau.sqlite'),
      });
      const adminFeed = createFleetEventFeed(adminStorage);
      try {
        // Retire the first of Alice's events, so a replay from the start opens with a gap
        // and then continues with the rest.
        await adminFeed.retain({ beforeSequence: own[0]!.sequence + 1 });
      } finally {
        adminFeed.dispose();
        adminStorage[Symbol.dispose]();
      }

      const asAlice: DurableEventEnvelope[] = [];
      const asBob: DurableEventEnvelope[] = [];
      const alice = bureau.subscribeEventHistory(
        { kind: 'session', id: 'retained-live' },
        (event) => {
          asAlice.push(event);
        },
        { principal: ALICE },
      );
      const bob = bureau.subscribeEventHistory(
        { kind: 'session', id: 'retained-live' },
        (event) => {
          asBob.push(event);
        },
        { principal: BOB },
      );
      try {
        await waitForCondition(
          () => asAlice.length >= own.length,
          "the owner's replay never arrived",
        );
        expect(asAlice[0]?.kind).toBe('history.gap');
        expect(sequences(asAlice.slice(1))).toEqual(sequences(own.slice(1)));
        expect(asBob).toEqual([]);
      } finally {
        alice.unsubscribe();
        bob.unsubscribe();
      }
    } finally {
      await bureau.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('never delivers a backlog queued under the former owner when the id is deleted and recreated mid-authorization', async () => {
    const { bureau, directory } = await openBureau();
    try {
      await settled(bureau, ALICE, 'raced');
      const lastFormerSequence = Math.max(...sequences(eventsOf(await read(bureau, 'raced'))));

      // Hold the first authorization of the subscription on the session load, so Alice's
      // first queued event is still being judged while the id is deleted and recreated.
      const store = bureau.internals.sessionStore!;
      const originalLoad = store.load.bind(store);
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let held = false;
      store.load = async (id: string) => {
        if (!held && id === 'raced') {
          held = true;
          reached.resolve();
          await release.promise;
        }
        return originalLoad(id);
      };

      const received: DurableEventEnvelope[] = [];
      const subscription = bureau.subscribeEventHistory(
        { kind: 'session', id: 'raced' },
        (event) => {
          received.push(event);
        },
        { principal: BOB },
      );
      try {
        await reached.promise;
        await bureau.contexts.delete('raced');
        await settled(bureau, BOB, 'raced');
        const ownEvents = eventsOf(await read(bureau, 'raced', { principal: BOB }));
        release.resolve();
        await waitForCondition(
          () => received.length >= ownEvents.length,
          "Bob's own events never arrived",
        );

        expect(received.filter((event) => event.sequence <= lastFormerSequence)).toEqual([]);
        expect(sequences(received)).toEqual(sequences(ownEvents));
      } finally {
        release.resolve();
        subscription.unsubscribe();
      }
    } finally {
      await bureau.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('shows the next owner only its own incarnation while the former incarnation’s deletion is still pending in the outbox', async () => {
    const { bureau, directory } = await openBureau();
    try {
      await settled(bureau, ALICE, 'pending');
      const former = eventsOf(await read(bureau, 'pending'));
      const lastFormerSequence = Math.max(...sequences(former));

      // The deletion commits, and its drain is held before it can claim the entry, so no
      // `session.deleted` event is in the history yet. The incarnation each event was
      // recorded for is what separates the two owners, not a marker between them.
      const store = bureau.internals.sessionStore!;
      const outbox = store.outbox;
      const originalClaim = outbox.claim.bind(outbox);
      const claimReached = Promise.withResolvers<void>();
      const releaseClaim = Promise.withResolvers<void>();
      let holding = true;
      (outbox as { claim: typeof outbox.claim }).claim = async (
        ...args: Parameters<typeof outbox.claim>
      ) => {
        if (holding) {
          claimReached.resolve();
          await releaseClaim.promise;
        }
        return originalClaim(...args);
      };

      const deletion = bureau.contexts.delete('pending');
      await claimReached.promise;
      expect(await store.load('pending')).toBeUndefined();
      const run = await bureau.createRun({
        agentName: 'default',
        message: 'hello',
        sessionId: 'pending',
        principal: BOB,
      });
      await waitForCondition(
        () => bureau.tasks.detail(run.id)?.status !== 'running',
        `run ${run.id} never settled`,
      );

      const page = await read(bureau, 'pending', { principal: BOB });
      const received: DurableEventEnvelope[] = [];
      const subscription = bureau.subscribeEventHistory(
        { kind: 'session', id: 'pending' },
        (event) => {
          received.push(event);
        },
        { principal: BOB },
      );
      try {
        // A trusted subscription is the proof that the replay has had time to be judged.
        const witnessed: DurableEventEnvelope[] = [];
        const witness = bureau.subscribeEventHistory(
          { kind: 'session', id: 'pending' },
          (event) => {
            witnessed.push(event);
          },
        );
        await waitForCondition(
          () => witnessed.length >= former.length,
          'the trusted replay never arrived',
        );
        witness.unsubscribe();

        // Bob's own commits queue in the outbox behind the held deletion, so his page is
        // empty for now; what matters is that nothing of Alice's is on it.
        expect(eventsOf(page).filter((event) => event.sequence <= lastFormerSequence)).toEqual([]);
        expect(received.filter((event) => event.sequence <= lastFormerSequence)).toEqual([]);

        // Once the drain proceeds, Bob's events land, and they are all he gets.
        holding = false;
        releaseClaim.resolve();
        await deletion;
        const own = eventsOf(await read(bureau, 'pending', { principal: BOB }));
        expect(own.length).toBeGreaterThan(0);
        expect(own.filter((event) => event.sequence <= lastFormerSequence)).toEqual([]);
        await waitForCondition(
          () => received.length >= own.length,
          "Bob's own events never arrived",
        );
        expect(received.filter((event) => event.sequence <= lastFormerSequence)).toEqual([]);
        expect(sequences(received).slice(0, own.length)).toEqual(sequences(own));
      } finally {
        subscription.unsubscribe();
        holding = false;
        releaseClaim.resolve();
        await deletion;
      }
    } finally {
      await bureau.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses a page read whose session was deleted and recreated while the page was read', async () => {
    const { bureau, directory } = await openBureau();
    try {
      await settled(bureau, BOB, 'swapped');
      const store = bureau.internals.sessionStore!;
      const originalLoad = store.load.bind(store);
      const reachedPostLoad = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let calls = 0;
      store.load = async (id: string) => {
        if (id === 'swapped') {
          calls += 1;
          // The first loads authorize the read; the last one, after the page is in hand, is held.
          if (calls === 2) {
            reachedPostLoad.resolve();
            await release.promise;
          }
        }
        return originalLoad(id);
      };

      const pending = read(bureau, 'swapped', { principal: BOB });
      await reachedPostLoad.promise;
      await bureau.contexts.delete('swapped');
      await settled(bureau, BOB, 'swapped');
      release.resolve();

      expect(await pending).toEqual({ outcome: 'not-found' });
    } finally {
      await bureau.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('delivers nothing to a stranger subscribed to a live session, and everything to its owner', async () => {
    const { bureau, directory } = await openBureau();
    try {
      await settled(bureau, ALICE, 'live');
      const wanted = eventsOf(await read(bureau, 'live', { principal: ALICE }));

      const strangers: DurableEventEnvelope[] = [];
      const owners: DurableEventEnvelope[] = [];
      const asBob = bureau.subscribeEventHistory(
        { kind: 'session', id: 'live' },
        (event) => {
          strangers.push(event);
        },
        { principal: BOB },
      );
      const asAlice = bureau.subscribeEventHistory(
        { kind: 'session', id: 'live' },
        (event) => {
          owners.push(event);
        },
        { principal: ALICE },
      );
      try {
        // Alice's subscription was opened after Bob's, so once it has replayed everything,
        // Bob's chain has judged every one of the same events.
        await waitForCondition(
          () => owners.length >= wanted.length,
          "the owner's replay never arrived",
        );
        await settled(bureau, ALICE, 'live');

        expect(sequences(owners).slice(0, wanted.length)).toEqual(sequences(wanted));
        expect(strangers).toEqual([]);
      } finally {
        asBob.unsubscribe();
        asAlice.unsubscribe();
      }
    } finally {
      await bureau.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
