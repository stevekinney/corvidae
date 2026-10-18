/**
 * COR-718 — a deleted session's durable history. History is keyed by session id
 * alone, so a caller that states a principal is held to the live session's owner:
 * a deleted session reads as not found, and a recreated id shows only the events
 * after its latest deletion marker, which are the current incarnation's.
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

const generate: GenerateFunction = async () => ({ content: 'Done.', toolCalls: [] });
const ALICE = 'api-key:alice';
const BOB = 'api-key:bob';

async function openBureau() {
  const directory = await mkdtemp(join(tmpdir(), 'owner-of-record-session-history-'));
  const bureau = await createBureau({
    id: 'session-history',
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

describe('the history of a deleted session (COR-718)', () => {
  it('reads as not found to any caller that states a principal, and stays whole for a trusted caller', async () => {
    const { bureau, directory } = await openBureau();
    try {
      await settled(bureau, ALICE, 'deleted');
      await bureau.deleteSession('deleted');

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

  it('shows a recreated id only the events after its latest deletion marker', async () => {
    const { bureau, directory } = await openBureau();
    try {
      await settled(bureau, ALICE, 'reused');
      await bureau.deleteSession('reused');
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

  it('pages a recreated id from its marker even when the page limit is small', async () => {
    const { bureau, directory } = await openBureau();
    try {
      await settled(bureau, ALICE, 'paged');
      await bureau.deleteSession('paged');
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
      await bureau.deleteSession('followed');
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

  it('delivers nothing to a subscription on a session that does not exist', async () => {
    const { bureau, directory } = await openBureau();
    try {
      await settled(bureau, ALICE, 'gone');
      await bureau.deleteSession('gone');

      const received: DurableEventEnvelope[] = [];
      const subscription = bureau.subscribeEventHistory(
        { kind: 'session', id: 'gone' },
        (event) => {
          received.push(event);
        },
        { principal: BOB },
      );
      try {
        // A trusted subscription proves the replay has finished.
        const trusted: DurableEventEnvelope[] = [];
        const witness = bureau.subscribeEventHistory({ kind: 'session', id: 'gone' }, (event) => {
          trusted.push(event);
        });
        await waitForCondition(() => trusted.length > 0, 'the trusted replay never arrived');
        witness.unsubscribe();
        await bureau.runDurableMaintenance();

        expect(received).toEqual([]);
      } finally {
        subscription.unsubscribe();
      }
    } finally {
      await bureau.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
