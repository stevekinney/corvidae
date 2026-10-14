/**
 * Durable steering with two Bureau processes over one backend.
 *
 * Both Bureaus run in this process but share nothing except the SQLite file,
 * which is all two real processes would share. Bureau A owns the session's
 * steering lease while it is alive, so Bureau B is refused rather than
 * admitting into its own, divergent gate; idempotency keys stay bureau-wide
 * across both; and once A shuts down (releasing the lease), B takes the
 * session over, rebuilds A's desired state at A's `configVersion`, and
 * reports A's commands in the state they reached — including a supersession
 * that happened only in A.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';

async function openBureau(id: string, path: string) {
  return createBureau({
    id,
    agents: {},
    generate: () => new Promise<never>(() => {}),
    toolbox: createToolbox([]),
    storage: { type: 'sqlite', path },
    durableExecution: true,
  });
}

async function waitUntilRunning(
  bureau: Awaited<ReturnType<typeof openBureau>>,
  sessionId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const session = await bureau.getSession(sessionId);
    if (session?.metadata['lastRunStatus'] === 'running') return;
    await Bun.sleep(10);
  }
  throw new Error(`session "${sessionId}" never reached running`);
}

describe('durable steering across two Bureau processes', () => {
  it('fences admission to the lease holder and hands the session over intact', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-two-instances-'));
    const path = join(directory, 'bureau.sqlite');
    const bureauA = await openBureau('bureau-a', path);
    let bureauB: Awaited<ReturnType<typeof openBureau>> | undefined;

    try {
      const run = await bureauA.createRun({ message: 'Wait forever', principal: 'alice' });
      await waitUntilRunning(bureauA, run.sessionId);
      const first = await bureauA.submitSteeringCommand(run.sessionId, {
        id: 'k1',
        principal: 'alice',
        requestedValue: { target: 'model', override: 'claude-sonnet-5' },
      });
      const second = await bureauA.submitSteeringCommand(run.sessionId, {
        id: 'k2',
        principal: 'alice',
        requestedValue: { target: 'model', override: 'claude-opus-4-8' },
      });
      if (first.outcome !== 'accepted' || second.outcome !== 'accepted') {
        throw new Error('expected both accepted');
      }
      expect(second.command.configVersion).toBe(2);

      bureauB = await openBureau('bureau-b', path);
      await bureauB.waitForRecovery?.();

      // A holds the session's steering lease, so B refuses instead of
      // admitting into a gate that has never seen A's commands.
      const refused = await bureauB.submitSteeringCommand(run.sessionId, {
        id: 'from-b',
        principal: 'alice',
        requestedValue: { target: 'provider', override: 'anthropic' },
      });
      expect(refused).toEqual({
        outcome: 'unsupported-capability',
        reason: 'steering-owned-elsewhere',
      });

      // Idempotency keys are bureau-wide across processes: A's key sent by
      // B to a session B owns is a session mismatch, not a new command.
      const otherRun = await bureauB.createRun({ message: 'Wait forever', principal: 'alice' });
      await waitUntilRunning(bureauB, otherRun.sessionId);
      const reused = await bureauB.submitSteeringCommand(otherRun.sessionId, {
        id: 'k1',
        principal: 'alice',
        requestedValue: { target: 'model', override: 'claude-sonnet-5' },
      });
      expect(reused.outcome).toBe('conflict');
      if (reused.outcome !== 'conflict') throw new Error('expected conflict');
      expect(reused.conflict.reason).toBe('session-mismatch');

      // A shuts down cleanly, releasing its lease. B starts a run on the
      // same session, which takes the session over and rebuilds A's state.
      await bureauA.dispose();
      const resumed = await bureauB.createRun({
        message: 'Wait forever',
        principal: 'alice',
        sessionId: run.sessionId,
      });
      await waitUntilRunning(bureauB, resumed.sessionId);

      const probe = await bureauB.submitSteeringCommand(run.sessionId, {
        id: 'probe',
        principal: 'alice',
        requestedValue: { target: 'model', override: 'claude-opus-4-8' },
      });
      expect(probe.outcome).toBe('accepted');
      if (probe.outcome !== 'accepted') throw new Error('expected accepted');
      expect(probe.command.configVersion).toBe(2);

      // k1 was superseded by k2 in A only; its durable record says so.
      const replayed = await bureauB.submitSteeringCommand(run.sessionId, {
        id: 'k1',
        principal: 'alice',
        requestedValue: { target: 'model', override: 'claude-sonnet-5' },
      });
      expect(replayed.outcome).toBe('replayed');
      if (replayed.outcome !== 'replayed') throw new Error('expected replayed');
      expect(replayed.command.state).toBe('superseded');
    } finally {
      await bureauA.dispose();
      await bureauB?.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
