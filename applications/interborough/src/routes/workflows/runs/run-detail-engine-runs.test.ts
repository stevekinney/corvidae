/**
 * `/runs/:run` for the runs only the workflow engine holds, which the Runs list shows beside the
 * Bureau's tasks (COR-2423): the schedule tick and an instance of a workflow file. The Bureau
 * answers `bureau.tasks.get` NotFound for them, so the page reads them from the engine; none of
 * them may lead to the page that says the run was not found (COR-2424). The tick is read-only.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { QueryClient } from '@tanstack/svelte-query';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';

import { TASK_COPY } from '../../../app/copy/tasks.ts';
import { router } from '../../../lib/router.svelte.ts';
import type { Principal } from '../../../lib/scopes.svelte.ts';
import { realClient, ScriptedFetch } from '../list/workflow-test-support.test-support.ts';
import RunDetailHarness from './run-detail.test-harness.svelte';

const READER: Principal = {
  scopes: ['workflows:read', 'workflows:write'],
  unauthenticatedAccess: null,
};

function engineRun(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'release-notes',
    status: 'completed',
    input: {},
    versionTuple: { workflowVersion: '1.2.0' },
    createdAt: 1_000,
    updatedAt: 4_000,
    ...overrides,
  };
}

let fetchScript: ScriptedFetch;

beforeEach(() => {
  fetchScript = new ScriptedFetch();
  fetchScript.routeSseStream('/v1/events/sse');
  // The Bureau holds no task for a run it built from the engine at list time.
  fetchScript.routeJsonRpcMethodNotFound('bureau.tasks.get', 'No such task');
});

afterEach(() => {
  cleanup();
  fetchScript.restore();
  if (window instanceof Window) window.happyDOM.setURL('http://localhost/');
  router.navigate('/', { replace: true });
});

function routeEngine(id: string, run: Record<string, unknown>): void {
  fetchScript.routeUrl(`/workflows/${id}/timeline`, []);
  fetchScript.routeJsonRpcMethod('weft.workflows.activities.pending.list', { items: [] });
  fetchScript.routeUrl(`/workflows/${id}`, { id, ...run });
}

function mount(id: string) {
  router.navigate(`/runs/${id}`, { replace: true });
  return render(RunDetailHarness, {
    props: {
      client: realClient(),
      principal: READER,
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      runId: id,
    },
  });
}

async function moreActions(view: ReturnType<typeof mount>): Promise<string[]> {
  await waitFor(() =>
    expect(view.container.querySelector('[data-run-header] [data-status-word]')).not.toBeNull(),
  );
  await fireEvent.click(view.getByRole('button', { name: 'More actions' }));
  return view.queryAllByRole('menuitem').map((item) => item.textContent?.trim() ?? '');
}

describe('a schedule tick opened from the Runs list', () => {
  test('is the engine’s run, read-only: named as what it is, with no action that changes it', async () => {
    fetchScript.routeJsonRpcMethod('bureau.goals.list', { goals: [], nextOffset: null });
    routeEngine('tick-1', {
      ...engineRun({}),
      type: 'scheduleTick',
      input: {
        event: 'missed-runs',
        scheduleId: 'daily-summary',
        scheduleName: 'Daily summary',
        missedRuns: 4,
        reason: 'late',
        since: 0,
        until: 1,
        whileStopped: true,
      },
    });

    const view = mount('tick-1');

    expect(await view.findByRole('heading', { level: 1, name: 'Schedule tick' })).not.toBeNull();
    expect(view.queryByText(TASK_COPY.notFound.title)).toBeNull();
    // Copying the ID is all More offers: no suspend, cancel, restart, signal, update or query.
    expect(await moreActions(view)).toEqual(['Copy run ID']);
    expect(view.container.querySelector('[data-section="change"]')).toBeNull();
  });
});

describe('an instance of a workflow file opened from the Runs list', () => {
  test('shows the run when the goals cannot be read, because the goals were only looked at for an attempt', async () => {
    // A caller who may read workflows but not goals: the Runs list shows the instance, and its
    // page must not turn into an error about the goals it never needed.
    fetchScript.routeJsonRpcMethodUnprocessable('bureau.goals.list', 'Goals cannot be read');
    routeEngine('instance-1', engineRun({ status: 'failed', error: 'GitHub did not answer' }));

    const view = mount('instance-1');

    // No workflow file answered for the run's type, so it is shown by its type.
    expect(await view.findByRole('heading', { level: 1, name: 'release-notes' })).not.toBeNull();
    expect(view.queryByText(TASK_COPY.notFound.title)).toBeNull();
    expect(view.queryByText(TASK_COPY.loadFailed.title)).toBeNull();
  });

  test('that failed says where: at step 2 of 4 beside Failed, the failing step’s block, and the version it ran (rows 54y, 14t, 55b, 55d)', async () => {
    fetchScript.routeJsonRpcMethod('bureau.goals.list', { goals: [], nextOffset: null });
    const step = (kind: string, title?: string) => ({
      kind,
      ...(title === undefined ? {} : { title }),
      input: {},
    });
    const at = (type: string, index: number | null, seconds: number) => ({
      type: `file-workflow:${type}`,
      timestamp: new Date(1_000 + seconds * 1000).toISOString(),
      step: index === null ? null : String(index),
      summary: '',
    });
    fetchScript.routeJsonRpcMethod('bureau.workflows.runs.history', {
      events: [
        at('step-started', 0, 0),
        at('activity-started', 0, 0),
        at('step-started', 1, 1),
        at('activity-started', 1, 1),
        at('activity-started', 1, 2),
        at('run-terminal', null, 3),
      ],
      truncated: false,
    });
    fetchScript.routeJsonRpcMethod('bureau.workflows.revisions', {
      revisions: [
        {
          workflowVersion: '1.2.0',
          firstRunAt: '2026-10-29T09:15:00.000Z',
          lastRunAt: '2026-10-30T11:00:00.000Z',
          document: {
            name: 'release-notes',
            trigger: { kind: 'signal', name: 'start' },
            steps: [
              step('activity', 'Find the release'),
              step('activity', 'Collect merged changes'),
              step('await-signal'),
              step('sleep'),
            ],
            inputSchema: null,
            outputSchema: null,
          },
          compatibility: null,
        },
      ],
    });
    fetchScript.routeJsonRpcMethod('bureau.workflows.get', {
      id: 'release-notes',
      state: 'ready',
      owner: 'anonymous:local',
      hash: 'abc',
      description: null,
      agent: null,
      paused: false,
      inputSchema: null,
      outputSchema: null,
      version: '1.3.0',
      trigger: null,
      problem: null,
      text: null,
      schedule: null,
    });
    routeEngine(
      'release-run',
      engineRun({ status: 'failed', error: 'GitHub did not answer (HTTP 503)' }),
    );

    const view = mount('release-run');

    const header = await waitFor(() => {
      const text = view.container.querySelector('[data-run-header]')?.textContent ?? '';
      expect(text).toMatch(/Failed\s*, at step 2 of 4/);
      return text;
    });
    expect(header).toContain('Release notes');
    const block = await view.findByTestId('run-step-failure');
    expect(block.textContent).toContain('Step 2, Collect merged changes, failed after 2 tries');
    expect(block.textContent).toContain('Why it failed');
    expect(block.textContent).toContain('GitHub did not answer (HTTP 503)');
    // The failure is told once, on the step, and no banner repeats it.
    expect(view.container.querySelectorAll('.weft-overview-tab__failure')).toHaveLength(1);
    await waitFor(() => {
      const version = view.container.querySelector('[data-version-state]');
      expect(version?.textContent).toContain('1.2.0, older version');
    });
    expect(view.container.querySelector('aside')?.textContent).toContain(
      'Ran on an older version of this workflow. The current one is 1.3.0.',
    );
  });

  test('is not found only when the engine and the Bureau’s record both lack it', async () => {
    fetchScript.routeJsonRpcMethod('bureau.goals.list', { goals: [], nextOffset: null });
    fetchScript.routeUrlStatus('/workflows/purged-1', 404);
    fetchScript.routeJsonRpcMethodNotFound('bureau.workflows.runs.get', 'No such run');

    const view = mount('purged-1');

    expect(await view.findByText(TASK_COPY.notFound.title)).not.toBeNull();
  });
});
