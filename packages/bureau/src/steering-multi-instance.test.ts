/**
 * Durable steering with two live Bureau processes over one backend.
 *
 * Both Bureaus run in this process but share nothing except the SQLite file,
 * which is all two real processes would share. Each admits to the same
 * session, folds the other's appends before deciding, and so agrees with it
 * on versions, command states, and idempotency — with no lease, because
 * every append is conditioned on the log head it was decided against.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';

async function openBureau(path: string) {
  return createBureau({
    agents: {},
    generate: () => new Promise<never>(() => {}),
    toolbox: createToolbox([]),
    storage: { type: 'sqlite', path },
    durableExecution: true,
  });
}

type TestBureau = Awaited<ReturnType<typeof openBureau>>;

async function startRunningSession(bureau: TestBureau, sessionId?: string): Promise<string> {
  const run = await bureau.createRun({
    message: 'Wait forever',
    principal: 'alice',
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const session = await bureau.getSession(run.sessionId);
    if (session?.metadata['lastRunStatus'] === 'running') return run.sessionId;
    await Bun.sleep(10);
  }
  throw new Error(`session "${run.sessionId}" never reached running`);
}

function versionOf(outcome: Awaited<ReturnType<TestBureau['submitSteeringCommand']>>): number {
  if (outcome.outcome !== 'accepted') throw new Error(`expected accepted, got ${outcome.outcome}`);
  return outcome.command.configVersion;
}

describe('durable steering across two Bureau processes', () => {
  it('lets both admit, in one order, with shared versions, states, and keys', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-two-'));
    const path = join(directory, 'bureau.sqlite');
    const bureauA = await openBureau(path);
    const bureauB = await openBureau(path);

    try {
      const sessionId = await startRunningSession(bureauA);
      const model = (id: string, override: string) =>
        ({ id, principal: 'alice', requestedValue: { target: 'model', override } }) as const;

      expect(
        versionOf(await bureauA.submitSteeringCommand(sessionId, model('k1', 'claude-sonnet-5'))),
      ).toBe(1);
      expect(
        versionOf(await bureauA.submitSteeringCommand(sessionId, model('k2', 'claude-opus-4-8'))),
      ).toBe(2);

      // B folds A's two commands before deciding, so its own continues at 3,
      // and A folds B's before its next one.
      const fromB = await bureauB.submitSteeringCommand(sessionId, {
        id: 'b1',
        principal: 'alice',
        requestedValue: { target: 'provider', override: 'anthropic' },
      });
      expect(versionOf(fromB)).toBe(3);
      const fromA = await bureauA.submitSteeringCommand(sessionId, {
        id: 'a3',
        principal: 'alice',
        requestedValue: { target: 'effort', override: 'high' },
      });
      expect(versionOf(fromA)).toBe(4);

      // k1 was superseded by k2 in A; B reports that state.
      const superseded = await bureauB.submitSteeringCommand(
        sessionId,
        model('k1', 'claude-sonnet-5'),
      );
      expect(superseded.outcome).toBe('replayed');
      if (superseded.outcome !== 'replayed') throw new Error('expected replayed');
      expect(superseded.command.state).toBe('superseded');

      // One key submitted from both at once is admitted exactly once.
      const raced = await Promise.all([
        bureauA.submitSteeringCommand(sessionId, model('race', 'claude-sonnet-5')),
        bureauB.submitSteeringCommand(sessionId, model('race', 'claude-sonnet-5')),
      ]);
      expect(raced.map(({ outcome }) => outcome).toSorted()).toEqual(['accepted', 'replayed']);

      // A refusal is logged too: the id stays decided in every process.
      const refused = await bureauA.submitSteeringCommand(sessionId, {
        id: 'refused',
        principal: 'alice',
        deadline: '2000-01-01T00:00:00.000Z',
        requestedValue: { target: 'model', override: 'claude-sonnet-5' },
      });
      expect(refused.outcome).toBe('rejected');
      const reusedRefused = await bureauB.submitSteeringCommand(sessionId, {
        id: 'refused',
        principal: 'alice',
        requestedValue: { target: 'provider', override: 'anthropic' },
      });
      expect(reusedRefused.outcome).toBe('conflict');
      if (reusedRefused.outcome !== 'conflict') throw new Error('expected conflict');
      expect(reusedRefused.conflict.reason).toBe('target-mismatch');
      expect(reusedRefused.conflict.original.state).toBe('rejected');
      const retriedRefusal = await bureauB.submitSteeringCommand(sessionId, {
        id: 'refused',
        principal: 'alice',
        deadline: '2000-01-01T00:00:00.000Z',
        requestedValue: { target: 'model', override: 'claude-sonnet-5' },
      });
      expect(retriedRefusal).toEqual(refused);

      // A's key sent by B to a session of B's own is a session mismatch.
      const otherSession = await startRunningSession(bureauB);
      const crossSession = await bureauB.submitSteeringCommand(
        otherSession,
        model('k2', 'claude-opus-4-8'),
      );
      expect(crossSession.outcome).toBe('conflict');
      if (crossSession.outcome !== 'conflict') throw new Error('expected conflict');
      expect(crossSession.conflict.reason).toBe('session-mismatch');
    } finally {
      await bureauA.dispose();
      await bureauB.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("gives a recreated session a fresh log and frees the deleted incarnation's keys", async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-recreate-'));
    const path = join(directory, 'bureau.sqlite');
    const bureau = await openBureau(path);

    try {
      const sessionId = await startRunningSession(bureau);
      const steer = {
        id: 'reused',
        principal: 'alice',
        requestedValue: { target: 'model', override: 'claude-opus-4-8' },
      } as const;
      expect(versionOf(await bureau.submitSteeringCommand(sessionId, steer))).toBe(1);
      await bureau.submitSteeringCommand(sessionId, {
        ...steer,
        id: 'second',
        requestedValue: { target: 'model', override: 'claude-sonnet-5' },
      });

      await bureau.deleteSession(sessionId);
      await startRunningSession(bureau, sessionId);

      // A different value under the deleted incarnation's key is a new
      // command in the new incarnation, at version 1 of a fresh log.
      const fresh = await bureau.submitSteeringCommand(sessionId, {
        ...steer,
        requestedValue: { target: 'provider', override: 'anthropic' },
      });
      expect(versionOf(fresh)).toBe(1);
    } finally {
      await bureau.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
