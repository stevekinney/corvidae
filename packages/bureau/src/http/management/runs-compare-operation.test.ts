/**
 * `bureau.runs.compare` over a real Bureau and its handler: a forked workflow run beside its
 * source, step by step. The fork and then its source are each read with the access reading a workflow
 * run asks, before the engine reads either timeline, and a run that is not a fork says so.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { waitForCondition } from '../../test';
import { answering, openBureau, rpc, type RpcBody } from './management-fixtures.test-support.ts';
import { type Served, serveWorkflows } from './workflows-fixtures.test-support.ts';
import { AGENT_STEP, FAST_SCHEDULE } from '../../testing/workflow-file-fixtures.test-support.ts';
import {
  workspacePrivacyAuthentication,
  workspacePrivacyDirectory,
} from '../workspace-privacy-fixtures.test-support.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** Sits in the run's input, so the comparison can be seen to carry a step's payload to a reader. */
const SENTINEL = 'PRIVATE-COMPARE-INPUT-5b8e';

type Side = {
  operationType: string;
  label: string;
  status: string;
  input: string;
  output?: string;
};
type ComparedStep = { index: number; shared: boolean; source?: Side; fork?: Side };

const stepsOf = (response: RpcBody): ComparedStep[] => response.result!['steps'] as ComparedStep[];
const status = (response: RpcBody): unknown => response.error?.data?.httpStatus;

/** A workflow file with two steps, a run of it, and a fork of the run from its last checkpoint. */
async function serveWithFork(
  options: Parameters<typeof serveWorkflows>[1] = {},
  owner = 'api-key:alice',
) {
  // Weft's `engine.fork` throws under the Bureau's default `workflow-lease` posture, so a fork needs `none`.
  const served = await serveWorkflows(cleanups, {
    durableOwnership: { ownership: 'none' },
    ...options,
  });
  await served.bureau.workflows!.create('digest', {
    agent: 'writer',
    trigger: FAST_SCHEDULE,
    steps: [{ ...AGENT_STEP, input: { ...AGENT_STEP.input, message: SENTINEL } }, AGENT_STEP],
  });
  const engine = served.bureau.durableEngine()!;
  // Started as the workflow runtime starts one, so the run has an owner of record.
  const { runId } = await served.bureau.workflows!.start('digest', { owner });
  await waitForCondition(
    async () => (await engine.get(runId))?.status === 'completed',
    'the source run completes',
  );
  const fork = await engine.fork(runId);
  await fork.result();
  return { served, engine, sourceId: runId, forkId: fork.id };
}

