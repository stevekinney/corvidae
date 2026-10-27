import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAgent,
  type GenerateFunction,
  stopWhen,
  SESSION_OWNER_METADATA_KEY,
} from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { BureauError, createBureau } from './create-bureau';
import { waitForCondition } from './test';
import { rejectionOf } from './testing/promise-outcome.test-support.ts';
import type { AgentDefinitions } from './agent-catalog';

const generate: GenerateFunction = async () => ({ content: 'Done.', toolCalls: [] });

async function openBureau() {
  return createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({ generate, stopWhen: stopWhen.noToolCalls() }),
    },
    storage: { type: 'memory' },
  });
}

async function settle(bureau: Awaited<ReturnType<typeof openBureau>>, runId: string) {
  await waitForCondition(
    () => bureau.getRun(runId)?.status !== 'running',
    `run ${runId} never settled`,
  );
}

describe('the owner of a run and of its session (COR-718)', () => {
  it('records the stated principal as the run owner, on the summary, the liveness snapshot, and the session', async () => {
    const bureau = await openBureau();
    try {
      const run = await bureau.createRun({
        agentName: 'default',
        message: 'hello',
        principal: 'api-key:alice',
      });
      await settle(bureau, run.id);

      expect(bureau.getRun(run.id)?.principal).toBe('api-key:alice');
      expect(bureau.getRun(run.id)?.liveness.owner).toBe('api-key:alice');
      const session = await bureau.getSession(run.sessionId);
      expect(session?.metadata[SESSION_OWNER_METADATA_KEY]).toBe('api-key:alice');
      expect(session?.metadata['lastRunOwningPrincipals']).toEqual({ [run.id]: 'api-key:alice' });
      expect(await bureau.getOwner({ kind: 'run', id: run.id })).toBe('api-key:alice');
      expect(await bureau.getOwner({ kind: 'session', id: run.sessionId })).toBe('api-key:alice');
    } finally {
      await bureau.dispose();
    }
  });

  it('gives a run created with no principal the owner anonymous:local', async () => {
    const bureau = await openBureau();
    try {
      const run = await bureau.createRun({ agentName: 'default', message: 'hello' });
      await settle(bureau, run.id);

      expect(bureau.getRun(run.id)?.principal).toBe('anonymous:local');
      expect(bureau.getRun(run.id)?.liveness.owner).toBe('anonymous:local');
      const session = await bureau.getSession(run.sessionId);
      expect(session?.metadata[SESSION_OWNER_METADATA_KEY]).toBe('anonymous:local');
      expect(await bureau.getOwner({ kind: 'run', id: run.id })).toBe('anonymous:local');
    } finally {
      await bureau.dispose();
    }
  });

  it('answers an unknown run, session, goal, schedule, or review with no owner', async () => {
    const bureau = await openBureau();
    try {
      for (const kind of ['run', 'session', 'goal', 'schedule', 'review'] as const) {
        expect(await bureau.getOwner({ kind, id: 'missing' })).toBeUndefined();
      }
    } finally {
      await bureau.dispose();
    }
  });

  it('refuses a run on a session another principal owns, as a session that does not exist', async () => {
    const bureau = await openBureau();
    try {
      const first = await bureau.createRun({
        agentName: 'default',
        message: 'mine',
        principal: 'api-key:alice',
      });
      await settle(bureau, first.id);

      for (const principal of ['api-key:bob', undefined]) {
        const attempt = bureau.createRun({
          agentName: 'default',
          message: 'yours now',
          sessionId: first.sessionId,
          ...(principal === undefined ? {} : { principal }),
        });
        const refusal = await rejectionOf(attempt);
        expect(refusal).toBeInstanceOf(BureauError);
        expect(refusal).toMatchObject({ code: 'NOT_FOUND' });
      }

      const session = await bureau.getSession(first.sessionId);
      expect(session?.metadata[SESSION_OWNER_METADATA_KEY]).toBe('api-key:alice');
      expect(session?.metadata['lastRunOwningPrincipals']).toEqual({ [first.id]: 'api-key:alice' });
    } finally {
      await bureau.dispose();
    }
  });

  it('lets the owner start a second run on its own session, and keeps the session owner', async () => {
    const bureau = await openBureau();
    try {
      const first = await bureau.createRun({
        agentName: 'default',
        message: 'one',
        principal: 'api-key:alice',
      });
      await settle(bureau, first.id);
      const second = await bureau.createRun({
        agentName: 'default',
        message: 'two',
        sessionId: first.sessionId,
        principal: 'api-key:alice',
      });
      await settle(bureau, second.id);

      const session = await bureau.getSession(first.sessionId);
      expect(session?.metadata[SESSION_OWNER_METADATA_KEY]).toBe('api-key:alice');
      expect(await bureau.getOwner({ kind: 'run', id: second.id })).toBe('api-key:alice');
    } finally {
      await bureau.dispose();
    }
  });

  it('refuses to read the history of a session another principal owns', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'owner-of-record-history-'));
    const bureau = await createBureau<AgentDefinitions>({
      id: 'owner-history',
      agents: {
        default: createAgent({ generate, stopWhen: stopWhen.noToolCalls() }),
      },
      storage: { type: 'sqlite', path: join(directory, 'bureau.sqlite') },
      durable: true,
      durableOwnership: { ownership: 'none' },
    });
    try {
      const run = await bureau.createRun({
        agentName: 'default',
        message: 'mine',
        principal: 'api-key:alice',
      });
      await settle(bureau, run.id);

      const asOwner = await bureau.eventHistory(
        { kind: 'session', id: run.sessionId },
        { principal: 'api-key:alice' },
      );
      expect('outcome' in asOwner).toBe(false);
      for (const principal of ['api-key:bob', 'anonymous:local']) {
        expect(
          await bureau.eventHistory({ kind: 'session', id: run.sessionId }, { principal }),
        ).toEqual({ outcome: 'not-found' });
      }
    } finally {
      await bureau.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('requires an explicit principal for a run creation request id', async () => {
    const bureau = await openBureau();
    try {
      expect(
        await rejectionOf(
          bureau.createRun({
            agentName: 'default',
            message: 'x',
            runCreationRequestId: 'request-1',
          }),
        ),
      ).toBeInstanceOf(BureauError);
    } finally {
      await bureau.dispose();
    }
  });
});

