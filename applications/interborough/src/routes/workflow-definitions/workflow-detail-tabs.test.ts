/**
 * `/workflows/:workflow` by its tabs: the Code tab for a file and for a code-defined type, the
 * History tab's compatibility verdicts, the tab in the address, and the header's Start run, which
 * opens the run setup page.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { TASK_COPY, WORKFLOW_COPY } from '../../app/copy.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import {
  codeDefinition,
  emptyWorld,
  installWorkflowWorld,
  invalidFile,
  readyFile,
  runFixture,
  sourceDefinition,
  workflowFaults,
  type RevisionFixture,
  type WorkflowStub,
  type World,
} from '../../lib/workflow-world.test-support.ts';
import RouteOutletHarness from './area-harness.test-harness.svelte';

let stub: WorkflowStub | undefined;

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
});

afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

const TABS = WORKFLOW_COPY.page.tabs;

function revision(
  version: string,
  compatibility: NonNullable<RevisionFixture['compatibility']> | null,
): RevisionFixture {
  return {
    workflowVersion: version,
    firstRunAt: '2026-10-19T08:00:00.000Z',
    lastRunAt: '2026-10-19T09:00:00.000Z',
    document: { name: 'digest', trigger: { kind: 'schedule', spec: '0 6 * * *' }, steps: [] },
    compatibility,
  };
}

function open(path: string, overrides: Partial<World> = {}) {
  stub = installWorkflowWorld(
    emptyWorld({
      definitions: [
        codeDefinition('order-processing'),
        codeDefinition('agentRun'),
        sourceDefinition('digest', { signals: ['approve'] }),
      ],
      files: [
        readyFile('digest'),
        readyFile('paused-one', { paused: true }),
        invalidFile('broken'),
      ],
      ...overrides,
    }),
  );
  router.navigate(path, { replace: true });
  return render(RouteOutletHarness, {
    props: { client: stub.client, scopes: AUTHORIZATION_SCOPES },
  } as never);
}

const testId = (root: ParentNode, id: string) =>
  root.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function ready(container: HTMLElement): Promise<HTMLElement> {
  await waitFor(() =>
    expect(
      container.querySelector('[data-page="workflow-detail"] [data-testid="workflow-overview"]'),
    ).toBeTruthy(),
  );
  return container.querySelector<HTMLElement>('[data-page="workflow-detail"]') as HTMLElement;
}

/** A tab's name without the count that follows its label once the count is known ("Runs 2"). */
const withoutCount = (label: string | undefined) => label?.trim().replace(/\s+\d+$/, '');

async function openTab(root: HTMLElement, name: string): Promise<void> {
  const tab = [...root.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (candidate) => withoutCount(candidate.textContent) === name,
  );
  if (tab === undefined) throw new Error(`No tab called ${name}.`);
  await fireEvent.click(tab);
  await waitFor(() => expect(tab.getAttribute('aria-selected')).toBe('true'));
}

