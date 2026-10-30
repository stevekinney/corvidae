/**
 * COR-1913 — the workflow and settings tools change the deployment, so a file agent that lists
 * them and states no `toolApproval` is asked about before each call (the agent default is
 * `on-changes`), and the read-only ones run. The tools declare their capability and a version,
 * because Armorer cannot issue an approval for a tool that has neither.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import {
  startWorkflowToolsBureau,
  type WorkflowToolsHarness,
} from './testing/workflow-tools-bureau.test-support';

const harnesses: WorkflowToolsHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
});

const TRIGGER = { kind: 'schedule', spec: '1h' };
const STEPS = [
  { kind: 'activity', handler: 'agent', input: { agent: 'scribe', message: 'Write the digest' } },
];

async function start() {
  const harness = await startWorkflowToolsBureau({
    agents: [],
    overrides: { agentApprovalSecret: 'workflow-tools-secret' },
  });
  harnesses.push(harness);
  await harness.putAgent('scribe', undefined, { approval: 'default' });
  return harness;
}

describe('a file agent that states no toolApproval', () => {
  it.each([
    ['workflows-create', { name: 'Digest', trigger: TRIGGER, steps: STEPS }],
    ['settings-update', { patch: { 'decisions.fallbackModel': 'a/b' }, expectedRevision: 0 }],
  ])('is asked before it calls %s, which parks the run on an approval', async (tool, args) => {
    const harness = await start();
    if (tool === 'settings-update')
      await harness.putAgent('scribe', [tool], { approval: 'default' });

    const called = await harness.callTool(tool, args);

    // The run stopped on the approval, so the model never saw an answer to record.
    expect(called.outcome).toBeUndefined();
    const review = harness.bureau.reviews.list().find((entry) => entry.runId === called.runId);
    expect(review).toMatchObject({ kind: 'tool-approval', agentName: 'scribe' });
    expect(review?.kind === 'tool-approval' && review.approval.toolName).toBe(tool);
    expect(review?.kind === 'tool-approval' && review.approval.approvalToken).toBeDefined();
    // Nothing was written before a person approved.
    expect(harness.bureau.workflows?.list()).toEqual([]);
  });

  it('is not asked before it calls workflows-list, which reads', async () => {
    const harness = await start();

    const called = await harness.callTool('workflows-list', {});

    expect(called.outcome).toBe('success');
    expect(harness.bureau.reviews.list()).toEqual([]);
  });
});
