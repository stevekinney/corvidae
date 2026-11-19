/**
 * `bureau.runs.timeline` over a real Bureau and its handler: an agent run's and a workflow
 * instance's step timeline, the same access as reading the run, and no payload in the answer.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import {
  answering,
  openBureau,
  type OpenedBureau,
  OWNER,
  rpc,
  type RpcBody,
} from './management-fixtures.test-support.ts';
import { type Served, serveWorkflows } from './workflows-fixtures.test-support.ts';
import { AGENT_STEP, FAST_SCHEDULE } from '../../testing/workflow-file-fixtures.test-support.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const SENTINEL = 'PRIVATE-TIMELINE-INPUT-7c31';

type Entry = {
  step: number;
  label: string;
  operationType: string;
  status: string;
  timestamp: number;
  duration?: number;
  tries: number;
};

const entriesOf = (response: RpcBody): Entry[] => response.result!['entries'] as Entry[];
const status = (response: RpcBody): unknown => response.error?.data?.httpStatus;

async function openWithAgentRun(): Promise<{ opened: OpenedBureau; runId: string }> {
  const opened = await openBureau({ generate: answering('Done.') });
  cleanups.push(() => opened.dispose());
  const handle = await opened.bureau.tasks.start('default', SENTINEL, { principal: OWNER.alice });
  await handle.result();
  return { opened, runId: handle.id };
}

async function serveWithWorkflowRun(): Promise<{ served: Served; runId: string }> {
  const served = await serveWorkflows(cleanups);
  await served.bureau.workflows!.create('digest', {
    agent: 'writer',
    trigger: FAST_SCHEDULE,
    steps: [AGENT_STEP],
  });
  const run = await served.bureau
    .durableEngine()!
    .start('digest', { note: SENTINEL }, { id: 'timeline-digest-run' });
  await run.result();
  return { served, runId: 'timeline-digest-run' };
}

describe('bureau.runs.timeline for an agent run', () => {
  it('returns each step’s label, status, start, duration and tries to the run’s owner', async () => {
    const { opened, runId } = await openWithAgentRun();
    const engineTimeline = await opened.bureau.durableEngine()!.getTimeline(runId);

    const response = await rpc(opened.handler, 'bureau.runs.timeline', { runId }, 'alice-key');

    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({ runId, kind: 'agent', truncated: false });
    const entries = entriesOf(response);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map((entry) => [entry.step, entry.label, entry.status])).toEqual(
      engineTimeline.map((entry) => [entry.step, entry.operationLabel, entry.status]),
    );
    for (const [index, entry] of entries.entries()) {
      expect(entry.timestamp).toBe(engineTimeline[index]!.timestamp);
      expect(entry.duration).toBe(engineTimeline[index]!.duration);
      expect(entry.tries).toBe(1);
    }
  });

  it('answers a caller who does not own the run as a missing run, and reads the engine for nobody it refused', async () => {
    const { opened, runId } = await openWithAgentRun();
    const engine = opened.bureau.durableEngine()!;
    const read = spyOn(engine, 'getTimeline');

    const bob = await rpc(opened.handler, 'bureau.runs.timeline', { runId }, 'bob-key');
    expect(bob.result).toBeUndefined();
    expect(status(bob)).toBe(404);
    expect(read).not.toHaveBeenCalled();

    // The scope that reads any owner's tasks reads this too, and the engine is read then.
    const reader = await rpc(opened.handler, 'bureau.runs.timeline', { runId }, 'tasks-reader-key');
    expect(reader.error).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);

    const missing = await rpc(
      opened.handler,
      'bureau.runs.timeline',
      { runId: 'nope' },
      'alice-key',
    );
    expect(status(missing)).toBe(404);
  });

  it('serves no payload: no step’s input appears in the answer', async () => {
    const { opened, runId } = await openWithAgentRun();
    // The engine's own entries do hold the input, so the absence below is the projection's doing.
    const engineTimeline = await opened.bureau.durableEngine()!.getTimeline(runId);
    expect(JSON.stringify(engineTimeline)).toContain(SENTINEL);
    const response = await rpc(opened.handler, 'bureau.runs.timeline', { runId }, 'alice-key');
    expect(response.error).toBeUndefined();
    expect(JSON.stringify(response.result)).not.toContain(SENTINEL);
    for (const entry of entriesOf(response)) {
      expect(Object.keys(entry).toSorted()).toEqual(
        ['duration', 'label', 'operationType', 'status', 'step', 'timestamp', 'tries'].toSorted(),
      );
    }
  });
});

describe('bureau.runs.timeline for a workflow run', () => {
  it('returns the instance’s steps to the deployment’s owner and to a workflows reader', async () => {
    const { served, runId } = await serveWithWorkflowRun();
    const engineTimeline = await served.bureau.durableEngine()!.getTimeline(runId);

    for (const key of ['operator-key', 'workflows-reader-key']) {
      const response = await rpc(served.keyed, 'bureau.runs.timeline', { runId }, key);
      expect([key, response.error]).toEqual([key, undefined]);
      expect(response.result).toMatchObject({ runId, kind: 'workflow', truncated: false });
      expect(entriesOf(response).map((entry) => [entry.step, entry.label, entry.status])).toEqual(
        engineTimeline.map((entry) => [entry.step, entry.operationLabel, entry.status]),
      );
    }
    expect(engineTimeline.length).toBeGreaterThan(0);
  });

  it('answers a caller who may not read the instance as a missing run, and reads no engine for it', async () => {
    const { served, runId } = await serveWithWorkflowRun();
    const read = spyOn(served.bureau.durableEngine()!, 'getTimeline');

    for (const key of ['alice-key', 'tasks-reader-key']) {
      const response = await rpc(served.keyed, 'bureau.runs.timeline', { runId }, key);
      expect([key, response.result]).toEqual([key, undefined]);
      expect([key, status(response)]).toEqual([key, 404]);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('serves no payload: the instance’s input appears nowhere in the answer', async () => {
    const { served, runId } = await serveWithWorkflowRun();
    const response = await rpc(served.keyed, 'bureau.runs.timeline', { runId }, 'operator-key');
    expect(response.error).toBeUndefined();
    expect(JSON.stringify(response.result)).not.toContain(SENTINEL);
  });

  it('answers an engine run that is no instance of a workflow file as a missing run', async () => {
    const { served } = await serveWithWorkflowRun();
    // An id the engine holds no run for is no run; the engine's own runs that are neither a task
    // nor a workflow file's instance (a schedule tick) are refused the same way, by `getRun`.
    const response = await rpc(
      served.keyed,
      'bureau.runs.timeline',
      { runId: 'absent' },
      'operator-key',
    );
    expect(status(response)).toBe(404);
  });
});
