/**
 * COR-2543, "Coordinator, 2026-11-22: shown only for failed runs": a panel that places itself on a
 * run's page `when: 'failed'` is mounted for a run that failed and for no other, so a run that did
 * not fail shows no card with nothing to say. A run placement with no condition is on for every run,
 * and the host's scope table (`run-panel-scope.ts`, COR-2544) then says which panels have something
 * to say about the kind of run: the run inspector and the schedule editor read a task, so a workflow
 * instance mounts neither, and the comparison is mounted on a fork only. The two rules are one
 * mounting path: a failed fork shows the comparison and the failure explanation together.
 */
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { bureau } from '../../chat/pages.test-support.ts';
import QueryPage from '../../chat/query-page.test-harness.svelte';
import RunPanels from './run-panels.svelte';

let restore: (() => void) | undefined;
/** Whether the host has answered the panels list. */
let listed = false;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const APPS = [
  {
    plugin: 'inspectors',
    app: 'run-inspector',
    title: 'Run inspector',
    uri: 'ui://inspectors/run-inspector/v1',
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
    app: 'run-timeline',
    title: 'Run timeline',
    uri: 'ui://inspectors/run-timeline/v1',
    placements: [{ kind: 'run' }, { kind: 'chat-tool', agentTool: 'bureau:runs-timeline' }],
  },
  {
    plugin: 'inspectors',
    app: 'failure-explanation',
    title: 'Failure explanation',
    uri: 'ui://inspectors/failure-explanation/v1',
    opensFromTool: 'bureau.tasks.explain',
    placements: [
      { kind: 'run', when: 'failed' },
      { kind: 'chat-tool', agentTool: 'bureau:tasks-explain' },
    ],
  },
  {
    plugin: 'inspectors',
    app: 'run-comparison',
    title: 'Run comparison',
    uri: 'ui://inspectors/run-comparison/v1',
    opensFromTool: 'bureau.runs.compare',
    placements: [{ kind: 'run' }],
  },
];

function show(
  failed: boolean,
  run: { taskId: string } | { workflowId: string; fork: boolean } = { taskId: 'run-1' },
) {
  listed = false;
  restore = bureau({}, (url) => {
    if (!url.endsWith('/host/panels')) return new Response('{}', { status: 404 });
    listed = true;
    return Response.json({ apps: APPS });
  }).restore;
  return render(QueryPage, {
    props: { page: RunPanels, pageProps: { ...run, failed } },
  } as never);
}

const apps = (container: HTMLElement): (string | undefined)[] =>
  [...container.querySelectorAll<HTMLElement>('[data-section="plugin-panel"]')].map(
    (section) => section.dataset['app'],
  );

describe('a panel placed on a run’s page only when it failed', () => {
  test('is mounted for a run that failed, beside the panels every run has', async () => {
    const { container } = show(true);
    // In the order the host lists a plugin's panels.
    await waitFor(() =>
      expect(apps(container)).toEqual([
        'run-inspector',
        'schedule-editor',
        'run-timeline',
        'failure-explanation',
      ]),
    );
  });

  test('is mounted beside the timeline on a workflow instance that failed, which has no run inspector or schedule editor', async () => {
    // The run inspector and the schedule editor read a task, which an instance has none of, and
    // the comparison needs a fork: the scope table leaves each off. The timeline reads `runId`.
    const failed = show(true, { workflowId: 'instance-1', fork: false });
    await waitFor(() =>
      expect(apps(failed.container)).toEqual(['run-timeline', 'failure-explanation']),
    );
  });

  test('leaves a workflow instance that did not fail with the timeline alone', async () => {
    const running = show(false, { workflowId: 'instance-1', fork: false });
    await waitUntil(() => listed, { message: 'the host lists its panels' });
    await waitFor(() => expect(apps(running.container)).toEqual(['run-timeline']));
    // Nothing else appears once the host has answered the list.
    await quietFor(50);
    expect(apps(running.container)).toEqual(['run-timeline']);
  });

  test('puts the comparison on a fork whether or not it failed, and the explanation only when it did', async () => {
    const failed = show(true, { workflowId: 'fork-1', fork: true });
    await waitFor(() =>
      expect(apps(failed.container)).toEqual([
        'run-timeline',
        'failure-explanation',
        'run-comparison',
      ]),
    );
    failed.unmount();
    cleanup();
    restore?.();
    const settled = show(false, { workflowId: 'fork-1', fork: true });
    await waitUntil(() => listed, { message: 'the host lists its panels' });
    await waitFor(() =>
      expect(apps(settled.container)).toEqual(['run-timeline', 'run-comparison']),
    );
  });

  test('keeps the comparison off an agent run, failed or not', async () => {
    const failed = show(true);
    await waitFor(() => expect(apps(failed.container)).toContain('failure-explanation'));
    expect(apps(failed.container)).not.toContain('run-comparison');
  });

  test('is left off the page of a run that did not fail, which keeps the panels every run has', async () => {
    const { container } = show(false);
    await waitFor(() =>
      expect(apps(container)).toEqual(['run-inspector', 'schedule-editor', 'run-timeline']),
    );
    expect(container.textContent).not.toContain('Failure explanation');
  });
});
