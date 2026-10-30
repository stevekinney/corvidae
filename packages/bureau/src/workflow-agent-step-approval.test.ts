/**
 * COR-1913 — an `agent` step of a workflow runs its agent with no one to ask. A tool call that
 * needs a person's approval cannot get one there, so under the default `toolApproval` (`on-changes`)
 * a tool that changes something fails the step visibly instead of looking finished with the change
 * never made. A tool the file sets to `never` runs and applies.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { agentStepResultFromState, workflowStepRunId } from './workflow-agent-step';
import {
  startWorkflowToolsBureau,
  type WorkflowToolsHarness,
} from './testing/workflow-tools-bureau.test-support';

const harnesses: WorkflowToolsHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
});

const FALLBACK_KEY = 'decisions.fallbackModel';
const FALLBACK_VALUE = 'anthropic/workflow-chosen';

/** A Bureau whose `tuner` file agent calls `settings-update` from a workflow's agent step. */
async function start(approval: 'never' | 'default') {
  const harness = await startWorkflowToolsBureau({
    agents: [],
    overrides: { agentApprovalSecret: 'workflow-step-secret' },
  });
  harnesses.push(harness);
  await harness.putAgent('tuner', ['settings-update'], { approval });
  await mkdir(harness.workflowsPath, { recursive: true });
  await writeFile(
    join(harness.workflowsPath, 'tune.json'),
    JSON.stringify({
      name: 'tune',
      trigger: { kind: 'schedule', spec: '1h' },
      steps: [
        { kind: 'activity', handler: 'agent', input: { agent: 'tuner', message: 'Tune it.' } },
      ],
    }),
  );
  await harness.bureau.workflows?.refresh();
  harness.plan('settings-update', {
    patch: { [FALLBACK_KEY]: FALLBACK_VALUE },
    expectedRevision: 0,
  });
  return harness;
}

async function instance(harness: WorkflowToolsHarness, id: string) {
  const engine = harness.bureau.durableEngine();
  if (engine === undefined) throw new Error('Expected a durable engine.');
  const run = await engine.start('tune', null, { id });
  const outcome: { result?: unknown; error?: unknown } = await run.result().then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  return { state: await engine.get(id), ...outcome };
}

describe('a workflow’s agent step that calls a tool that changes something', () => {
  it('fails visibly under the default policy, names the tool and the way out, and changes nothing', async () => {
    const harness = await start('default');

    const { state, result } = await instance(harness, 'default-policy');

    expect(result).toBeUndefined();
    expect(state?.status).toBe('failed');
    expect(state?.error).toContain('"settings-update"');
    expect(state?.error).toContain('toolApproval');
    const settings = await harness.bureau.settings.get();
    expect(settings.values[FALLBACK_KEY]).not.toBe(FALLBACK_VALUE);
    // Nothing waits for a person either: no review was raised for a step no one can answer.
    expect(harness.bureau.reviews.list()).toEqual([]);
  });

  it('records the failure in the step run’s own result, so a restart that finds it finished fails the step the same way', async () => {
    const harness = await start('default');

    await instance(harness, 'recorded');

    const engine = harness.bureau.durableEngine();
    const stepRun = await engine?.get(workflowStepRunId('recorded', 0));
    // The run itself finished as a success, as a restart will find it.
    expect(stepRun?.status).toBe('completed');
    expect(stepRun?.result).toMatchObject({
      finishReason: 'stop-condition',
      toolNeedingApproval: 'settings-update',
    });
    expect(() => agentStepResultFromState('tuner', stepRun)).toThrow(/"settings-update"/);
  });

  it('applies the change when the file sets the tool to never', async () => {
    const harness = await start('never');

    const { state, result } = await instance(harness, 'never-policy');

    expect(state?.status).toBe('completed');
    expect(result).toMatchObject({ finishReason: 'stop-condition' });
    const settings = await harness.bureau.settings.get();
    expect(settings.values[FALLBACK_KEY]).toBe(FALLBACK_VALUE);
  });
});
