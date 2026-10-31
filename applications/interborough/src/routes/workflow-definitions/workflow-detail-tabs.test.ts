/**
 * `/workflows/:workflow` by its tabs: the Code tab for a file and for a code-defined type, the
 * History tab's compatibility verdicts, the tab in the address, and starting a run from the header.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { WORKFLOW_COPY } from '../../app/copy.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import {
  codeDefinition,
  emptyWorld,
  installWorkflowWorld,
  invalidFile,
  readyFile,
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

async function openTab(root: HTMLElement, name: string): Promise<void> {
  const tab = [...root.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (candidate) => candidate.textContent?.trim() === name,
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
    const outline = [...(testId(root, 'workflow-outline')?.querySelectorAll('li') ?? [])];
    expect(outline.map((step) => step.textContent)).toEqual([
      expect.stringContaining('writer'),
      expect.stringContaining('approve'),
    ]);
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
  test('shows the file and an empty outline', async () => {
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
    expect(testId(root, 'workflow-code')?.textContent).toContain(WORKFLOW_COPY.page.code.noOutline);
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
  /** The dialog's own button, which is named like the header's and comes after it in the document. */
  const confirmButton = (): HTMLElement => {
    const buttons = [...document.querySelectorAll('button')].filter(
      (button) => button.textContent?.trim() === WORKFLOW_COPY.startDialog.confirm,
    );
    return buttons[buttons.length - 1] as HTMLElement;
  };

  const startButton = (root: ParentNode) =>
    [...root.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === WORKFLOW_COPY.page.startAction,
    );

  test.each([
    ['a ready file that is not paused', '/workflows/digest', true],
    ['a paused file', '/workflows/paused-one', false],
    ['a code-defined type', '/workflows/order-processing', false],
    ['a type the Bureau registers for itself', '/workflows/agentRun', false],
    ['an invalid file', '/workflows/broken', false],
  ])('%s: the header offers Start run is %p', async (_name, path, offered) => {
    const { container } = open(path);
    const root = await ready(container);
    expect(startButton(root) !== undefined).toBe(offered);
  });

  test('starts with the input as JSON, and goes to the new run', async () => {
    const { container, findByRole } = open('/workflows/digest');
    const root = await ready(container);
    await fireEvent.click(startButton(root) as HTMLElement);
    await fireEvent.input(
      await findByRole('textbox', { name: WORKFLOW_COPY.startDialog.inputLabel }),
      {
        target: { value: '{ "topic": "weather" }' },
      },
    );
    await fireEvent.click(confirmButton());

    await waitFor(() =>
      expect(stub?.world.startedRuns).toEqual([{ id: 'digest', input: { topic: 'weather' } }]),
    );
    expect(stub?.callsTo('bureau.workflows.start')[0]?.params).toMatchObject({
      id: 'digest',
      surface: 'web',
    });
    await waitFor(() => expect(router.pathname).toBe('/workflows/digest/runs/run-started-1'));
  });

  test('starts with no input when the field is empty', async () => {
    const { container, findByRole } = open('/workflows/digest');
    const root = await ready(container);
    await fireEvent.click(startButton(root) as HTMLElement);
    await findByRole('textbox', { name: WORKFLOW_COPY.startDialog.inputLabel });
    await fireEvent.click(confirmButton());
    await waitFor(() => expect(stub?.world.startedRuns).toEqual([{ id: 'digest', input: null }]));
    expect(stub?.callsTo('bureau.workflows.start')[0]?.params).not.toHaveProperty('input');
  });

  test('refuses input that is not JSON, and starts nothing', async () => {
    const { container, findByRole, findByText } = open('/workflows/digest');
    const root = await ready(container);
    await fireEvent.click(startButton(root) as HTMLElement);
    await fireEvent.input(
      await findByRole('textbox', { name: WORKFLOW_COPY.startDialog.inputLabel }),
      {
        target: { value: '{ nope' },
      },
    );
    await fireEvent.click(confirmButton());
    expect(await findByText(WORKFLOW_COPY.startDialog.invalidInput)).not.toBeNull();
    expect(stub?.callsTo('bureau.workflows.start')).toEqual([]);
  });

  test('shows the Bureau’s refusal in the dialog and stays on the page', async () => {
    const { container, findByRole, findByText } = open('/workflows/digest');
    stub?.on('bureau.workflows.start', () => {
      throw workflowFaults.unprocessable('The input breaks the schema.');
    });
    const root = await ready(container);
    await fireEvent.click(startButton(root) as HTMLElement);
    await findByRole('textbox', { name: WORKFLOW_COPY.startDialog.inputLabel });
    await fireEvent.click(confirmButton());
    expect(await findByText('The input breaks the schema.')).not.toBeNull();
    expect(router.pathname).toBe('/workflows/digest');
  });

  test('is the action of the Runs tab’s empty state', async () => {
    const { container, findByRole } = open('/workflows/digest', { runs: [] });
    const root = await ready(container);
    await openTab(root, TABS.runs);
    await waitFor(() =>
      expect(testId(root, 'workflow-recent-runs')?.textContent).toContain(
        WORKFLOW_COPY.page.runs.emptyTitle,
      ),
    );
    const action = testId(root, 'workflow-recent-runs')?.querySelector(
      '.cinder-empty-state button',
    );
    expect(action?.textContent?.trim()).toBe(WORKFLOW_COPY.page.startAction);
    await fireEvent.click(action as HTMLElement);
    expect(
      await findByRole('textbox', { name: WORKFLOW_COPY.startDialog.inputLabel }),
    ).not.toBeNull();
  });

  test('closes with Cancel and starts nothing, and opens again empty', async () => {
    const { container, findByRole } = open('/workflows/digest');
    const root = await ready(container);
    await fireEvent.click(startButton(root) as HTMLElement);
    await fireEvent.input(
      await findByRole('textbox', { name: WORKFLOW_COPY.startDialog.inputLabel }),
      { target: { value: '{ nope' } },
    );
    await fireEvent.click(confirmButton());
    const cancel = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === WORKFLOW_COPY.startDialog.cancel,
    );
    await fireEvent.click(cancel as HTMLElement);
    await waitFor(() => expect(testId(document.body, 'workflow-start-form')).toBeNull());
    expect(stub?.callsTo('bureau.workflows.start')).toEqual([]);
    expect(router.pathname).toBe('/workflows/digest');
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
      if (reads === 1) throw workflowFaults.unavailable();
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
      if (reads === 1) throw workflowFaults.unavailable();
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
