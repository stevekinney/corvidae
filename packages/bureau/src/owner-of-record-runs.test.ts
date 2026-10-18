import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { BureauError, createBureau } from './create-bureau';
import { SESSION_OWNER_METADATA_KEY } from './session-authority';
import { waitForCondition } from './test';
import { rejectionOf } from './testing/promise-outcome.test-support.ts';

const generate: GenerateFunction = async () => ({ content: 'Done.', toolCalls: [] });

async function openBureau() {
  return createBureau({
    agents: {},
    generate,
    storage: { type: 'memory' },
    stopWhen: stopWhen.noToolCalls(),
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
      const run = await bureau.createRun({ message: 'hello', principal: 'api-key:alice' });
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
      const run = await bureau.createRun({ message: 'hello' });
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
      const first = await bureau.createRun({ message: 'mine', principal: 'api-key:alice' });
      await settle(bureau, first.id);

      for (const principal of ['api-key:bob', undefined]) {
        const attempt = bureau.createRun({
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
      const first = await bureau.createRun({ message: 'one', principal: 'api-key:alice' });
      await settle(bureau, first.id);
      const second = await bureau.createRun({
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
    const bureau = await createBureau({
      id: 'owner-history',
      agents: {},
      generate,
      storage: { type: 'sqlite', path: join(directory, 'bureau.sqlite') },
      durableExecution: true,
      durableOwnership: { ownership: 'none' },
      stopWhen: stopWhen.noToolCalls(),
    });
    try {
      const run = await bureau.createRun({ message: 'mine', principal: 'api-key:alice' });
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
        await rejectionOf(bureau.createRun({ message: 'x', runCreationRequestId: 'request-1' })),
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
        bureau.createRun({ message: 'from alice', sessionId: 'raced', principal: 'api-key:alice' }),
        bureau.createRun({ message: 'from bob', sessionId: 'raced', principal: 'api-key:bob' }),
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
        [winners[0]!.value.id]: String(owner),
      });
    } finally {
      await bureau.dispose();
    }
  });
});
