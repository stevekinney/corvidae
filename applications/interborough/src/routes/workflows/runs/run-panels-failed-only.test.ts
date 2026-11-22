/**
 * COR-2543, "Coordinator, 2026-11-22: shown only for failed runs": a panel that places itself on a
 * run's page `when: 'failed'` is mounted for a run that failed and for no other, so a run that did
 * not fail shows no card with nothing to say. A run placement with no condition mounts on every run.
 */
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { bureau } from '../../chat/pages.test-support.ts';
import QueryPage from '../../chat/query-page.test-harness.svelte';
import RunPanels from './run-panels.svelte';

let restore: (() => void) | undefined;
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
    app: 'failure-explanation',
    title: 'Failure explanation',
    uri: 'ui://inspectors/failure-explanation/v1',
    opensFromTool: 'bureau.tasks.explain',
    placements: [
      { kind: 'run', when: 'failed' },
      { kind: 'chat-tool', agentTool: 'bureau:tasks-explain' },
    ],
  },
];

function show(failed: boolean) {
  restore = bureau({}, (url) =>
    url.endsWith('/host/panels')
      ? Response.json({ apps: APPS })
      : new Response('{}', { status: 404 }),
  ).restore;
  return render(QueryPage, {
    props: { page: RunPanels, pageProps: { taskId: 'run-1', failed } },
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
    await waitFor(() => expect(apps(container)).toEqual(['run-inspector', 'failure-explanation']));
  });

  test('is left off the page of a run that did not fail, which keeps the panels every run has', async () => {
    const { container } = show(false);
    await waitFor(() => expect(apps(container)).toEqual(['run-inspector']));
    expect(container.textContent).not.toContain('Failure explanation');
  });
});
