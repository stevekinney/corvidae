/**
 * `/runs/:run` for the runs only the workflow engine holds, which the Runs list shows beside the
 * Bureau's tasks (COR-2423): the schedule tick and an instance of a workflow file. The Bureau
 * answers `bureau.tasks.get` NotFound for them, so the page reads them from the engine; none of
 * them may lead to the page that says the run was not found (COR-2424). The tick is read-only.
 */
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { QueryClient } from '@tanstack/svelte-query';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';

import { RUN_DETAIL_COPY } from '../../../app/copy/runs.ts';
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
  fetchScript.routeJsonRpcMethod(
    'weft.workflows.timeline.get',
    [],
    (params) =>
      typeof params === 'object' &&
      params !== null &&
      'workflowId' in params &&
      params.workflowId === id,
  );
  fetchScript.routeJsonRpcMethod('weft.workflows.activities.pending.list', { items: [] });
  fetchScript.routeJsonRpcMethod(
    'weft.workflows.get',
    { id, ...run },
    (params) =>
      typeof params === 'object' &&
      params !== null &&
      'workflowId' in params &&
      params.workflowId === id,
  );
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

    // No workflow file answered for the run's type, so it is shown by its type, in words (S68).
    expect(await view.findByRole('heading', { level: 1, name: 'Release notes' })).not.toBeNull();
    expect(view.queryByText(TASK_COPY.notFound.title)).toBeNull();
    expect(view.queryByText(TASK_COPY.loadFailed.title)).toBeNull();
    const rail = view.getByRole('complementary');
    expect(rail.textContent).toContain('Run ID');
    expect(rail.querySelector('[aria-label="Copy Run ID"]')).not.toBeNull();
  });

  /** Lists the inspectors' run panels, as the host does, and answers a panel's page. */
  function routeRunPanels(): void {
    fetchScript.routeJsonRpcMethod('bureau.goals.list', { goals: [], nextOffset: null });
    fetchScript.routeUrl('/host/panels', {
      apps: [
        {
          plugin: 'inspectors',
          app: 'run-inspector',
          title: 'Run inspector',
          uri: 'ui://inspectors/run-inspector/v1',
          placements: [{ kind: 'run' }],
        },
        {
          plugin: 'inspectors',
          app: 'run-comparison',
          title: 'Run comparison',
          uri: 'ui://inspectors/run-comparison/v1',
          opensFromTool: 'bureau.runs.compare',
          placements: [{ kind: 'run' }],
        },
        {
          plugin: 'inspectors',
          app: 'schedule-editor',
          title: 'Schedule editor',
          uri: 'ui://inspectors/schedule-editor/v1',
          placements: [{ kind: 'page', path: 'schedules' }, { kind: 'run' }],
        },
        {
          plugin: 'inspectors',
          app: 'pending-review',
          title: 'Pending reviews',
          uri: 'ui://inspectors/pending-review/v1',
          placements: [],
        },
      ],
    });
    fetchScript.routeUrl('/host/plugins/', { html: '<div id="root"></div>', ui: {} });
  }

  async function openInspectorTab(view: ReturnType<typeof mount>): Promise<void> {
    const trigger = await view.findByRole('button', { name: RUN_DETAIL_COPY.howItRan.heading });
    if (trigger.getAttribute('aria-expanded') !== 'true') await fireEvent.click(trigger);
    const tab = await view.findByRole('tab', { name: RUN_DETAIL_COPY.howItRan.tabs.inspector });
    if (tab.getAttribute('aria-selected') !== 'true') await fireEvent.click(tab);
  }

  const mountedPanels = (view: ReturnType<typeof mount>) =>
    [...view.container.querySelectorAll<HTMLElement>('[data-section="plugin-panel"]')].map(
      (section) => section.dataset['app'],
    );

  test('mounts the run comparison on its Inspector tab when it is a fork, and neither the run inspector nor the schedule editor (owner, 2026-11-22, refined)', async () => {
    routeRunPanels();
    routeEngine('instance-source', engineRun({ id: 'instance-source' }));
    fetchScript.routeJsonRpcMethod('weft.workflows.scheduleprovenance.get', null);
    routeEngine(
      'instance-panels',
      engineRun({ forkedFrom: { workflowId: 'instance-source', step: 2 } }),
    );

    const view = mount('instance-panels');
    await openInspectorTab(view);

    await waitFor(() => expect(mountedPanels(view)).toEqual(['run-comparison']));
  });

  test('mounts no panel on an instance that is not a fork: it has no task, no source and no schedule to show', async () => {
    routeRunPanels();
    routeEngine('instance-plain', engineRun({}));

    const view = mount('instance-plain');
    await openInspectorTab(view);
    await waitUntil(() => fetchScript.calls.some((call) => call.url.includes('/host/panels')));
    await waitFor(() =>
      expect(view.container.querySelector('[data-section="change"]')).not.toBeNull(),
    );
    // Nothing is going to appear, so the check is that the page stays as it was.
    await quietFor(50);
    expect(mountedPanels(view)).toEqual([]);
  });

  test('puts a fork’s lineage, with the comparison’s button, ahead of the operator tabs, not behind Versioning', async () => {
    routeRunPanels();
    routeEngine('instance-source', engineRun({ id: 'instance-source' }));
    fetchScript.routeJsonRpcMethod('weft.workflows.scheduleprovenance.get', null);
    routeEngine(
      'instance-fork-lineage',
      engineRun({ forkedFrom: { workflowId: 'instance-source', step: 2 } }),
    );

    const view = mount('instance-fork-lineage');

    const compare = await view.findByRole('button', { name: 'Compare with source' });
    const lineage = view.container.querySelector('[data-section="lineage"]');
    expect(lineage).not.toBeNull();
    expect(lineage?.contains(compare)).toBe(true);
    // It leads the "How it ran" disclosure, which is closed: no tab has been opened to reach it.
    const howItRan = view.getByRole('button', { name: RUN_DETAIL_COPY.howItRan.heading });
    expect(lineage?.compareDocumentPosition(howItRan) === Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      true,
    );
    expect(howItRan.getAttribute('aria-expanded')).not.toBe('true');
  });

  /**
   * Serves Release notes' run `release-run` failed at step 2 on 1.2.0 (1.3.0 is current), with the
   * history's two starts of step 2's activity and, when given, the engine's timeline.
   */
  function serveFailedReleaseNotes(
    timeline?: readonly unknown[],
    options: { readonly explained?: boolean } = {},
  ): void {
    if (timeline !== undefined)
      fetchScript.routeJsonRpcMethod('weft.workflows.timeline.get', timeline);
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
    // What the Bureau stored of the failure (COR-2533): the failure section is its words.
    if (options.explained === false) {
      fetchScript.routeJsonRpcMethodNotFound('bureau.tasks.explain', 'No such run');
    } else {
      fetchScript.routeJsonRpcMethod('bureau.tasks.explain', {
        summary:
          'The step "Collect merged changes" failed because the code it ran raised an error.',
        cause: { category: 'application', code: null, kind: null },
        step: { index: 1, label: 'Collect merged changes' },
        tries: 2,
        verdicts: [],
        remediation: 'Read the run’s failure message, then start the run again.',
        nextCommands: [
          'interborough runs get --kind workflow release-run',
          'interborough runs retry release-run',
        ],
      });
    }
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
      engineRun({
        status: 'failed',
        error:
          'Agent "assistant" failed (finish reason "error"): {"name":"AgentRunError","message":"GitHub did not answer (HTTP 503) while Collect merged changes was reading the pull requests"}',
      }),
    );
  }

  test('that failed after three tries says so in its heading, and how long the tries took (rows 14t, 55b)', async () => {
    // The engine's timeline keeps one entry for each try of step 2's activity: 3.4 s from the
    // first try's start to the last one's end.
    const tried = (offset: number, duration: number) => ({
      step: 1,
      documentStep: 1,
      operationType: 'activity',
      operationLabel: 'agent',
      inputSummary: '',
      timestamp: 2_000 + offset,
      duration,
      status: 'failed',
    });
    // The Bureau holds no answer for it, so the page's own words about the failure stand.
    serveFailedReleaseNotes([tried(0, 600), tried(1_200, 600), tried(2_800, 600)], {
      explained: false,
    });

    const view = mount('release-run');

    const block = await view.findByTestId('run-step-failure');
    await waitFor(() =>
      expect(block.textContent).toContain('Step 2, Collect merged changes, failed after 3 tries'),
    );
    expect(block.textContent).toContain('Interborough tried 3 times in 3.4 s.');
    expect(block.textContent).toContain(
      'GitHub did not answer (HTTP 503) while Collect merged changes was reading the pull requests.',
    );
  });

  test('that failed after three tries and is explained keeps how long they took in the Tries row (row 55b)', async () => {
    const tried = (offset: number, duration: number) => ({
      step: 1,
      documentStep: 1,
      operationType: 'activity',
      operationLabel: 'agent',
      inputSummary: '',
      timestamp: 2_000 + offset,
      duration,
      status: 'failed',
    });
    serveFailedReleaseNotes([tried(0, 600), tried(1_200, 600), tried(2_800, 600)]);

    const view = mount('release-run');

    const block = await view.findByTestId('run-step-failure');
    await waitFor(() => expect(block.querySelector('[data-explanation="summary"]')).not.toBeNull());
    expect(block.querySelector('dl')?.textContent).toMatch(/Tries\s*\d+, 3\.4 s in all/);
    // The page's own sentence stands only while the Bureau has no answer: the duration is said once.
    expect(block.textContent).not.toContain('Interborough tried');
  });

  test('that failed says where: at step 2 of 4 beside Failed, the failing step’s block, and the version it ran (rows 54y, 14t, 55b, 55d)', async () => {
    serveFailedReleaseNotes();

    const view = mount('release-run');

    const header = await waitFor(() => {
      const text = view.container.querySelector('[data-run-header]')?.textContent ?? '';
      expect(text).toMatch(/Failed\s*, at step 2 of 4/);
      return text;
    });
    expect(header).toContain('Release notes');
    const block = await view.findByTestId('run-step-failure');
    // COR-2489: why it failed leads, above Input and output.
    const inputOutput = view.container.querySelector('[data-section="input-output"]');
    expect(inputOutput).not.toBeNull();
    expect(
      block.compareDocumentPosition(inputOutput as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(block.textContent).toContain('Step 2, Collect merged changes, failed after 2 tries');
    // The Bureau's answer is the one reason in the block: the page's own "Why it failed" words show
    // only while the Bureau has none (the test above), so the failure is stated once.
    await waitFor(() => expect(block.querySelector('[data-explanation="summary"]')).not.toBeNull());
    expect(block.textContent).not.toContain('Why it failed');
    expect(block.textContent).not.toContain('GitHub did not answer');
    expect(block.textContent).not.toContain('It wasn’t anything you did.');
    // The step is named once, in the heading: the answer's own Step row is left out.
    expect(block.querySelector('dl')?.textContent).not.toContain('Step');
    // One next step: the Bureau's, before the actions, with no second sentence about Health.
    expect(block.textContent).not.toContain('check Health');
    // What the step said, never the error's JSON (row 55b).
    expect(block.textContent).not.toContain('{');
    const actions = block.querySelector('[data-run-failure-actions]');
    expect(actions?.textContent).toContain('Retry from step 2');
    expect(actions?.textContent).toContain('runs on 1.2.0');
    // COR-2489 design round: the block says the version once, beside its button (14t); the
    // header's caption says it once more (54z), and nothing in the block says it a third time.
    expect(block.textContent?.split('1.2.0').length).toBe(2);
    expect(block.querySelector('[data-run-retry-sentence]')?.textContent).toContain(
      'Retry from this step keeps step 1’s result and runs step 2 again.',
    );
    expect(actions?.textContent).toContain('Run again');
    expect(actions?.textContent).toContain('Open step 2');
    // COR-2533: the block carries what the Bureau stored about the failure, in the server’s words.
    await waitFor(() =>
      expect(block.querySelector('[data-explanation="summary"]')?.textContent).toBe(
        'The step "Collect merged changes" failed because the code it ran raised an error.',
      ),
    );
    expect(block.querySelector('[data-explanation="remediation"]')?.textContent).toContain(
      'Read the run’s failure message, then start the run again.',
    );
    expect(block.querySelector('[data-explanation="cause"]')?.textContent).toContain('application');
    expect(block.querySelector('#failure-explanation')).not.toBeNull();
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

  test('COR-2543: a failed instance mounts a panel placed on a failed run in its Inspector tab, and a completed one does not', async () => {
    const panels = {
      apps: [
        {
          plugin: 'inspectors',
          app: 'failure-explanation',
          title: 'Failure explanation',
          uri: 'ui://inspectors/failure-explanation/v1',
          opensFromTool: 'bureau.tasks.explain',
          placements: [{ kind: 'run', when: 'failed' }],
        },
      ],
    };
    const inspectorPanels = async (view: ReturnType<typeof mount>) => {
      const trigger = await view.findByRole('button', { name: 'How it ran' });
      if (trigger.getAttribute('aria-expanded') !== 'true') await fireEvent.click(trigger);
      const tab = await view.findByRole('tab', { name: 'Inspector' });
      if (tab.getAttribute('aria-selected') !== 'true') await fireEvent.click(tab);
      return [...view.container.querySelectorAll('[data-section="plugin-panel"]')];
    };

    serveFailedReleaseNotes();
    fetchScript.routeUrl('/host/panels', panels);
    const failed = mount('release-run');
    await waitFor(async () => {
      const found = await inspectorPanels(failed);
      expect(found.map((section) => section.getAttribute('data-app'))).toEqual([
        'failure-explanation',
      ]);
    });
    failed.unmount();

    // A run that is not failed shows no panel that placed itself for failed runs only.
    fetchScript.restore();
    fetchScript = new ScriptedFetch();
    fetchScript.routeSseStream('/v1/events/sse');
    fetchScript.routeJsonRpcMethodNotFound('bureau.tasks.get', 'No such task');
    fetchScript.routeUrl('/host/panels', panels);
    fetchScript.routeJsonRpcMethod('bureau.goals.list', { goals: [], nextOffset: null });
    routeEngine('done-run', engineRun({ status: 'completed', result: {} }));
    const done = mount('done-run');
    await done.findByRole('heading', { level: 1 });
    expect(await inspectorPanels(done)).toEqual([]);
  });

  test('is not found only when the engine and the Bureau’s record both lack it', async () => {
    fetchScript.routeJsonRpcMethod('bureau.goals.list', { goals: [], nextOffset: null });
    fetchScript.routeJsonRpcMethodNotFound('weft.workflows.get', 'No such workflow');
    fetchScript.routeJsonRpcMethodNotFound('bureau.workflows.runs.get', 'No such run');

    const view = mount('purged-1');

    expect(await view.findByText(TASK_COPY.notFound.title)).not.toBeNull();
  });
});