describe('two principals racing to create one new session (COR-718)', () => {
  it('lets the first save own the session and refuses the other as a session that is not there', async () => {
    const bureau = await openBureau();
    try {
      const outcomes = await Promise.allSettled([
        bureau.createRun({
          agentName: 'default',
          message: 'from alice',
          sessionId: 'raced',
          principal: 'api-key:alice',
        }),
        bureau.createRun({
          agentName: 'default',
          message: 'from bob',
          sessionId: 'raced',
          principal: 'api-key:bob',
        }),
      ]);

      const winners = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const losers = outcomes.filter((outcome) => outcome.status === 'rejected');
      expect([winners.length, losers.length]).toEqual([1, 1]);
      expect(losers[0]?.reason).toMatchObject({ code: 'NOT_FOUND' });
      const session = await bureau.getSession('raced');
      const owner = session?.metadata[SESSION_OWNER_METADATA_KEY];
      const transcript = JSON.stringify(session?.conversationHistory);
      const winner = owner === 'api-key:alice' ? 'from alice' : 'from bob';
      const loser = owner === 'api-key:alice' ? 'from bob' : 'from alice';
      expect(transcript).toContain(winner);
      expect(transcript).not.toContain(loser);
      expect(session?.metadata['lastRunOwningPrincipals']).toEqual({
        [winners[0]!.value.id]: typeof owner === 'string' ? owner : '',
      });
    } finally {
      await bureau.dispose();
    }
  });
});

describe('the owner of a catalog run (COR-718)', () => {
  it('reads the principal a live bureau.run dispatch was given, whether or not the engine is durable', async () => {
    const release = Promise.withResolvers<void>();
    const worker = createAgent({
      name: 'worker',
      generate: async () => {
        await release.promise;
        return { content: 'done', toolCalls: [] };
      },
    });
    for (const durable of [false, true]) {
      const bureau = await createBureau({
        agents: { worker },
        ...(durable ? { storage: { type: 'memory' as const }, durable: true } : {}),
      });
      try {
        const owned = bureau.run('worker', 'work', { principal: 'api-key:alice' });
        const unowned = bureau.run('worker', 'work');

        expect([durable, await bureau.getOwner({ kind: 'run', id: owned.id })]).toEqual([
          durable,
          'api-key:alice',
        ]);
        expect([durable, await bureau.getOwner({ kind: 'run', id: unowned.id })]).toEqual([
          durable,
          'anonymous:local',
        ]);
      } finally {
        release.resolve();
        await bureau.dispose();
      }
    }
  });
});