describe('bureau.runs.compare for a forked workflow run', () => {
  it('returns the fork beside its source, each step as the engine aligns it, to a workflows reader and the deployment’s owner', async () => {
    const { served, engine, sourceId, forkId } = await serveWithFork();
    const aligned = await engine.compare(forkId);
    expect(aligned.steps.length).toBeGreaterThan(0);

    for (const key of ['operator-key', 'workflows-reader-key']) {
      const response = await rpc(served.keyed, 'bureau.runs.compare', { runId: forkId }, key);
      expect([key, response.error]).toEqual([key, undefined]);
      expect(response.result).toMatchObject({
        runId: forkId,
        sourceRunId: sourceId,
        forkPoint: aligned.forkPoint,
      });
      expect(stepsOf(response)).toEqual(
        aligned.steps.map((step) => ({
          index: step.index,
          shared: step.shared,
          ...(step.source === undefined ? {} : { source: step.source }),
          ...(step.fork === undefined ? {} : { fork: step.fork }),
        })),
      );
    }
  });

  it('carries each side’s input and output, which a timeline never does', async () => {
    const { served, forkId } = await serveWithFork();
    const response = await rpc(
      served.keyed,
      'bureau.runs.compare',
      { runId: forkId },
      'operator-key',
    );
    expect(response.error).toBeUndefined();
    const sides = stepsOf(response).flatMap((step) => [step.source, step.fork]);
    expect(sides.some((side) => side !== undefined && side.input.length > 0)).toBe(true);
    expect(JSON.stringify(response.result)).toContain(SENTINEL);

    const timeline = await rpc(
      served.keyed,
      'bureau.runs.timeline',
      { runId: forkId },
      'operator-key',
    );
    expect(JSON.stringify(timeline.result)).not.toContain(SENTINEL);
  });

  it('pages by step with a cursor, and refuses a cursor it did not issue', async () => {
    const { served, forkId } = await serveWithFork();
    const whole = await rpc(served.keyed, 'bureau.runs.compare', { runId: forkId }, 'operator-key');
    const all = stepsOf(whole);
    expect(all.length).toBeGreaterThan(1);

    const first = await rpc(
      served.keyed,
      'bureau.runs.compare',
      { runId: forkId, limit: 1 },
      'operator-key',
    );
    expect(stepsOf(first)).toHaveLength(1);
    const cursor = first.result!['nextCursor'];
    expect(typeof cursor).toBe('string');
    const second = await rpc(
      served.keyed,
      'bureau.runs.compare',
      { runId: forkId, limit: 1, cursor },
      'operator-key',
    );
    expect([...stepsOf(first), ...stepsOf(second)].map((step) => step.index)).toEqual(
      all.slice(0, 2).map((step) => step.index),
    );

    const refused = await rpc(
      served.keyed,
      'bureau.runs.compare',
      { runId: forkId, cursor: 'not-a-cursor' },
      'operator-key',
    );
    expect(refused.result).toBeUndefined();
    expect(refused.error?.data?.['httpStatus']).toBe(400);
  });

  it('answers a caller who may not read the run as a missing run, and reads no engine for it', async () => {
    const { served, engine, forkId } = await serveWithFork();
    const read = spyOn(engine, 'compare');

    for (const key of ['alice-key', 'bob-key', 'tasks-reader-key']) {
      const response = await rpc(served.keyed, 'bureau.runs.compare', { runId: forkId }, key);
      expect([key, response.result]).toEqual([key, undefined]);
      expect([key, status(response)]).toEqual([key, 404]);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('answers a run that does not exist as a missing run', async () => {
    const { served } = await serveWithFork();
    const response = await rpc(
      served.keyed,
      'bureau.runs.compare',
      { runId: 'absent' },
      'operator-key',
    );
    expect(status(response)).toBe(404);
  });
});

describe('bureau.runs.compare asks about the source as well as the fork', () => {
  async function serveAsWorkspace() {
    return serveWithFork(
      {
        workspace: workspacePrivacyDirectory(),
        authentication: workspacePrivacyAuthentication,
      },
      'workspace-a:alice',
    );
  }

  it('answers a member who owns the fork and not its source as a missing run, and reads no engine for it', async () => {
    const { served, engine, sourceId, forkId } = await serveAsWorkspace();
    const owners = new Map([
      [forkId, 'workspace-a:alice'],
      [sourceId, 'workspace-a:bob'],
    ]);
    spyOn(served.bureau, 'ownerOf').mockImplementation(async (resource) =>
      resource.kind === 'run' ? owners.get(resource.id) : undefined,
    );
    const read = spyOn(engine, 'compare');

    const refused = await rpc(served.keyed, 'bureau.runs.compare', { runId: forkId }, 'alice-key');
    expect(refused.result).toBeUndefined();
    expect(status(refused)).toBe(404);
    expect(refused.error?.message).not.toContain(sourceId);
    expect(read).not.toHaveBeenCalled();

    // The same member reads the fork's comparison once the source is hers as well.
    owners.set(sourceId, 'workspace-a:alice');
    const allowed = await rpc(served.keyed, 'bureau.runs.compare', { runId: forkId }, 'alice-key');
    expect(allowed.error).toBeUndefined();
    expect(allowed.result).toMatchObject({ runId: forkId, sourceRunId: sourceId });
    expect(read).toHaveBeenCalledTimes(1);

    // And the source's owner, who owns not the fork, may not read it through the source.
    const other = await rpc(served.keyed, 'bureau.runs.compare', { runId: forkId }, 'bob-key');
    expect(status(other)).toBe(404);
  });

  it('answers a member who owns neither run as a missing run', async () => {
    const { served, engine, forkId } = await serveAsWorkspace();
    const read = spyOn(engine, 'compare');

    const response = await rpc(served.keyed, 'bureau.runs.compare', { runId: forkId }, 'bob-key');

    expect(status(response)).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('bureau.runs.compare for a run that is not a fork', () => {
  it('says so, with what to do, for a workflow run nobody forked', async () => {
    const { served, sourceId } = await serveWithFork();
    const response = await rpc(
      served.keyed,
      'bureau.runs.compare',
      { runId: sourceId },
      'operator-key',
    );

    expect(response.result).toBeUndefined();
    expect(response.error?.data).toMatchObject({ httpStatus: 422, reason: 'not-a-fork' });
    expect(response.error?.message).toContain('is not a fork');
    expect(response.error?.message).toContain('Fork a run, then compare the fork');
  });

  it('says so for an agent run the caller may read, and answers a caller who may not as a missing run', async () => {
    const opened = await openBureau({ generate: answering('Done.') });
    cleanups.push(() => opened.dispose());
    const handle = await opened.bureau.tasks.start('default', 'hello', {
      principal: 'api-key:alice',
    });
    await handle.result();

    const owner = await rpc(
      opened.handler,
      'bureau.runs.compare',
      { runId: handle.id },
      'alice-key',
    );
    expect(owner.error?.data).toMatchObject({ httpStatus: 422, reason: 'agent-run' });
    expect(owner.error?.message).toContain('agent run');

    const stranger = await rpc(
      opened.handler,
      'bureau.runs.compare',
      { runId: handle.id },
      'bob-key',
    );
    expect(status(stranger)).toBe(404);
  });

  it('answers a Bureau with a durable engine but no workflow directory with the workflow operations’ fault', async () => {
    const served: Served = await serveWorkflows(cleanups, { withoutDirectory: true });
    const response = await rpc(
      served.keyed,
      'bureau.runs.compare',
      { runId: 'not-a-task' },
      'workflows-reader-key',
    );
    expect(response.error?.data).toMatchObject({ capability: 'workflow-directory' });
  });
});