describe('the Code tab of an agent-authored workflow', () => {
  test('shows the file as it is on disk, and an outline of its steps', async () => {
    const { container } = open('/workflows/digest');
    const root = await ready(container);
    await openTab(root, TABS.code);

    const source = testId(root, 'workflow-file-source');
    expect(source?.textContent).toContain('"kind": "await-signal"');
    expect(source?.textContent).toContain('"name": "digest"');
    // The file is read-only, numbered, and has a Copy button, under a line that says where it is.
    expect(testId(root, 'workflow-code')?.textContent).toContain(
      WORKFLOW_COPY.page.code.caption.after.trim(),
    );
    expect(source?.querySelector('.cinder-code-block--numbered')).not.toBeNull();
    // The outline names the parts the file has, with the steps under steps.
    const labels = [...(testId(root, 'workflow-outline')?.querySelectorAll('a') ?? [])].map(
      (link) => link.textContent?.trim(),
    );
    expect(labels).toEqual(['name', 'trigger', 'steps', '1 Step 1', '2 Step 2']);
    // Each entry points at a line of the file that carries the id it links to.
    for (const link of testId(root, 'workflow-outline')?.querySelectorAll('a') ?? []) {
      const id = link.getAttribute('href')?.replace(/^#/, '') ?? '';
      expect(root.querySelector(`[id="${id}"]`)).not.toBeNull();
    }
    // A file is read with `get`; the code-defined read is for a type with no file.
    expect(stub?.callsTo('bureau.workflows.internal.get')).toEqual([]);
  });

  test('shows an invalid file’s text too, with no outline, because it has no steps to outline', async () => {
    const { container } = open('/workflows/broken', {
      files: [readyFile('digest'), invalidFile('broken', { text: '{ "name": "broken", ' })],
    });
    const root = await ready(container);
    await openTab(root, TABS.code);
    expect(testId(root, 'workflow-file-source')?.textContent).toContain('"name": "broken"');
    expect(testId(root, 'workflow-outline')).toBeNull();
  });

  test('says there is nothing to show for a file the Bureau could not read', async () => {
    const { container } = open('/workflows/broken', {
      files: [readyFile('digest'), invalidFile('broken', { text: null, hash: null })],
    });
    const root = await ready(container);
    await openTab(root, TABS.code);
    expect(testId(root, 'workflow-file-source')).toBeNull();
    expect(testId(root, 'workflow-code')?.textContent).toContain(WORKFLOW_COPY.page.code.noText);
  });
});

describe('the Code tab of a file with no steps', () => {
  test('shows the file, and no outline for a file written on one line', async () => {
    const text = JSON.stringify({
      name: 'empty',
      trigger: { kind: 'signal', name: 'go' },
      steps: [],
    });
    const { container } = open('/workflows/empty', {
      definitions: [],
      files: [readyFile('empty', { text })],
    });
    const root = await ready(container);
    await openTab(root, TABS.code);
    expect(testId(root, 'workflow-file-source')?.textContent).toContain('"steps":[]');
    expect(testId(root, 'workflow-outline')).toBeNull();
  });
});

describe('the Code tab of a code-defined workflow', () => {
  test('shows the description and registered contract, and says it is not the code', async () => {
    const { container } = open('/workflows/order-processing');
    const root = await ready(container);
    expect(stub?.callsTo('bureau.workflows.internal.get')).toEqual([]);
    await openTab(root, TABS.code);

    await waitFor(() => expect(testId(root, 'workflow-code-source')).not.toBeNull());
    const source = testId(root, 'workflow-code-source');
    expect(source?.textContent).toContain('The order-processing workflow.');
    expect(source?.textContent).toContain('"orderId"');
    expect(testId(root, 'workflow-code')?.textContent).toContain(WORKFLOW_COPY.page.code.codeNote);
    expect(testId(root, 'workflow-code')?.textContent).not.toContain(
      WORKFLOW_COPY.page.code.fileHeading,
    );
    expect(stub?.callsTo('bureau.workflows.internal.get')[0]?.params).toEqual({
      id: 'order-processing',
    });
  });

  test('says there is no source when the Bureau does not know the type as code', async () => {
    const { container } = open('/workflows/order-processing');
    stub?.on('bureau.workflows.internal.get', () => {
      throw workflowFaults.notFound('workflow order-processing');
    });
    const root = await ready(container);
    await openTab(root, TABS.code);
    await waitFor(() =>
      expect(testId(root, 'workflow-code')?.textContent).toContain(
        WORKFLOW_COPY.page.code.unavailableTitle,
      ),
    );
  });

  test('says the source could not be loaded, and reads it again on retry', async () => {
    const { container, findByRole } = open('/workflows/order-processing');
    let reads = 0;
    stub?.on('bureau.workflows.internal.get', () => {
      reads += 1;
      if (reads === 1) throw workflowFaults.unavailable();
      return {
        id: 'order-processing',
        description: 'Back.',
        version: '1.0.0',
        source: { kind: 'code', text: 'Back.' },
      };
    });
    const root = await ready(container);
    await openTab(root, TABS.code);
    await waitFor(() =>
      expect(testId(root, 'workflow-code')?.textContent).toContain(
        WORKFLOW_COPY.page.code.failedTitle,
      ),
    );
    await fireEvent.click(await findByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(testId(root, 'workflow-code-source')?.textContent).toContain('Back.'),
    );
  });
});

describe('the History tab', () => {
  test('shows each version’s verdict against the current revision, and the reasons it is not compatible', async () => {
    const { container } = open('/workflows/digest', {
      revisions: {
        digest: [
          revision('version-current', { compatible: true }),
          revision('version-old', {
            compatible: false,
            reasons: ['workflow-version-incompatible', 'artifact-revision-mismatch'],
          }),
        ],
      },
    });
    const root = await ready(container);
    await openTab(root, TABS.history);
    await waitFor(() => expect(root.querySelectorAll('[data-version]').length).toBe(2));

    const rows = [...root.querySelectorAll<HTMLElement>('[data-version]')];
    expect(rows[0]?.textContent).toContain(WORKFLOW_COPY.revisions.compatible);
    expect(rows[0]?.querySelector('[data-testid="workflow-revision-reasons"]')).toBeNull();
    expect(rows[1]?.textContent).toContain(WORKFLOW_COPY.revisions.incompatible);
    const reasons = [
      ...(rows[1]?.querySelectorAll('[data-testid="workflow-revision-reasons"] li') ?? []),
    ].map((reason) => reason.textContent);
    expect(reasons).toEqual([
      WORKFLOW_COPY.revisions.reason('workflow-version-incompatible'),
      WORKFLOW_COPY.revisions.reason('artifact-revision-mismatch'),
    ]);
  });

  test('says there is no current revision to compare with when the Bureau gives no verdict', async () => {
    const { container } = open('/workflows/digest', {
      revisions: { digest: [revision('version-gone', null)] },
    });
    const root = await ready(container);
    await openTab(root, TABS.history);
    await waitFor(() =>
      expect(testId(root, 'workflow-revisions')?.textContent).toContain(
        WORKFLOW_COPY.revisions.noCurrent,
      ),
    );
  });

  test('names a reason it does not know rather than hiding it', () => {
    expect(WORKFLOW_COPY.revisions.reason('from-the-future')).toBe(
      'Unknown reason: from-the-future',
    );
  });

  test('is an empty state when no version has run', async () => {
    const { container } = open('/workflows/digest', { revisions: { digest: [] } });
    const root = await ready(container);
    await openTab(root, TABS.history);
    await waitFor(() =>
      expect(testId(root, 'workflow-revisions')?.textContent).toContain(
        WORKFLOW_COPY.revisions.emptyTitle,
      ),
    );
    expect(testId(root, 'workflow-revisions')?.querySelector('.cinder-empty-state')).not.toBeNull();
  });
});

describe('the tab in the address', () => {
  test('opens on the tab the address names, and writes the tab it is changed to', async () => {
    const { container } = open('/workflows/digest?tab=code');
    await waitFor(() => expect(testId(container, 'workflow-code')).not.toBeNull());
    expect(router.search.get('tab')).toBe('code');

    const overview = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (tab) => tab.textContent?.trim() === TABS.overview,
    );
    await fireEvent.click(overview as HTMLElement);
    await waitFor(() => expect(testId(container, 'workflow-overview')).not.toBeNull());
    expect(router.search.has('tab')).toBe(false);
  });

  test('reads a jump back through history to an older tab, and does not write over it', async () => {
    const { container } = open('/workflows/digest?tab=runs');
    await waitFor(() => expect(testId(container, 'workflow-recent-runs')).not.toBeNull());
    const root = container.querySelector<HTMLElement>(
      '[data-page="workflow-detail"]',
    ) as HTMLElement;
    await openTab(root, TABS.code);
    await openTab(root, TABS.overview);
    expect(router.search.has('tab')).toBe(false);
    const entries = window.history.length;

    // Two steps back is the Runs entry; the Code entry sits between it and the address of no tab.
    router.back();
    await waitFor(() => expect(router.search.get('tab')).toBe('code'));
    await waitFor(() => expect(testId(container, 'workflow-code')).not.toBeNull());
    router.back();
    await waitFor(() => expect(router.search.get('tab')).toBe('runs'));
    await waitFor(() => expect(testId(container, 'workflow-recent-runs')).not.toBeNull());
    // Each entry was only read: none was replaced and none was added.
    expect(window.history.length).toBe(entries);
    router.forward();
    await waitFor(() => expect(router.search.get('tab')).toBe('code'));
    router.forward();
    await waitFor(() => expect(router.search.has('tab')).toBe(false));
    await waitFor(() => expect(testId(container, 'workflow-overview')).not.toBeNull());
  });

  test('falls back to the Overview for a tab the workflow does not have', async () => {
    const { container } = open('/workflows/agentRun?tab=history');
    const root = await ready(container);
    expect(root.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim()).toBe(
      TABS.overview,
    );
    await waitFor(() => expect(router.search.has('tab')).toBe(false));
  });
});

