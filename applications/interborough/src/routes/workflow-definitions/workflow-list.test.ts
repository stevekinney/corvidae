/**
 * `/workflows`: every workflow definition the engine knows, joined with the Bureau's workflow
 * files. A code-defined type has no badge; every Bureau file has the agent-authored one, and its
 * owning agent when it names one. A file the Bureau cannot use is listed with its error and its
 * path, a source that failed to load shows its category, and a source with no file is left out.
 */
import { cleanup, render, waitFor } from '@testing-library/svelte';
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
  STUB_WORKFLOW_DIRECTORY,
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

function open(overrides: Partial<World> = {}) {
  stub = installWorkflowWorld(
    emptyWorld({
      definitions: [
        codeDefinition('order-processing'),
        sourceDefinition('digest'),
        sourceDefinition('flaky', {
          state: 'failed',
          lastFailureCategory: 'timeout',
          contract: null,
          description: null,
        }),
        sourceDefinition('deleted-yesterday'),
      ],
      files: [
        readyFile('digest', { agent: 'writer' }),
        readyFile('flaky', { agent: null }),
        invalidFile('broken'),
      ],
      ...overrides,
    }),
  );
  router.navigate('/workflows', { replace: true });
  return render(RouteOutletHarness, {
    props: { client: stub.client, scopes: AUTHORIZATION_SCOPES },
  } as never);
}

function row(container: HTMLElement, name: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-workflow="${name}"]`);
  if (found === null) throw new Error(`No row for ${name}.`);
  return found;
}

describe('the list of workflows', () => {
  test('has a row for each definition and file, by name, and leaves out a source with no file', async () => {
    const { container, findByRole } = open();
    await findByRole('heading', { level: 1, name: 'Workflows' });
    await waitFor(() => expect(container.querySelectorAll('[data-workflow]').length).toBe(4));

    const names = [...container.querySelectorAll('[data-workflow]')].map((node) =>
      node.getAttribute('data-workflow'),
    );
    expect(names).toEqual(['broken', 'digest', 'flaky', 'order-processing']);
    expect(container.querySelector('[data-workflow="deleted-yesterday"]')).toBeNull();
    expect(container.querySelector('[data-view="workflows"]')?.getAttribute('data-state')).toBe(
      'ready',
    );
  });

  test('badges every file as agent-authored, with its agent when it has one, and a code type with nothing', async () => {
    const { container } = open();
    await waitFor(() => expect(container.querySelectorAll('[data-workflow]').length).toBe(4));

    const digest = row(container, 'digest');
    expect(digest.dataset['kind']).toBe('agent-authored');
    expect(digest.textContent).toContain(WORKFLOW_COPY.agentAuthoredBadge);
    expect(digest.textContent).toContain(WORKFLOW_COPY.owner('writer'));

    const flaky = row(container, 'flaky');
    expect(flaky.textContent).toContain(WORKFLOW_COPY.agentAuthoredBadge);
    expect(flaky.textContent).not.toContain(WORKFLOW_COPY.owner('writer'));
    expect(flaky.querySelector('[data-testid="workflow-agent"]')).toBeNull();

    const code = row(container, 'order-processing');
    expect(code.dataset['kind']).toBe('code');
    expect(code.textContent).not.toContain(WORKFLOW_COPY.agentAuthoredBadge);
    expect(code.textContent).toContain('The order-processing workflow.');
  });

  test('shows an invalid file with its message, its issues, and its path', async () => {
    const { container } = open();
    await waitFor(() => expect(container.querySelectorAll('[data-workflow]').length).toBe(4));

    const broken = row(container, 'broken');
    expect(broken.dataset['state']).toBe('invalid');
    expect(broken.textContent).toContain(WORKFLOW_COPY.invalidBadge);
    expect(broken.querySelector('[data-testid="workflow-problem"]')?.textContent).toContain(
      'The document is not a workflow.',
    );
    expect(broken.querySelector('[data-testid="workflow-issues"]')?.textContent).toContain(
      'trigger.spec',
    );
    expect(broken.querySelector('[data-testid="workflow-issues"]')?.textContent).toContain(
      'Not a schedule specification.',
    );
    expect(broken.querySelector('[data-testid="workflow-file-path"]')?.textContent).toBe(
      `${STUB_WORKFLOW_DIRECTORY}/broken.json`,
    );
    // A file that loaded has none of these.
    expect(row(container, 'digest').querySelector('[data-testid="workflow-problem"]')).toBeNull();
  });

  test('shows the category of a source that failed to load, in a label of its own', async () => {
    const { container } = open();
    await waitFor(() => expect(container.querySelectorAll('[data-workflow]').length).toBe(4));

    const flaky = row(container, 'flaky');
    expect(flaky.dataset['state']).toBe('failed');
    expect(flaky.querySelector('[data-testid="workflow-failure"]')?.textContent).toBe(
      WORKFLOW_COPY.sourceFailed('timeout'),
    );
    expect(row(container, 'digest').querySelector('[data-testid="workflow-failure"]')).toBeNull();
  });

  test('shows the path relative to the state directory when the host does not say where', async () => {
    const { container } = open({ workflowDirectory: null });
    await waitFor(() => expect(container.querySelectorAll('[data-workflow]').length).toBe(4));
    expect(
      row(container, 'broken').querySelector('[data-testid="workflow-file-path"]')?.textContent,
    ).toBe(`${WORKFLOW_COPY.fallbackDirectory}/broken.json`);
  });

  test('links each name to its page, and leaves a modified click to the browser', async () => {
    const { container } = open();
    await waitFor(() => expect(container.querySelectorAll('[data-workflow]').length).toBe(4));
    const link = row(container, 'digest').querySelector('a');
    expect(link?.getAttribute('href')).toBe('/workflows/digest');

    link?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }),
    );
    expect(router.pathname).toBe('/workflows');
    link?.click();
    expect(router.pathname).toBe('/workflows/digest');
  });
});
