/**
 * COR-2543 — the `tasks-explain` agent tool over a real Bureau and a real file agent: it explains a
 * failed run from what is stored, for a run the calling run owns and no other, and it exists on a
 * Bureau that has agents and no workflow directory.
 */
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  startWorkflowToolsBureau,
  type WorkflowToolsHarness,
} from './testing/workflow-tools-bureau.test-support';

const harnesses: WorkflowToolsHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0).toReversed()) await harness.dispose();
});

const TOOL = 'bureau__tasks-explain';
const OTHER_OWNER = { principal: 'api-key:a2a' } as const;
const FAILING_MESSAGE = 'make this run fail';
const SECRET = 'PRIVATE-PROVIDER-TEXT-7c1e';

/** A model that fails the runs whose message says so, with text that must never be answered. */
const failing = async (message: string): Promise<void> => {
  if (message.includes(FAILING_MESSAGE)) throw new Error(`the provider failed: ${SECRET}`);
};

describe('the tasks-explain tool on a Bureau with agents and no workflow directory', () => {
  async function start(): Promise<WorkflowToolsHarness> {
    const harness = await startWorkflowToolsBureau({
      withoutWorkflowDirectory: true,
      beforeGenerate: failing,
    });
    harnesses.push(harness);
    expect(harness.bureau.workflows).toBeUndefined();
    await harness.putAgent('scribe', ['bureau:tasks-explain']);
    return harness;
  }

  async function failedRun(harness: WorkflowToolsHarness): Promise<string> {
    const run = await harness.bureau.tasks.start('scribe', FAILING_MESSAGE);
    await waitUntil(
      async () => {
        const task = await harness.bureau.tasks.get(run.id);
        return task?.status === 'failed';
      },
      { message: 'the run failed' },
    );
    await harness.bureau.internals.taskRegistry.flush();
    return run.id;
  }

  it('lets an agent read why its own owner’s failed run failed, with no message or stack', async () => {
    const harness = await start();
    const runId = await failedRun(harness);

    const explained = await harness.callTool(TOOL, { runId });

    expect(explained.result).toMatchObject({
      status: 'ok',
      summary: expect.stringContaining('failed'),
      cause: { category: expect.any(String), kind: 'generate' },
      step: { label: 'model' },
      verdicts: [],
      remediation: expect.any(String),
      nextCommands: [`interborough runs get --kind task ${runId}`],
    });
    expect(JSON.stringify(explained.result)).not.toContain(SECRET);
  });

  it('answers a run another owner started as not-found, as one that does not exist is', async () => {
    const harness = await start();
    const runId = await failedRun(harness);

    const foreign = await harness.callTool(TOOL, { runId }, OTHER_OWNER);
    expect(foreign.result).toEqual({ status: 'not-found', id: runId });

    const missing = await harness.callTool(TOOL, { runId: 'no-such-run' });
    expect(missing.result).toEqual({ status: 'not-found', id: 'no-such-run' });
  });

  it('says a run that did not fail has nothing to explain', async () => {
    const harness = await start();
    const done = await harness.bureau.tasks.start('scribe', 'say hello');
    await done.result();

    const answered = await harness.callTool(TOOL, { runId: done.id });
    expect(answered.result).toEqual({
      status: 'not-failed',
      runId: done.id,
      runStatus: 'completed',
    });
  });
});

describe('the tasks-explain tool on a Bureau with workflow files', () => {
  it('explains a failed workflow instance, and answers another owner as not-found', async () => {
    const harness = await startWorkflowToolsBureau({ beforeGenerate: failing });
    harnesses.push(harness);
    await harness.putAgent('scribe', [
      'bureau:workflows-create',
      'bureau:workflows-start',
      'bureau:tasks-explain',
    ]);
    await harness.callTool('bureau__workflows-create', {
      name: 'Doomed',
      trigger: { kind: 'manual' },
      steps: [
        {
          kind: 'activity',
          handler: 'agent',
          input: { agent: 'scribe', message: FAILING_MESSAGE },
        },
      ],
    });
    const started = await harness.callTool('bureau__workflows-start', { id: 'doomed' });
    const runId = (started.result as { runId: string }).runId;
    await waitUntil(
      async () => {
        const instance = await harness.bureau.workflows!.getRun(runId);
        return instance?.status === 'failed';
      },
      { message: 'the workflow instance failed' },
    );

    const explained = await harness.callTool(TOOL, { runId });
    expect(explained.result).toMatchObject({
      status: 'ok',
      summary: expect.stringContaining('failed'),
      nextCommands: [`interborough runs get --kind workflow ${runId}`],
    });
    expect(JSON.stringify(explained.result)).not.toContain(SECRET);

    const foreign = await harness.callTool(TOOL, { runId }, OTHER_OWNER);
    expect(foreign.result).toEqual({ status: 'not-found', id: runId });
  });
});