describe('starting a run', () => {
  /** The header's Start run, which is a link to the run setup page. */
  const startLink = (root: ParentNode) =>
    [...root.querySelectorAll('a')].find(
      (link) => link.textContent?.trim() === WORKFLOW_COPY.page.startAction,
    );

  test.each([
    ['a ready file that is not paused', '/workflows/digest', '/workflows/digest/run'],
    ['a code-defined type', '/workflows/order-processing', '/workflows/order-processing/run'],
    ['a paused file', '/workflows/paused-one', undefined],
    ['a type the Bureau registers for itself', '/workflows/agentRun', undefined],
    ['an invalid file', '/workflows/broken', undefined],
  ])('%s: the header offers Start run, to %p', async (_name, path, destination) => {
    const { container } = open(path);
    const root = await ready(container);
    expect(startLink(root)?.getAttribute('href')).toBe(destination);
  });

  test('opens the run setup page, and starts nothing on the way', async () => {
    const { container } = open('/workflows/digest');
    const root = await ready(container);
    await fireEvent.click(startLink(root) as HTMLElement);
    await waitFor(() => expect(router.pathname).toBe('/workflows/digest/run'));
    expect(stub?.callsTo('bureau.workflows.start')).toEqual([]);
  });

  test('is what the Runs tab’s empty state names, in a plain hint under its sentence', async () => {
    const { container } = open('/workflows/digest', { runs: [] });
    const root = await ready(container);
    await openTab(root, TABS.runs);
    await waitFor(() =>
      expect(testId(root, 'workflow-recent-runs')?.textContent).toContain(
        WORKFLOW_COPY.page.runs.emptyTitle,
      ),
    );
    expect(testId(root, 'workflow-runs-hint')?.textContent).toBe(WORKFLOW_COPY.page.runs.emptyHint);
    // The action is the header's Start run, so the empty state draws no button of its own (63c).
    expect(
      testId(root, 'workflow-recent-runs')?.querySelector('.cinder-empty-state button'),
    ).toBeNull();
    expect(startLink(root)?.getAttribute('href')).toBe('/workflows/digest/run');
  });

  test('names an agent-run origin by its kind and the agent whose tool call started it', async () => {
    const { container } = open('/workflows/digest', {
      runs: [
        runFixture('agent-run-1', 'digest', {
          origin: { kind: 'agent-run', agentId: 'journey-author', runId: 'calling-run-1' },
        }),
      ],
    });
    const root = await ready(container);
    await openTab(root, TABS.runs);
    await waitFor(() => expect(root.querySelector('[data-run="agent-run-1"]')).not.toBeNull());
    const row = root.querySelector('[data-run="agent-run-1"]') as HTMLElement;
    // Line two is the Runs list's: the kind of run first, then the agent that called it.
    expect(row.textContent).toContain(
      `${TASK_COPY.list.kinds['agent-run']}${TASK_COPY.list.separator}Journey author`,
    );
    expect(row.textContent).not.toContain('agent-run,');
    expect(row.querySelector('a')?.getAttribute('href')).toBe('/workflows/digest/runs/agent-run-1');
  });
});

