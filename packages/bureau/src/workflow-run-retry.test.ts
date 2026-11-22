/**
 * COR-2424 — a failed instance of a workflow file runs again from the step it failed at
 * (`workflows.retryRun`): in place, on the version it ran, with every step before it kept and
 * never run again, and an `agent` step's run under an id of the retry's own, so the step that
 * failed does not find the run that failed it. Each refusal changes nothing.
 */
import { rm } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'bun:test';

import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { waitUntil } from '@lostgradient/testing/wait-until';

import {
  startWorkflowBureau,
  type WorkflowBureauHarness,
} from './testing/workflow-bureau.test-support';
import { workflowFileText } from './testing/workflow-file-fixtures.test-support';
import { workflowStepRunId } from './workflow-agent-step';
import { createWorkflowRetryReceipts, WORKFLOW_RETRY_KEY_PREFIX } from './workflow-retry-receipts';
import { WorkflowRetryRefusedError } from './workflow-run-retry';

const harnesses: WorkflowBureauHarness[] = [];
/** Directories a test took over from a harness it disposed of early. */
const directories: string[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0).toReversed()) await harness.dispose();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const OWNER = 'anonymous:local';

const twoSteps = {
  trigger: { kind: 'manual' },
  steps: [
    {
      title: 'Write it',
      kind: 'activity',
      handler: 'agent',
      input: { agent: 'writer', message: 'Write.' },
    },
    {
      title: 'Edit it',
      kind: 'activity',
      handler: 'agent',
      input: { agent: 'editor', message: 'Edit.' },
    },
  ],
};

async function failingHarness(storage = new MemoryStorage()) {
  const control = { failing: true };
  const harness = await startWorkflowBureau({
    overrides: { storage, onDiagnostic: () => undefined },
    replies: {
      writer: () => 'the draft',
      editor: () => {
        if (control.failing) throw new Error('the editor is down');
        return 'the edit';
      },
    },
  });
  harnesses.push(harness);
  await harness.putWorkflow('notes', twoSteps);
  return { harness, control };
}

async function runOf(harness: WorkflowBureauHarness, runId: string) {
  const run = await harness.bureau.workflows?.getRun(runId);
  return run;
}

async function engineStatus(harness: WorkflowBureauHarness, runId: string) {
  const state = await harness.bureau.durableEngine()!.get(runId);
  return state?.status;
}

async function settled(harness: WorkflowBureauHarness, runId: string, status: string) {
  await waitUntil(
    async () => {
      const run = await runOf(harness, runId);
      return run?.status === status;
    },
    { message: `run ${runId} to be ${status}` },
  );
}

async function failedRun(harness: WorkflowBureauHarness): Promise<string> {
  const { runId } = await harness.bureau.workflows!.start('notes', { owner: OWNER });
  await settled(harness, runId, 'failed');
  return runId;
}

async function refusal(work: Promise<unknown>): Promise<string> {
  const error = await rejectionOf(work);
  if (!(error instanceof WorkflowRetryRefusedError)) throw error;
  return error.code;
}

const agentCalls = (harness: WorkflowBureauHarness, agent: string) =>
  harness.calls.filter((call) => call.agent === agent);

