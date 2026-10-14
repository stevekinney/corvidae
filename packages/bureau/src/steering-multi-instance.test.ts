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

import type { GenerateFunction } from '@lostgradient/operative';
import { encodeStorageKeyComponent } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

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
      // A returned refusal is the caller's own copy: changing it changes
      // nothing a later retry sees.
      if (refused.outcome === 'rejected') {
        (refused.failure as { reason: string }).reason = 'mutated';
        const again = await bureauA.submitSteeringCommand(sessionId, {
          id: 'refused',
          principal: 'alice',
          deadline: '2000-01-01T00:00:00.000Z',
          requestedValue: { target: 'model', override: 'claude-sonnet-5' },
        });
        if (again.outcome !== 'rejected') throw new Error('expected rejected');
        expect(again.failure.reason).toBe('deadline-passed');
        (refused.failure as { reason: string }).reason = again.failure.reason;
      }
      const retriedRefusal = await bureauB.submitSteeringCommand(sessionId, {
        id: 'refused',
        principal: 'alice',
        deadline: '2000-01-01T00:00:00.000Z',
        requestedValue: { target: 'model', override: 'claude-sonnet-5' },
      });
      expect(retriedRefusal).toEqual(refused);

      // A refusal Bureau makes before the gate (a model outside the catalog)
      // is logged as well, so the id stays decided in every process.
      const offCatalog = await bureauA.submitSteeringCommand(
        sessionId,
        model('off', 'not-a-real-model'),
      );
      expect(offCatalog.outcome).toBe('rejected');
      expect(
        await bureauB.submitSteeringCommand(sessionId, model('off', 'not-a-real-model')),
      ).toEqual(offCatalog);
      const offCatalogReused = await bureauB.submitSteeringCommand(
        sessionId,
        model('off', 'claude-sonnet-5'),
      );
      expect(offCatalogReused.outcome).toBe('conflict');
      if (offCatalogReused.outcome !== 'conflict') throw new Error('expected conflict');
      expect(offCatalogReused.conflict.reason).toBe('requested-value-mismatch');

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

  it('folds a run boundary and a completion to the same command states everywhere', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-boundary-'));
    const path = join(directory, 'bureau.sqlite');
    let releaseTool: (() => void) | undefined;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    let releaseSecondTool: (() => void) | undefined;
    const secondToolGate = new Promise<void>((resolve) => {
      releaseSecondTool = resolve;
    });
    let toolCalls = 0;
    let generateCalls = 0;
    // Step 0 calls a tool that waits for the test; step 1 finishes. Steering
    // admitted while the tool waits is observed at step 1's boundary.
    const generate: GenerateFunction = async ({ step }) => {
      generateCalls += 1;
      return step === 0
        ? { content: '', toolCalls: [{ name: 'next', arguments: {} }] }
        : { content: 'done', toolCalls: [] };
    };
    const bureauA = await createBureau({
      agents: {},
      generate,
      toolbox: createToolbox([
        createTool({
          name: 'next',
          description: 'waits for the test',
          input: z.object({}),
          execute: async () => {
            toolCalls += 1;
            // The first run waits for the test; the second stays live so the
            // session is not terminal while the test inspects it.
            await (toolCalls === 1 ? toolGate : secondToolGate);
            return 'ok';
          },
        }),
      ]),
      storage: { type: 'sqlite', path },
      durableExecution: true,
    });
    let bureauB: TestBureau | undefined;

    try {
      const run = await bureauA.createRun({ message: 'go', principal: 'alice' });
      for (let attempt = 0; attempt < 200 && generateCalls === 0; attempt += 1) await Bun.sleep(10);
      const model = (id: string, override: string) =>
        ({ id, principal: 'alice', requestedValue: { target: 'model', override } }) as const;
      expect(
        versionOf(
          await bureauA.submitSteeringCommand(run.sessionId, model('k1', 'claude-sonnet-5')),
        ),
      ).toBe(1);
      expect(
        versionOf(
          await bureauA.submitSteeringCommand(run.sessionId, model('k2', 'claude-opus-4-8')),
        ),
      ).toBe(2);

      releaseTool?.();
      for (let attempt = 0; attempt < 500; attempt += 1) {
        if (bureauA.getRun(run.id)?.status !== 'running') break;
        await Bun.sleep(10);
      }
      expect(bureauA.getRun(run.id)?.status).toBe('completed');

      // A second run keeps the session live (a terminal session answers
      // `session-terminal` before any idempotency check).
      await bureauA.createRun({ message: 'again', principal: 'alice', sessionId: run.sessionId });
      for (let attempt = 0; attempt < 200 && toolCalls < 2; attempt += 1) await Bun.sleep(10);

      // The boundary's `applied` event is logged in the background; wait for
      // A itself to report it, then compare with a process that only folds.
      const stateIn = async (bureau: TestBureau, id: string, override: string) => {
        const outcome = await bureau.submitSteeringCommand(run.sessionId, model(id, override));
        if (outcome.outcome !== 'replayed')
          throw new Error(`expected replayed, got ${outcome.outcome}`);
        return outcome.command.state;
      };
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if ((await stateIn(bureauA, 'k2', 'claude-opus-4-8')) === 'applied') break;
        await Bun.sleep(10);
      }
      expect(await stateIn(bureauA, 'k2', 'claude-opus-4-8')).toBe('applied');
      expect(await stateIn(bureauA, 'k1', 'claude-sonnet-5')).toBe('superseded');

      bureauB = await openBureau(path);
      await bureauB.waitForRecovery?.();
      expect(await stateIn(bureauB, 'k2', 'claude-opus-4-8')).toBe('applied');
      expect(await stateIn(bureauB, 'k1', 'claude-sonnet-5')).toBe('superseded');
    } finally {
      releaseTool?.();
      releaseSecondTool?.();
      await bureauA.dispose();
      await bureauB?.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('folds a key reused after another process deleted its session, without stale state', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-deleted-elsewhere-'));
    const path = join(directory, 'bureau.sqlite');
    const bureauA = await openBureau(path);
    const bureauB = await openBureau(path);

    try {
      const model = (id: string, override: string) =>
        ({ id, principal: 'alice', requestedValue: { target: 'model', override } }) as const;
      const first = await startRunningSession(bureauA);
      expect(
        versionOf(await bureauA.submitSteeringCommand(first, model('k1', 'claude-sonnet-5'))),
      ).toBe(1);

      // B deletes that session; A never hears about it. B then admits the
      // same key in a new session, replacing the dead incarnation's binding.
      await bureauB.deleteSession(first);
      const second = await startRunningSession(bureauB);
      expect(
        versionOf(await bureauB.submitSteeringCommand(second, model('k1', 'claude-opus-4-8'))),
      ).toBe(1);

      // A folds the new session from its log alone: k1 is that session's
      // first command, so a new command is version 2 and k1 replays there.
      expect(
        versionOf(await bureauA.submitSteeringCommand(second, model('k2', 'claude-sonnet-5'))),
      ).toBe(2);
      const replayed = await bureauA.submitSteeringCommand(second, model('k1', 'claude-opus-4-8'));
      expect(replayed.outcome).toBe('replayed');
    } finally {
      await bureauA.dispose();
      await bureauB.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('replays a policy-resolved command for an exact retry, even where the policy is gone', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-policy-'));
    const path = join(directory, 'bureau.sqlite');
    const withPolicy = await createBureau({
      agents: {},
      generate: () => new Promise<never>(() => {}),
      toolbox: createToolbox([]),
      storage: { type: 'sqlite', path },
      durableExecution: true,
      modelPolicy: {
        policyRevision: 1,
        users: { 'fast-tier': { exactOverride: { model: 'claude-sonnet-5' } } },
      },
    });
    const withoutPolicy = await openBureau(path);
    try {
      const sessionId = await startRunningSession(withPolicy);
      const viaPolicy = {
        id: 'p1',
        principal: 'alice',
        requestedValue: { target: 'model', policyRef: 'fast-tier' },
      } as const;
      expect(versionOf(await withPolicy.submitSteeringCommand(sessionId, viaPolicy))).toBe(1);

      // This process has no such profile, so resolving the retry afresh
      // would refuse it; it repeats the original request, so it replays.
      const retried = await withoutPolicy.submitSteeringCommand(sessionId, viaPolicy);
      expect(retried.outcome).toBe('replayed');
    } finally {
      await withPolicy.dispose();
      await withoutPolicy.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('fails a run start on a corrupt steering log, leaving the session failed rather than running', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-corrupt-start-'));
    const path = join(directory, 'bureau.sqlite');
    const bureau = await openBureau(path);
    try {
      const sessionId = await startRunningSession(bureau);
      const session = await bureau.getSession(sessionId);
      const kv = bureau.kv;
      if (kv === undefined || session === undefined) throw new Error('expected a durable session');
      const logKeys = await kv.list(`steering-log:v1:${encodeStorageKeyComponent(sessionId)}:`);
      const [headKey] = logKeys.filter((key) => key.endsWith(':head'));
      if (headKey === undefined) throw new Error('expected a steering log head');
      await kv.set(headKey, '{"sequence":-1}');

      await expect(
        bureau.createRun({ message: 'again', principal: 'alice', sessionId }),
      ).rejects.toThrow();
      const after = await bureau.getSession(sessionId);
      expect(after?.metadata['lastRunStatus']).toBe('error');
    } finally {
      await bureau.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
