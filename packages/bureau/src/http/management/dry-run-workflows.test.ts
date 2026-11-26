/**
 * COR-2522 — `bureau.workflows.delete` and `bureau.workflows.runs.cancel` with `dryRun: true`.
 */
import { definePlugin, type PluginWorkflow } from '@lostgradient/interborough-plugin';
import { createAgent } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { workflow } from '@lostgradient/weft/testing';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { waitForCondition } from '../../test';
import { createSqliteStorageFixture } from '../../test/storage-fixtures';
import { AGENT_STEP } from '../../testing/workflow-file-fixtures.test-support.ts';
import {
  dryRunResultOf,
  expectNothingWritten,
  expectSameFaultAsTheRealCall,
} from './dry-run.test-support.ts';
import { parkingUntilAborted, rpc } from './management-fixtures.test-support.ts';
import { type Served, serveWorkflows } from './workflows-fixtures.test-support.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A workflow `digest` on a schedule that does not fire during a test, and an instance of it that has not finished. */
async function serve() {
  const storage = new MemoryStorage();
  const served = await serveWorkflows(cleanups, {
    storage,
    agents: {
      writer: createAgent({ name: 'writer', generate: parkingUntilAborted }),
    },
  });
  const created = await served.bureau.workflows!.create('digest', {
    agent: 'writer',
    trigger: { kind: 'schedule', spec: '1h' },
    steps: [AGENT_STEP],
  });
  await served.bureau.durableEngine()!.start('digest', null, { id: 'digest-run' });
  await waitForCondition(async () => {
    const counts = await served.bureau.workflows!.runCounts('digest');
    return counts?.active === 1;
  }, 'the digest instance is in progress');
  return {
    served,
    hash: created.hash,
    subject: { bureau: served.bureau, storage, directory: served.directory },
  };
}

const writerOf = (served: Served) => ({ handler: served.keyed });

describe('bureau.workflows.delete with dryRun', () => {
  it('counts the schedule it would cancel and the instance that would finish, and removes nothing', async () => {
    const { served, hash, subject } = await serve();

    const body = await expectNothingWritten(subject, () =>
      rpc(
        served.keyed,
        'bureau.workflows.delete',
        { id: 'digest', expectedHash: hash, dryRun: true },
        'workflows-writer-key',
      ),
    );

    expect(dryRunResultOf(body)).toEqual({
      dryRun: true,
      target: { kind: 'workflow', id: 'digest' },
      effects: [
        { kind: 'schedules', count: 1 },
        { kind: 'running-instances', count: 1 },
      ],
    });
    expect(await served.bureau.workflows!.get('digest')).toBeDefined();
    const schedule = await served.bureau.schedules.get('bureau-workflow-schedule:digest:1');
    expect(schedule?.status).toBe('active');

    // The real call then deletes the file and cancels the schedule.
    const real = await rpc(
      served.keyed,
      'bureau.workflows.delete',
      { id: 'digest', expectedHash: hash },
      'workflows-writer-key',
    );
    expect(real.error).toBeUndefined();
    const cancelled = await served.bureau.schedules.get('bureau-workflow-schedule:digest:1');
    expect(cancelled?.status).toBe('cancelled');
  });

  it('answers the fault the real call answers for a workflow that is missing, at another hash, or not the caller’s', async () => {
    const { served, hash } = await serve();
    await expectSameFaultAsTheRealCall(
      writerOf(served),
      'bureau.workflows.delete',
      { id: 'no-such-workflow', expectedHash: hash },
      'workflows-writer-key',
    );
    await expectSameFaultAsTheRealCall(
      writerOf(served),
      'bureau.workflows.delete',
      { id: 'digest', expectedHash: 'a-hash-the-file-does-not-hold' },
      'workflows-writer-key',
    );
    await expectSameFaultAsTheRealCall(
      writerOf(served),
      'bureau.workflows.delete',
      { id: 'digest', expectedHash: hash },
      'alice-key',
    );
    // The stale hash is a StaleRevision naming the hash now on disk, which a retry reads.
    const stale = await rpc(
      served.keyed,
      'bureau.workflows.delete',
      { id: 'digest', expectedHash: 'a-hash-the-file-does-not-hold', dryRun: true },
      'workflows-writer-key',
    );
    expect(stale.error?.data).toMatchObject({ weftCode: 'StaleRevision', currentRevision: hash });
  });
});