describe('retrying a failed workflow run from its failed step', () => {
  it('runs the failed agent step again under a run of its own, keeping step 1’s result', async () => {
    const { harness, control } = await failingHarness();
    const runId = await failedRun(harness);
    const writerCalls = agentCalls(harness, 'writer').length;
    expect(writerCalls).toBe(1);

    control.failing = false;
    const answer = await harness.bureau.workflows!.retryRun(runId, { step: 2, retryId: 'one' });
    expect(answer).toMatchObject({ runId, step: 2, retryId: 'one' });
    await settled(harness, runId, 'completed');

    expect(agentCalls(harness, 'writer')).toHaveLength(1);
    const edits = agentCalls(harness, 'editor');
    expect(edits.length).toBeGreaterThan(1);
    expect(edits.at(-1)?.message).toContain('the draft');
    const run = await runOf(harness, runId);
    expect(run?.result).toMatchObject({ content: 'the edit' });
    // The step ran under the first retry's own id; the run that failed keeps the id it always had
    // (it ended with a failure finish reason, which the engine records as a finished run).
    expect(await engineStatus(harness, workflowStepRunId(runId, 1))).toBeDefined();
    expect(await engineStatus(harness, workflowStepRunId(runId, 1, 1))).toBe('completed');
  });

  it('reads the output name of the version a run ran, and null for a file without one', async () => {
    const { harness, control } = await failingHarness();
    control.failing = false;
    const plain = await harness.bureau.workflows!.start('notes', { owner: OWNER });
    await settled(harness, plain.runId, 'completed');
    const before = await runOf(harness, plain.runId);
    expect(before?.outputName).toBeNull();

    await harness.putWorkflow('notes', { ...twoSteps, outputName: 'notes' });
    const named = await harness.bureau.workflows!.start('notes', { owner: OWNER });
    await settled(harness, named.runId, 'completed');
    const after = await runOf(harness, named.runId);
    expect(after?.outputName).toBe('notes');
  });

  it('keeps the id every run had before retries existed for generation 0', () => {
    expect(workflowStepRunId('victim-run', 0)).toBe(workflowStepRunId('victim-run', 0, 0));
    expect(workflowStepRunId('victim-run', 0, 1)).not.toBe(workflowStepRunId('victim-run', 0));
  });

  it('answers a repeated request with its retryId as the first did, and reactivates once', async () => {
    const { harness, control } = await failingHarness();
    const runId = await failedRun(harness);
    control.failing = false;
    const first = await harness.bureau.workflows!.retryRun(runId, { step: 2, retryId: 'same' });
    const again = await harness.bureau.workflows!.retryRun(runId, { step: 2, retryId: 'same' });
    expect(again).toEqual(first);
    await settled(harness, runId, 'completed');
    expect(await refusal(harness.bureau.workflows!.retryRun(runId, { step: 2 }))).toBe(
      'run-not-failed',
    );
    expect(
      await refusal(harness.bureau.workflows!.retryRun(runId, { step: 2, retryId: 'other' })),
    ).toBe('run-not-failed');
  });

  it('finishes a request that stopped after its receipt, without a second generation', async () => {
    const storage = new MemoryStorage();
    const { harness, control } = await failingHarness(storage);
    const runId = await failedRun(harness);
    // The receipt a crash left behind: the request recorded, the instance not yet reactivated.
    const receipts = createWorkflowRetryReceipts({ store: textValueStore(storage) });
    await receipts.put({
      schemaVersion: 1,
      runId,
      generation: 1,
      pending: { retryId: 'crashed', step: 2, requestedAt: new Date(0).toISOString() },
      applied: null,
    });
    control.failing = false;
    await harness.bureau.workflows!.retryRun(runId, { step: 2, retryId: 'crashed' });
    await settled(harness, runId, 'completed');
    const receipt = await receipts.get(runId);
    expect(receipt?.generation).toBe(1);
    expect(receipt?.applied?.retryId).toBe('crashed');
    expect(receipt?.pending).toBeNull();
    expect(await storage.get(`${WORKFLOW_RETRY_KEY_PREFIX}${runId}`)).not.toBeNull();
  });

  it('does not reactivate again for a repeated request whose retry already ran and failed again', async () => {
    const storage = new MemoryStorage();
    const { harness } = await failingHarness(storage);
    const runId = await failedRun(harness);
    const engine = harness.bureau.durableEngine()!;
    const firstFailure = (await engine.get(runId))!.updatedAt;
    // The editor stays down: the retry reactivates the run and the step fails again.
    await harness.bureau.workflows!.retryRun(runId, { step: 2, retryId: 'x' });
    await waitUntil(
      async () => {
        const state = await engine.get(runId);
        return state?.status === 'failed' && state.updatedAt !== firstFailure;
      },
      { message: 'the retried step to fail again' },
    );
    const calls = agentCalls(harness, 'editor').length;
    // The crash: the retry committed, but its `applied` record was never written.
    const receipts = createWorkflowRetryReceipts({ store: textValueStore(storage) });
    await receipts.put({
      schemaVersion: 1,
      runId,
      generation: 1,
      pending: {
        retryId: 'x',
        step: 2,
        requestedAt: new Date(0).toISOString(),
        failureAt: firstFailure,
      },
      applied: null,
    });
    // The client repeats the request: it is answered as the first was, and runs nothing.
    const again = await harness.bureau.workflows!.retryRun(runId, { step: 2, retryId: 'x' });
    expect(again).toMatchObject({ runId, step: 2, retryId: 'x' });
    expect(agentCalls(harness, 'editor')).toHaveLength(calls);
    const final = await engine.get(runId);
    expect(final?.status).toBe('failed');
    const receipt = await receipts.get(runId);
    expect(receipt?.generation).toBe(1);
    expect(receipt?.pending).toBeNull();
    expect(receipt?.applied?.retryId).toBe('x');
  });

  it('refuses a step that is not the one the run failed at, or not one of its steps', async () => {
    const { harness, control } = await failingHarness();
    const runId = await failedRun(harness);
    control.failing = false;
    const workflows = harness.bureau.workflows!;
    expect(await refusal(workflows.retryRun(runId, { step: 1 }))).toBe('step-completed');
    expect(await refusal(workflows.retryRun(runId, { step: 3 }))).toBe('step-not-found');
    expect(await refusal(workflows.retryRun(runId, { step: 0 }))).toBe('step-not-found');
    const run = await runOf(harness, runId);
    expect(run?.status).toBe('failed');
    expect(agentCalls(harness, 'writer')).toHaveLength(1);
  });

  it('refuses a step after the one the run failed at', async () => {
    const control = { failing: true };
    const harness = await startWorkflowBureau({
      overrides: { onDiagnostic: () => undefined },
      replies: {
        writer: () => {
          if (control.failing) throw new Error('the writer is down');
          return 'the draft';
        },
      },
    });
    harnesses.push(harness);
    await harness.putWorkflow('notes', twoSteps);
    const runId = await failedRun(harness);
    expect(await refusal(harness.bureau.workflows!.retryRun(runId, { step: 2 }))).toBe(
      'earlier-steps-incomplete',
    );
  });

  it('refuses a run that has not failed, and answers NOT_FOUND for a run that is no instance', async () => {
    const { harness, control } = await failingHarness();
    control.failing = false;
    const { runId } = await harness.bureau.workflows!.start('notes', { owner: OWNER });
    await settled(harness, runId, 'completed');
    expect(await refusal(harness.bureau.workflows!.retryRun(runId, { step: 2 }))).toBe(
      'run-not-failed',
    );
    const missing = await rejectionOf(
      harness.bureau.workflows!.retryRun('no-such-run', { step: 1 }),
    );
    expect((missing as { code?: string }).code).toBe('NOT_FOUND');
  });

  it('refuses a run whose result broke the output schema: it failed outside a step', async () => {
    const harness = await startWorkflowBureau({
      overrides: { onDiagnostic: () => undefined },
      replies: { writer: () => 'the draft' },
    });
    harnesses.push(harness);
    await harness.putWorkflow('notes', {
      ...twoSteps,
      steps: [twoSteps.steps[0]],
      outputSchema: { type: 'string' },
    });
    const runId = await failedRun(harness);
    expect(await refusal(harness.bureau.workflows!.retryRun(runId, { step: 1 }))).toBe(
      'step-not-retryable',
    );
  });

  it('runs again on the version it ran after the file changed and the Bureau restarted', async () => {
    const storage = new MemoryStorage();
    const { harness, control } = await failingHarness(storage);
    const runId = await failedRun(harness);
    const ran = await runOf(harness, runId);
    const ranVersion = ran?.workflowVersion;
    // A new version of the file, then a new Bureau over the same storage: the failed run's version
    // is not in flight, so the boot does not register it.
    await harness.put(
      'notes.json',
      workflowFileText('notes', {
        ...twoSteps,
        steps: [...twoSteps.steps, { kind: 'sleep', duration: 1 }],
      }),
    );
    await harness.bureau.workflows!.refresh();
    const directory = harness.directory;
    await harness.bureau.dispose();
    harnesses.splice(harnesses.indexOf(harness), 1);
    directories.push(directory);

    const second = await startWorkflowBureau({
      directory,
      overrides: { storage, onDiagnostic: () => undefined },
      replies: { writer: () => 'the draft', editor: () => 'the edit' },
    });
    harnesses.push(second);
    control.failing = false;
    const answer = await second.bureau.workflows!.retryRun(runId, { step: 2 });
    expect(answer.workflowVersion).toBe(ranVersion!);
    await settled(second, runId, 'completed');
    expect(agentCalls(second, 'writer')).toHaveLength(0);
  });

  it('refuses version-unavailable when the version the run ran is no longer stored', async () => {
    const storage = new MemoryStorage();
    const { harness } = await failingHarness(storage);
    const runId = await failedRun(harness);
    const ran = await runOf(harness, runId);
    const version = ran!.workflowVersion;
    await harness.put(
      'notes.json',
      workflowFileText('notes', {
        ...twoSteps,
        steps: [...twoSteps.steps, { kind: 'sleep', duration: 1 }],
      }),
    );
    await harness.bureau.workflows!.refresh();
    await storage.delete(`bureau-workflow-snapshot:v1:notes:${version}`);
    expect(await refusal(harness.bureau.workflows!.retryRun(runId, { step: 2 }))).toBe(
      'version-unavailable',
    );
    const after = await runOf(harness, runId);
    expect(after?.status).toBe('failed');
  });

  it('COR-2533: runs the step the instance failed at when the request names none', async () => {
    const { harness, control } = await failingHarness();
    const runId = await failedRun(harness);
    control.failing = false;
    const answer = await harness.bureau.workflows!.retryRun(runId, { retryId: 'no-step' });
    expect(answer).toMatchObject({ runId, step: 2, retryId: 'no-step' });
    await settled(harness, runId, 'completed');
    expect(agentCalls(harness, 'writer')).toHaveLength(1);
  });

  it('COR-2533: refuses a request that names no step for an instance that is not failed', async () => {
    const { harness, control } = await failingHarness();
    control.failing = false;
    const { runId } = await harness.bureau.workflows!.start('notes', { owner: OWNER });
    await settled(harness, runId, 'completed');
    expect(await refusal(harness.bureau.workflows!.retryRun(runId, {}))).toBe('run-not-failed');
  });
});

