/**
 * COR-2531 — `bureau.tasks.list` filters by the step a task failed at (`failedStep`, matched against
 * `failure.step.label`) and by whether a step is on a second or later try (`retrying`), for the
 * tasks that have records and for the engine's own runs, whose filters reach the engine's list. A
 * record written before the failure was kept loads with no failure.
 */
import { createAgent } from '@lostgradient/operative';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { waitForCondition } from '../../test';
import { AGENT_STEP } from '../../testing/workflow-file-fixtures.test-support.ts';
import { TASK_RECORD_KEY_PREFIX } from '../../task-registry.ts';
import { ownerRpc, serveWorkflows } from './workflows-fixtures.test-support.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

type Served = Awaited<ReturnType<typeof serveWorkflows>>;

interface ListedTask {
  id: string;
  status: string;
  failure: {
    step: { index: number; label: string } | null;
    errorCode: string | null;
    errorKind: string | null;
    toolCall: { name: string; callId: string } | null;
  } | null;
  retrying: { label: string; attempt: number } | null;
}

async function listTasks(
  served: Served,
  params: Record<string, unknown> = {},
): Promise<{ tasks: ListedTask[]; nextPageToken: string | null; error: unknown }> {
  const body = await ownerRpc(served.owner, 'bureau.tasks.list', params);
  return {
    tasks: (body.result?.['tasks'] ?? []) as ListedTask[],
    nextPageToken: (body.result?.['nextPageToken'] as string | null | undefined) ?? null,
    error: body.error,
  };
}

/** The first task a listing answered, or `undefined` for none. */
async function firstTask(
  served: Served,
  params: Record<string, unknown>,
): Promise<ListedTask | undefined> {
  const listed = await listTasks(served, params);
  return listed.tasks[0];
}

async function idsOf(served: Served, params: Record<string, unknown>): Promise<string[]> {
  const listed = await listTasks(served, params);
  expect(listed.error).toBeUndefined();
  return listed.tasks.map((task) => task.id).toSorted();
}

const LONG_LABEL = 'x'.repeat(260);

/** Writes a task record the way the registry stores it, as JSON, with whatever `extra` adds. */
async function putRecord(
  served: Served,
  taskId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await served.bureau.internals.kv!.set(
    `${TASK_RECORD_KEY_PREFIX}${taskId}`,
    JSON.stringify({
      schemaVersion: 1,
      taskId,
      contextId: taskId,
      incarnation: '',
      agentName: 'writer',
      owner: served.bureau.workflows!.owner,
      createdAt: '2026-11-02T10:00:00.000Z',
      history: [],
      ...extra,
    }),
  );
}

const FAILED = {
  settled: {
    at: '2026-11-02T10:05:00.000Z',
    status: 'failed',
    finishReason: 'error',
    message: 'the card network refused the charge',
  },
};

async function seed(served: Served): Promise<void> {
  await putRecord(served, 'failed-at-tool', {
    ...FAILED,
    failure: {
      step: { index: 2, label: 'charge-card' },
      errorCode: 'UNKNOWN',
      errorKind: 'tool',
      toolCall: { name: 'charge-card', callId: 'call-1' },
    },
  });
  await putRecord(served, 'failed-at-model', {
    ...FAILED,
    failure: { step: { index: 0, label: 'model' }, errorCode: 'UNKNOWN', errorKind: 'generate' },
  });
  await putRecord(served, 'failed-at-long-label', {
    ...FAILED,
    failure: { step: { index: 1, label: LONG_LABEL.slice(0, 200) }, errorCode: 'UNKNOWN' },
  });
  // Written before the failure was kept: a failed task with nothing but its settlement.
  await putRecord(served, 'failed-before-failures-were-kept', FAILED);
  await putRecord(served, 'retrying-model', { retrying: { label: 'model', attempt: 2 } });
  await putRecord(served, 'completed', {
    settled: {
      at: '2026-11-02T10:05:00.000Z',
      status: 'completed',
      finishReason: 'stop-condition',
      message: null,
    },
  });
}