describe('bureau.schedules.cancel with dryRun, on the schedule of a workflow file', () => {
  it('answers the NotFound the real call answers: only bureau.workflows.* change that schedule', async () => {
    const { served } = await serve();
    await expectSameFaultAsTheRealCall(
      writerOf(served),
      'bureau.schedules.cancel',
      { scheduleId: 'bureau-workflow-schedule:digest:1' },
      'schedules-writer-key',
    );
    const schedule = await served.bureau.schedules.get('bureau-workflow-schedule:digest:1');
    expect(schedule?.status).toBe('active');
  });
});

describe('bureau.workflows.runs.cancel with dryRun', () => {
  it('counts the instance it would cancel, writes nothing and leaves the instance running', async () => {
    const { served, subject } = await serve();

    const body = await expectNothingWritten(subject, () =>
      rpc(
        served.keyed,
        'bureau.workflows.runs.cancel',
        { runId: 'digest-run', dryRun: true },
        'workflows-writer-key',
      ),
    );

    expect(dryRunResultOf(body)).toEqual({
      dryRun: true,
      target: { kind: 'workflow-run', id: 'digest-run' },
      effects: [{ kind: 'running-instances', count: 1 }],
    });
    const run = await served.bureau.workflows!.getRun('digest-run');
    expect(run?.status).toBe('running');

    // The real call then requests the cancellation.
    const real = await rpc(
      served.keyed,
      'bureau.workflows.runs.cancel',
      { runId: 'digest-run' },
      'workflows-writer-key',
    );
    expect(real.result).toEqual({ runId: 'digest-run', status: 'cancel-requested' });
  });

  it('answers the fault the real call answers for a run that is missing or not the caller’s', async () => {
    const { served } = await serve();
    await expectSameFaultAsTheRealCall(
      writerOf(served),
      'bureau.workflows.runs.cancel',
      { runId: 'no-such-run' },
      'workflows-writer-key',
    );
    await expectSameFaultAsTheRealCall(
      writerOf(served),
      'bureau.workflows.runs.cancel',
      { runId: 'digest-run' },
      'alice-key',
    );
  });

  it('answers the NotFound the real call answers for a run of a code workflow whose plugin is not loaded', async () => {
    const database = createSqliteStorageFixture();
    cleanups.push(() => database.dispose());
    const kit = {
      descriptor: definePlugin({
        name: 'kit',
        version: '1.0.0',
        description: 'Contributes a code workflow.',
        setup: () => ({
          workflows: [
            {
              ...workflow({ name: 'wait' }).execute(async function* (context) {
                yield* context.waitForSignal('go');
                return 'went';
              }),
              title: 'Wait',
              inputSchema: z.unknown(),
            } satisfies PluginWorkflow,
          ],
        }),
      }),
      source: 'package' as const,
      location: '@example/kit',
    };
    const loaded: Array<() => Promise<void>> = [];
    const first = await serveWorkflows(loaded, { storage: database.open(), plugins: [kit] });
    const started = await first.bureau.workflows!.start('kit:wait', { owner: 'anonymous:local' });
    for (const cleanup of loaded.splice(0).toReversed()) await cleanup();

    // The plugin is disabled: the run is still listed, waiting, but the real cancel does not find it.
    const second = await serveWorkflows(cleanups, { storage: database.open() });
    const run = await second.bureau.workflows!.getRun(started.runId);
    expect(run?.unresumable).toMatchObject({ reason: 'missing' });
    await expectSameFaultAsTheRealCall(
      writerOf(second),
      'bureau.workflows.runs.cancel',
      { runId: started.runId },
      'workflows-writer-key',
    );
  });
});