describe('the step a retry would run (COR-2533)', () => {
  it('is the step the instance failed at, and changes nothing', async () => {
    const { harness } = await failingHarness();
    const runId = await failedRun(harness);
    expect(await harness.bureau.workflows!.retryableStep(runId)).toBe(2);
    expect(await harness.bureau.workflows!.retryableStep(runId)).toBe(2);
    expect(await engineStatus(harness, runId)).toBe('failed');
    expect(agentCalls(harness, 'editor')).toHaveLength(1);
  });

  it('is undefined for an instance that completed, and for a run that is no instance', async () => {
    const { harness, control } = await failingHarness();
    control.failing = false;
    const { runId } = await harness.bureau.workflows!.start('notes', { owner: OWNER });
    await settled(harness, runId, 'completed');
    expect(await harness.bureau.workflows!.retryableStep(runId)).toBeUndefined();
    expect(await harness.bureau.workflows!.retryableStep('no-such-run')).toBeUndefined();
  });

  it('is undefined when the version the instance ran can no longer run', async () => {
    const storage = new MemoryStorage();
    const { harness } = await failingHarness(storage);
    const runId = await failedRun(harness);
    const version = (await runOf(harness, runId))!.workflowVersion;
    await harness.put(
      'notes.json',
      workflowFileText('notes', {
        ...twoSteps,
        steps: [...twoSteps.steps, { kind: 'sleep', duration: 1 }],
      }),
    );
    await harness.bureau.workflows!.refresh();
    await storage.delete(`bureau-workflow-snapshot:v1:notes:${version}`);
    expect(await harness.bureau.workflows!.retryableStep(runId)).toBeUndefined();
  });
});
