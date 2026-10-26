/**
 * COR-1527 — a workflow file's `schedule` trigger fires on the engine's own wall clock, so these
 * tests wait real seconds (a schedule of 1 s, and the scheduler's one-second poll) and live in the
 * slow lane. The waits are the schedule's cadence and the absence of a fire after a pause or a
 * delete; none of them stands in for a hang.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { AGENT_STEP, workflowFileText } from './testing/workflow-file-fixtures.test-support';
import {
  type AgentCall,
  startWorkflowBureau,
  type WorkflowBureauHarness,
} from './testing/workflow-bureau.test-support';

const WALL_CLOCK_TIMEOUT_MS = 30_000;
const harnesses: WorkflowBureauHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
});

async function waitForReal(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
): Promise<boolean> {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

/** A writer whose first call waits for `release()`, so an instance can be held mid-step. */
function gatedFirstCall() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let calls = 0;
  return {
    release: open,
    reply: async (_call: AgentCall): Promise<string> => {
      calls += 1;
      if (calls === 1) await gate;
      return 'done';
    },
  };
}

const EVERY_SECOND = { kind: 'schedule', spec: '1s', overlap: 'allow' };

async function instancesOf(harness: WorkflowBureauHarness, workflow: string) {
  const page = await harness.bureau.durableEngine()!.list({ type: workflow });
  return page.items;
}

async function instanceCount(harness: WorkflowBureauHarness, workflow: string): Promise<number> {
  const items = await instancesOf(harness, workflow);
  return items.length;
}

async function scheduleStatus(
  harness: WorkflowBureauHarness,
  id: string,
): Promise<string | undefined> {
  const summary = await harness.bureau.getSchedule(id);
  return summary?.status;
}

async function allCompleted(harness: WorkflowBureauHarness, workflow: string): Promise<boolean> {
  const items = await instancesOf(harness, workflow);
  return items.every((item) => item.status === 'completed');
}

describe('a workflow’s schedule firing', () => {
  it('starts one instance with the fire as its trigger, which the agent step sends as a labelled block', async () => {
    const harness = await startWorkflowBureau({ replies: { writer: () => 'tick answer' } });
    harnesses.push(harness);
    await harness.put(
      'digest.json',
      workflowFileText('digest', {
        trigger: { kind: 'schedule', spec: '1s' },
        steps: [AGENT_STEP],
      }),
    );
    await harness.bureau.workflows?.refresh();

    expect(await waitForReal(() => harness.calls.length >= 1)).toBe(true);
    // Stop further fires before looking, so the count is stable.
    const hash = harness.bureau.workflows!.list()[0]!.hash!;
    await harness.bureau.workflows!.pause('digest', { expectedHash: hash });

    const message = harness.calls[0]!.message;
    expect(message.startsWith('Write the digest\n\nTrigger:\n```json\n')).toBe(true);
    expect(message).toContain('"kind": "schedule"');
    expect(message).toContain('"scheduleId": "bureau-workflow-schedule:digest:1"');
    const instances = await instancesOf(harness, 'digest');
    expect(instances.length).toBeGreaterThanOrEqual(1);
    const first = await harness.bureau.workflows!.getRun(instances.at(-1)!.id);
    expect(first?.trigger).toEqual({
      kind: 'schedule',
      scheduleId: 'bureau-workflow-schedule:digest:1',
    });
  });

  it('starts nothing new once the workflow is paused, while an instance already running completes', async () => {
    const gated = gatedFirstCall();
    const harness = await startWorkflowBureau({ replies: { writer: gated.reply } });
    harnesses.push(harness);
    await harness.put(
      'digest.json',
      workflowFileText('digest', { trigger: EVERY_SECOND, steps: [AGENT_STEP] }),
    );
    await harness.bureau.workflows?.refresh();
    // The first fire is held in the agent step.
    expect(await waitForReal(() => harness.calls.length >= 1)).toBe(true);

    const hash = harness.bureau.workflows!.list()[0]!.hash!;
    await harness.bureau.workflows!.pause('digest', { expectedHash: hash });
    const before = await instanceCount(harness, 'digest');

    // Three more seconds: with `overlap: 'allow'` a live schedule would have fired about three times.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await instanceCount(harness, 'digest')).toBe(before);

    gated.release();
    expect(
      await waitForReal(async () => {
        const items = await instancesOf(harness, 'digest');
        return items.length === before && items.every((item) => item.status === 'completed');
      }),
    ).toBe(true);
  });

  it('starts nothing once the file is deleted, cancels the schedule, and lets a running instance complete', async () => {
    const gated = gatedFirstCall();
    const harness = await startWorkflowBureau({ replies: { writer: gated.reply } });
    harnesses.push(harness);
    await harness.put(
      'digest.json',
      workflowFileText('digest', { trigger: EVERY_SECOND, steps: [AGENT_STEP] }),
    );
    await harness.bureau.workflows?.refresh();
    expect(await waitForReal(() => harness.calls.length >= 1)).toBe(true);

    const hash = harness.bureau.workflows!.list()[0]!.hash!;
    await harness.bureau.workflows!.delete('digest', { expectedHash: hash });
    expect(await scheduleStatus(harness, 'bureau-workflow-schedule:digest:1')).toBe('cancelled');
    const before = await instanceCount(harness, 'digest');

    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await instanceCount(harness, 'digest')).toBe(before);

    gated.release();
    expect(await waitForReal(() => allCompleted(harness, 'digest'))).toBe(true);
  });
});