describe('the failure and retrying filters of bureau.tasks.list (COR-2531)', () => {
  it('AC4: lists the tasks that failed at a step, and the tasks that are retrying', async () => {
    const served = await serveWorkflows(cleanups);
    await seed(served);

    expect(await idsOf(served, { failedStep: 'charge-card' })).toEqual(['failed-at-tool']);
    expect(await idsOf(served, { failedStep: 'model' })).toEqual(['failed-at-model']);
    expect(await idsOf(served, { failedStep: 'no-such-step' })).toEqual([]);
    // A label longer than the 200 characters a failure keeps is compared as those 200.
    expect(await idsOf(served, { failedStep: LONG_LABEL })).toEqual(['failed-at-long-label']);

    expect(await idsOf(served, { retrying: true })).toEqual(['retrying-model']);
    expect(await idsOf(served, { retrying: false })).toEqual([
      'completed',
      'failed-at-long-label',
      'failed-at-model',
      'failed-at-tool',
      'failed-before-failures-were-kept',
    ]);
    expect(await idsOf(served, { failedStep: 'model', retrying: true })).toEqual([]);
  });

  it('AC1: shows the stored failure and the retry on the listed view', async () => {
    const served = await serveWorkflows(cleanups);
    await seed(served);

    const tool = await firstTask(served, { failedStep: 'charge-card' });
    expect(tool?.failure).toEqual({
      step: { index: 2, label: 'charge-card' },
      errorCode: 'UNKNOWN',
      errorKind: 'tool',
      toolCall: { name: 'charge-card', callId: 'call-1' },
    });
    const model = await firstTask(served, { failedStep: 'model' });
    expect(model?.failure?.toolCall).toBeNull();
    const retrying = await firstTask(served, { retrying: true });
    expect(retrying?.status).toBe('working');
    expect(retrying?.retrying).toEqual({ label: 'model', attempt: 2 });
    expect(retrying?.failure).toBeNull();
  });

  it('AC5: a record written before the failure was kept loads with no failure', async () => {
    const served = await serveWorkflows(cleanups);
    await seed(served);

    const view = await served.bureau.tasks.get('failed-before-failures-were-kept');
    expect(view?.status).toBe('failed');
    expect(view?.statusMessage).toBe('the card network refused the charge');
    expect(view?.failure).toBeNull();
    expect(view?.retrying).toBeNull();
    const record = await served.bureau.internals.taskRegistry.record(
      'failed-before-failures-were-kept',
    );
    expect(record?.failure).toBeUndefined();
    const everything = await listTasks(served);
    const listed = everything.tasks.find((task) => task.id === 'failed-before-failures-were-kept');
    expect(listed?.failure).toBeNull();
  });

  it('refuses a page token under another failedStep or retrying filter', async () => {
    const served = await serveWorkflows(cleanups);
    await seed(served);

    const byStep = await listTasks(served, { failedStep: 'model', retrying: false, limit: 1 });
    // One match fits the page: a listing with no next page issues no token.
    expect(byStep.nextPageToken).toBeNull();
    const first = await listTasks(served, { retrying: false, limit: 2 });
    expect(first.nextPageToken).not.toBeNull();
    for (const changed of [{ retrying: true }, { failedStep: 'model' }, {}]) {
      const refused = await ownerRpc(served.owner, 'bureau.tasks.list', {
        ...changed,
        limit: 2,
        pageToken: first.nextPageToken,
      });
      expect(JSON.stringify(refused.error)).toContain('page-token-filters');
    }
    const same = await listTasks(served, {
      retrying: false,
      limit: 2,
      pageToken: first.nextPageToken,
    });
    expect(same.error).toBeUndefined();
    expect(same.tasks.length).toBeGreaterThan(0);
  });

  it('refuses a failedStep past 1,000 characters, and takes one at the bound', async () => {
    const served = await serveWorkflows(cleanups);
    const refused = await ownerRpc(served.owner, 'bureau.tasks.list', {
      failedStep: 'x'.repeat(1001),
    });
    expect(refused.error).toBeDefined();
    const accepted = await ownerRpc(served.owner, 'bureau.tasks.list', {
      failedStep: 'x'.repeat(1000),
    });
    expect(accepted.error).toBeUndefined();
  });
});

describe('the engine’s runs under the failure and retrying filters (COR-2531)', () => {
  it('AC4: hands both filters to the engine’s list, and lists a failed instance by the step Weft recorded', async () => {
    const served = await serveWorkflows(cleanups, {
      agents: {
        writer: createAgent({
          name: 'writer',
          generate: async () => {
            throw new Error('GitHub did not answer (HTTP 503)');
          },
        }),
      },
    });
    await served.bureau.workflows!.create('flaky', {
      trigger: { kind: 'signal', name: 'start-flaky' },
      steps: [{ kind: 'await-signal', signal: 'go' }, AGENT_STEP],
    });
    await served.bureau.durableEngine()!.start('flaky', null, { id: 'flaky-run' });
    await waitForCondition(async () => {
      const parked = await firstTask(served, { workflow: 'flaky' });
      return parked?.status === 'working';
    }, 'the instance never started');
    await served.bureau.workflows!.signal('go', null);
    let failed: ListedTask | undefined;
    await waitForCondition(async () => {
      failed = await firstTask(served, { workflow: 'flaky' });
      return failed?.status === 'failed';
    }, 'the instance never failed');
    // Weft's own failedStep label is the step's label, as the view reports it.
    const label = failed?.failure?.step?.label;
    expect(typeof label).toBe('string');
    expect(failed?.failure?.toolCall).toBeNull();
    expect(failed?.failure?.errorKind).toBeNull();

    const engine = served.bureau.durableEngine()!;
    const listing = spyOn(engine, 'list');
    try {
      expect(await idsOf(served, { failedStep: label!, workflow: 'flaky' })).toEqual(['flaky-run']);
      expect(await idsOf(served, { failedStep: 'no-such-step', workflow: 'flaky' })).toEqual([]);
      expect(await idsOf(served, { retrying: true, workflow: 'flaky' })).toEqual([]);
      expect(await idsOf(served, { retrying: false, workflow: 'flaky' })).toEqual(['flaky-run']);
      const asked = listing.mock.calls.map(
        ([filter]) =>
          filter as { type?: string; limit?: number; failedStep?: string; retrying?: boolean },
      );
      expect(asked.filter((filter) => filter.type === 'flaky')).toEqual([
        { type: 'flaky', limit: 100, failedStep: label! },
        { type: 'flaky', limit: 100, failedStep: 'no-such-step' },
        { type: 'flaky', limit: 100, retrying: true },
        { type: 'flaky', limit: 100, retrying: false },
      ]);
    } finally {
      listing.mockRestore();
    }
  });
});