describe('durable history follows the owner of record (COR-718)', () => {
  async function openDurableBureau() {
    const directory = await mkdtemp(join(tmpdir(), 'owner-of-record-history-owners-'));
    const bureau = await createBureau<AgentDefinitions>({
      id: 'owner-history-owners',
      agents: {
        default: createAgent({ generate, stopWhen: stopWhen.noToolCalls() }),
      },
      storage: { type: 'sqlite', path: join(directory, 'bureau.sqlite') },
      durable: true,
      durableOwnership: { ownership: 'none' },
    });
    return { bureau, directory };
  }

  const verdict = (result: object) => ('outcome' in result ? String(result.outcome) : 'page');

  it('reads a run created with no principal as owned by anonymous:local, and by no one else', async () => {
    const { bureau, directory } = await openDurableBureau();
    try {
      const run = await bureau.createRun({ agentName: 'default', message: 'no principal' });
      await settle(bureau, run.id);

      const asLocal = await bureau.eventHistory(
        { kind: 'run', id: run.id },
        { principal: 'anonymous:local' },
      );
      const asStranger = await bureau.eventHistory(
        { kind: 'run', id: run.id },
        { principal: 'api-key:bob' },
      );

      expect([verdict(asLocal), verdict(asStranger)]).toEqual(['page', 'not-found']);
    } finally {
      await bureau.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('lets only a schedule’s owner read its history, including after it is cancelled', async () => {
    const { bureau, directory } = await openDurableBureau();
    try {
      const owned = await bureau.schedules.create({
        agentName: 'default',
        input: 'tick',
        spec: '1h',
        principal: 'api-key:alice',
      });
      const unowned = await bureau.schedules.create({
        agentName: 'default',
        input: 'tick',
        spec: '1h',
      });
      await bureau.schedules.cancel(owned!.id);
      const read = async (id: string, principal: string) =>
        verdict(await bureau.eventHistory({ kind: 'schedule', id }, { principal }));

      expect([
        await read(owned!.id, 'api-key:alice'),
        await read(owned!.id, 'api-key:bob'),
        await read(owned!.id, 'anonymous:local'),
        await read(unowned!.id, 'anonymous:local'),
        await read(unowned!.id, 'api-key:alice'),
      ]).toEqual(['page', 'not-found', 'not-found', 'page', 'not-found']);
    } finally {
      await bureau.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('the history of a live catalog run (COR-718)', () => {
  it('reads a durable bureau.run dispatched with no principal as owned by anonymous:local', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'owner-of-record-catalog-history-'));
    const release = Promise.withResolvers<void>();
    const worker = createAgent({
      name: 'worker',
      generate: async () => {
        await release.promise;
        return { content: 'done', toolCalls: [] };
      },
    });
    const bureau = await createBureau({
      agents: { worker },
      storage: { type: 'sqlite', path: join(directory, 'bureau.sqlite') },
      durable: true,
      durableOwnership: { ownership: 'none' },
    });
    try {
      const unowned = bureau.run('worker', 'work');
      const owned = bureau.run('worker', 'work', { principal: 'api-key:alice' });
      const history = async (id: string, principal: string) => {
        const page = await bureau.eventHistory({ kind: 'run', id }, { principal });
        return 'outcome' in page ? page.outcome : 'page';
      };

      expect(await history(unowned.id, 'anonymous:local')).toBe('page');
      expect(await history(unowned.id, 'api-key:alice')).toBe('not-found');
      expect(await history(owned.id, 'api-key:alice')).toBe('page');
      expect(await history(owned.id, 'anonymous:local')).toBe('not-found');
    } finally {
      release.resolve();
      await bureau.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
