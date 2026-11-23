/**
 * COR-2635: a workflow run forks on the Bureau's durable engine under the Bureau's default
 * ownership posture (`workflow-lease`), the engine Interborough's host serves. The fixture sets no
 * `durableOwnership`, so the fork runs exactly as it does in production, where it used to fail with
 * `EngineDeposedError` because the fork's create batch was fenced on a claim nothing had taken.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { MemoryStorage } from '@lostgradient/storage';

import { waitForCondition } from '../../test';
import { AGENT_STEP, FAST_SCHEDULE } from '../../testing/workflow-file-fixtures.test-support.ts';
import { serveWorkflows } from './workflows-fixtures.test-support.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** The keys of `storage` that hold `workflowId`'s ownership-claim epoch, under any scope prefix. */
async function claimEpochKeys(storage: MemoryStorage, workflowId: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const [key] of storage.scan('')) {
    if (key.endsWith(`wf-owner-epoch:${workflowId}`)) keys.push(key);
  }
  return keys;
}

describe('a workflow run forked on the Bureau’s durable engine', () => {
  it('completes under the Bureau’s default ownership, claiming the fork’s own id', async () => {
    const storage = new MemoryStorage();
    const served = await serveWorkflows(cleanups, { storage });
    await served.bureau.workflows!.create('digest', {
      agent: 'writer',
      trigger: FAST_SCHEDULE,
      steps: [AGENT_STEP, AGENT_STEP],
    });
    const engine = served.bureau.durableEngine()!;
    const { runId } = await served.bureau.workflows!.start('digest', { owner: 'api-key:alice' });
    await waitForCondition(async () => {
      const state = await engine.get(runId);
      return state?.status === 'completed';
    }, 'the source run completes');
    // The source ran under a claim of its own, so the engine is in its default `workflow-lease` posture.
    expect(await claimEpochKeys(storage, runId)).toHaveLength(1);

    const fork = await engine.fork(runId);
    await fork.result();

    expect(await engine.get(fork.id)).toMatchObject({
      status: 'completed',
      forkedFrom: { workflowId: runId },
    });
    // The fork's create batch claimed the fork's id; the claim was released at its terminal write.
    expect(await claimEpochKeys(storage, fork.id)).toHaveLength(1);
    expect(await engine.claimHolder(fork.id)).toBeUndefined();
  });
});
