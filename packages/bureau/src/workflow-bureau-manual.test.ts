/**
 * COR-1527 — under `durableBackgroundTasks: 'manual'` a step that a restart runs again waits for
 * its recovered agent run through the engine's own handle, which maintenance drives, and not
 * through `waitForDurableRun`, which refuses to wait in that mode. An agent step also adopts an
 * existing run at its derived id only when that run carries the step's own marker.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { startWorkflowBureau } from './testing/workflow-bureau.test-support';
import { workflowFileText } from './testing/workflow-file-fixtures.test-support';
import { workflowStepRunId } from './workflow-agent-step';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const step = {
  kind: 'activity',
  handler: 'agent',
  input: { agent: 'writer', message: 'midstep question' },
};

describe('an agent step that a restart runs again', () => {
  it('waits for its recovered run under durableBackgroundTasks: manual, and completes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bureau-workflow-manual-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workflows = join(root, 'workflows');
    const storage = { type: 'sqlite', path: join(root, 'bureau.sqlite') } as const;
    const file = workflowFileText('midstep', {
      trigger: { kind: 'schedule', spec: '1h' },
      steps: [step],
    });

    const first = await startWorkflowBureau({
      directory: workflows,
      overrides: {
        storage,
        durableOwnership: { ownership: 'none' },
        onDiagnostic: () => undefined,
      },
      replies: { writer: () => new Promise<never>(() => {}) },
    });
    await first.put('midstep.json', file);
    await first.bureau.workflows?.refresh();
    await first.bureau.durableEngine()!.start('midstep', null, { id: 'midstep-run' });
    for (let attempt = 0; first.calls.length < 1 && attempt < 1000; attempt += 1)
      await Bun.sleep(5);
    await first.bureau.shutdown();

    const second = await startWorkflowBureau({
      directory: workflows,
      overrides: {
        storage,
        durableOwnership: { ownership: 'none' },
        durableBackgroundTasks: 'manual',
        onDiagnostic: () => undefined,
      },
      // Slow enough that the re-run step finds its agent run still in flight.
      replies: { writer: async () => (await Bun.sleep(300), 'answered') },
    });
    cleanups.push(() => second.dispose());
    await second.bureau.waitForRecovery?.();
    for (let attempt = 0; attempt < 400; attempt += 1) {
      await second.bureau.runDurableMaintenance();
      const state = await second.bureau.getDurableRun('midstep-run');
      if (state?.status !== 'running' && state?.status !== 'pending') break;
      await Bun.sleep(25);
    }

    const state = await second.bureau.getDurableRun('midstep-run');
    expect(state?.error).toBeUndefined();
    expect(state?.status).toBe('completed');
    const summary = state?.result as { content: string } | undefined;
    expect(summary?.content).toBe('answered');
  });

  it('refuses to adopt a run at its derived id that is not its own, and fails with a clear error', async () => {
    const harness = await startWorkflowBureau({});
    cleanups.push(() => harness.dispose());
    await harness.put(
      'midstep.json',
      workflowFileText('midstep', { trigger: { kind: 'schedule', spec: '1h' }, steps: [step] }),
    );
    await harness.put(
      'other.json',
      workflowFileText('other', {
        trigger: { kind: 'schedule', spec: '1h' },
        steps: [{ kind: 'sleep', duration: 1 }],
      }),
    );
    await harness.bureau.workflows?.refresh();
    const engine = harness.bureau.durableEngine()!;
    // Some other run sits at the id this step's agent run would have.
    const stepRunId = workflowStepRunId('victim-run', 0);
    const squatter = await engine.start('other', null, { id: stepRunId });
    await squatter.result();

    const victim = await engine.start('midstep', null, { id: 'victim-run' });
    await victim.result().catch(() => undefined);

    const detail = await harness.bureau.workflows?.getRun('victim-run');
    expect(detail?.status).toBe('failed');
    expect(detail?.error).toContain('is held by another run');
    expect(harness.calls).toEqual([]);
  });
});