describe('the Runs tab of a workflow that cannot be started from the page', () => {
  test('a paused file says why nothing runs it, and the header’s Resume starts it again', async () => {
    const { container, getByRole } = open('/workflows/paused-one', { runs: [] });
    const root = await ready(container);
    await openTab(root, TABS.runs);
    const runs = (): HTMLElement => testId(root, 'workflow-recent-runs') as HTMLElement;
    await waitFor(() =>
      expect(runs().textContent).toContain(WORKFLOW_COPY.page.runs.emptyDescriptionPaused),
    );
    expect(testId(runs(), 'workflow-runs-hint')?.textContent).toBe(
      WORKFLOW_COPY.page.runs.emptyHintPaused,
    );

    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.resumeAction }));
    await waitFor(() => expect(stub?.callsTo('bureau.workflows.resume')).toHaveLength(1));
    await waitFor(() => expect(stub?.file('paused-one')?.paused).toBe(false));
    // Resumed, the hint names Start run instead, which the header now offers.
    await waitFor(() =>
      expect(testId(runs(), 'workflow-runs-hint')?.textContent).toBe(
        WORKFLOW_COPY.page.runs.emptyHint,
      ),
    );
  });

  test('a type the Bureau registers for itself promises no trigger and offers no action', async () => {
    const { container } = open('/workflows/agentRun', { runs: [] });
    const root = await ready(container);
    await openTab(root, TABS.runs);
    const runs = (): HTMLElement => testId(root, 'workflow-recent-runs') as HTMLElement;
    await waitFor(() =>
      expect(runs().textContent).toContain(WORKFLOW_COPY.page.runs.emptyDescriptionCode),
    );
    expect(runs().textContent).not.toContain('trigger');
    expect(runs().querySelector('.cinder-empty-state button')).toBeNull();
    expect(testId(runs(), 'workflow-runs-hint')).toBeNull();
  });
});

