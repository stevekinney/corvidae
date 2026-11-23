/**
 * COR-2542 — the `runs-timeline` agent tool over a real Bureau and a real file agent: it reads a
 * run's step timeline with the run's status and no payload, for a run the calling run owns and no
 * other, and it exists on a Bureau that has agents and no workflow directory.
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

const TOOL = 'bureau__runs-timeline';
const OTHER_OWNER = { principal: 'api-key:a2a' } as const;

const STEPS = [
  { kind: 'activity', handler: 'agent', input: { agent: 'scribe', message: 'Write the digest' } },
];

type Served = {
  status: string;
  runId: string;
  kind: string;
  runStatus: string;
  truncated: boolean;
  entries: readonly Record<string, unknown>[];
};

/** A step as served: names and timings, never what the step took in or gave back. */
function expectNoPayload(timeline: Served): void {
  expect(timeline.entries.length).toBeGreaterThan(0);
  for (const entry of timeline.entries) {
    expect(Object.keys(entry).toSorted()).toEqual(
      ['duration', 'label', 'operationType', 'status', 'step', 'timestamp', 'tries'].filter(
        (key) => key !== 'duration' || Object.hasOwn(entry, 'duration'),
      ),
    );
  }
}

describe('the runs-timeline tool on a Bureau with agents and no workflow directory', () => {
  async function start(): Promise<WorkflowToolsHarness> {
    const harness = await startWorkflowToolsBureau({ withoutWorkflowDirectory: true });
    harnesses.push(harness);
    expect(harness.bureau.workflows).toBeUndefined();
    await harness.putAgent('scribe', ['bureau:runs-timeline']);
    return harness;
  }

  it('lets an agent read the timeline of a run its owner started, and no one else’s', async () => {
    const harness = await start();
    // The first run asks about nothing; it is the run whose timeline is read next.
    const first = await harness.callTool(TOOL, { runId: 'no-such-run' });
    expect(first.result).toEqual({ status: 'not-found', id: 'no-such-run' });

    const own = await harness.callTool(TOOL, { runId: first.runId });
    expect(own.result).toMatchObject({
      status: 'ok',
      runId: first.runId,
      kind: 'agent',
      runStatus: 'completed',
      truncated: false,
    });
    expectNoPayload(own.result as Served);

    // A run of another owner is answered as no run at all, as one that does not exist is.
    const foreign = await harness.callTool(TOOL, { runId: first.runId }, OTHER_OWNER);
    expect(foreign.result).toEqual({ status: 'not-found', id: first.runId });
  });
});

describe('the runs-timeline tool on a Bureau with workflow files', () => {
  it('reads a finished workflow instance, and a missing run as not-found', async () => {
    const harness = await startWorkflowToolsBureau();
    harnesses.push(harness);
    await harness.putAgent('scribe', [
      'bureau:workflows-create',
      'bureau:workflows-start',
      'bureau:runs-timeline',
    ]);
    await harness.callTool('bureau__workflows-create', {
      name: 'Timed',
      trigger: { kind: 'manual' },
      steps: STEPS,
    });
    const started = await harness.callTool('bureau__workflows-start', { id: 'timed' });
    const runId = (started.result as { runId: string }).runId;
    await waitUntil(async () => (await harness.bureau.workflows!.getRun(runId)) !== undefined, {
      message: 'started workflow run did not become readable',
    });
    await harness.bureau.durableEngine()!.getHandle(runId).result();

    const timeline = await harness.callTool(TOOL, { runId });
    expect(timeline.result).toMatchObject({
      status: 'ok',
      runId,
      kind: 'workflow',
      runStatus: 'completed',
      truncated: false,
    });
    expectNoPayload(timeline.result as Served);

    const missing = await harness.callTool(TOOL, { runId: 'no-such-run' });
    expect(missing.result).toEqual({ status: 'not-found', id: 'no-such-run' });
    const foreign = await harness.callTool(TOOL, { runId }, OTHER_OWNER);
    expect(foreign.result).toEqual({ status: 'not-found', id: runId });
  });
});