describe('a part of the tabs that fails', () => {
  const retry = (root: ParentNode) =>
    [...root.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Try again',
    );

  test('reads the runs again on retry', async () => {
    const { container } = open('/workflows/digest', { runs: [] });
    let reads = 0;
    stub?.on('bureau.workflows.runs.list', () => {
      reads += 1;
      // The page's header reads the newest runs when it loads (for the Runs count and the last-run
      // line), then the tab reads them: both fail, and the retry is the third read.
      if (reads <= 2) throw workflowFaults.unavailable();
      return { runs: [], nextOffset: null };
    });
    const root = await ready(container);
    await openTab(root, TABS.runs);
    await waitFor(() => expect(retry(root)).toBeDefined());
    await fireEvent.click(retry(root) as HTMLElement);
    await waitFor(() =>
      expect(testId(root, 'workflow-recent-runs')?.textContent).toContain(
        WORKFLOW_COPY.page.runs.emptyTitle,
      ),
    );
  });

  test('reads the history again on retry', async () => {
    const { container } = open('/workflows/digest', { revisions: { digest: [] } });
    let reads = 0;
    stub?.on('bureau.workflows.revisions', () => {
      reads += 1;
      // The page reads the versions when it loads, for the History count, and the tab, which asks
      // for the same list, reads again as it opens: both fail, and the retry is the third read.
      if (reads <= 2) throw workflowFaults.unavailable();
      return { revisions: [] };
    });
    const root = await ready(container);
    await openTab(root, TABS.history);
    await waitFor(() => expect(retry(root)).toBeDefined());
    await fireEvent.click(retry(root) as HTMLElement);
    await waitFor(() =>
      expect(testId(root, 'workflow-revisions')?.textContent).toContain(
        WORKFLOW_COPY.revisions.emptyTitle,
      ),
    );
  });
});
