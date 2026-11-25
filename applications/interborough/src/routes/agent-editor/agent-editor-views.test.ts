/**
 * The agent editor inside its view frame, through the route outlet: the states the frame owns
 * (not found, for an agent that is missing, one defined in code, or one whose file was deleted
 * while the page was open) and the editor's own routes in the route table.
 */
import { HttpClient } from '@lostgradient/weft';
import { fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { AGENT_EDITOR_COPY, AGENT_PAGE_COPY } from '../../app/copy/agents.ts';
import { VIEW_COPY } from '../../app/copy/view-pages.ts';
import { RETRY_LABEL } from '../../app/copy/views.ts';
import RouteOutletHarness from '../../app/shell/route-outlet.test-harness.svelte';
import {
  catalogFixture,
  faults,
  installBureauStub,
  readyAgent,
  StubFault,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';

let stub: BureauStub | undefined;

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
});

afterEach(() => {
  stub?.restore();
  stub = undefined;
});

function landAt(path: string): void {
  router.navigate(path, { replace: true });
}

function mountOutlet() {
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  });
}

function frameOf(container: HTMLElement): HTMLElement {
  const frame = container.querySelector<HTMLElement>('.weft-view[data-view="agent-editor"]');
  if (frame === null) throw new Error('The agent editor’s frame did not render.');
  return frame;
}

const NOT_FOUND = VIEW_COPY['agent-editor'].notFound;

function bureau(agent: () => unknown): BureauStub {
  stub = installBureauStub({
    'bureau.agents.catalog': () => catalogFixture(),
    'bureau.agents.definitions.get': agent,
    'bureau.agents.definitions.revisions': () => ({ revisions: [] }),
    'bureau.agents.definitions.update': () => ({ id: 'researcher', hash: 'hash-2' }),
  });
  return stub;
}

describe('the editor’s routes', () => {
  test('/agents/new is the editor, ready once the catalog answers', async () => {
    bureau(() => readyAgent());
    landAt('/agents/new');
    const { container, findByRole } = mountOutlet();

    expect(
      await findByRole('heading', { level: 1, name: AGENT_EDITOR_COPY.createHeading }),
    ).not.toBeNull();
    await waitFor(() => expect(frameOf(container).dataset['state']).toBe('ready'));
  });

  test('/agents/:agent/edit is the editor for that agent, ready once the agent loads', async () => {
    const calls = bureau(() => readyAgent());
    landAt('/agents/researcher/edit');
    const { container, findByRole } = mountOutlet();

    expect(await findByRole('heading', { level: 1, name: 'Edit Researcher' })).not.toBeNull();
    expect(frameOf(container).dataset['state']).toBe('ready');
    expect(
      calls
        .callsTo('bureau.agents.definitions.get')
        .every((call) => call.params['id'] === 'researcher'),
    ).toBe(true);
    expect(calls.callsTo('bureau.agents.definitions.get')).toHaveLength(2);
  });

  test('/agents/:agent/edit keeps its saved display name while the catalog loads', async () => {
    const calls = bureau(() => readyAgent());
    let releaseCatalog: () => void = () => undefined;
    const catalogHeld = new Promise<void>((resolve) => (releaseCatalog = resolve));
    calls.on('bureau.agents.catalog', async () => {
      await catalogHeld;
      return catalogFixture();
    });
    landAt('/agents/researcher/edit');
    const { container, findByRole, findByTestId } = mountOutlet();

    try {
      expect(await findByRole('heading', { level: 1, name: 'Edit Researcher' })).not.toBeNull();
      expect(await findByTestId('agent-loading')).not.toBeNull();
      expect(frameOf(container).dataset['state']).toBe('ready');
    } finally {
      releaseCatalog();
    }

    expect(await findByRole('form', { name: AGENT_EDITOR_COPY.formLabel })).not.toBeNull();
  });
});

describe('an agent that cannot be edited', () => {
  test('is not found when no such agent exists, with the words copy.ts holds', async () => {
    bureau(() => {
      throw faults.notFound('nobody');
    });
    landAt('/agents/nobody/edit');
    const { container, findByRole } = mountOutlet();

    expect(await findByRole('heading', { level: 1, name: NOT_FOUND?.title ?? '' })).not.toBeNull();
    expect(frameOf(container).dataset['state']).toBe('not-found');
    expect(container.textContent).toContain(NOT_FOUND?.description ?? '');
    // No form, no delete, and no revision history: there is nothing to edit.
    expect(container.querySelector('form')).toBeNull();
  });

  test('is not found for a code-defined agent, which can be read but not written', async () => {
    bureau(() => readyAgent({ id: 'assistant', source: 'code', hash: null, definition: null }));
    landAt('/agents/assistant/edit');
    const { container, findByRole } = mountOutlet();

    expect(await findByRole('heading', { level: 1, name: NOT_FOUND?.title ?? '' })).not.toBeNull();
    expect(frameOf(container).dataset['state']).toBe('not-found');
    expect(container.querySelector('form')).toBeNull();
  });

  test('is not found when its file is deleted after the frame looked and before the page read it', async () => {
    // The frame's probe finds the agent; the page's own read, a moment later, does not.
    let reads = 0;
    bureau(() => {
      reads += 1;
      if (reads === 1) return readyAgent();
      throw faults.notFound('researcher');
    });
    landAt('/agents/researcher/edit');
    const { container } = mountOutlet();

    await waitFor(() => expect(frameOf(container).dataset['state']).toBe('not-found'));
    expect(reads).toBe(3);
    // Not the load-failed alert: the page never said the server did not answer.
    expect(container.textContent).not.toContain(AGENT_EDITOR_COPY.loadFailed.title);
    expect(container.querySelector('form')).toBeNull();
  });

  test('shows the load-failed alert with Retry when the page’s read fails for another reason, and is not found when Retry finds the agent gone', async () => {
    let reads = 0;
    bureau(() => {
      reads += 1;
      if (reads === 1) return readyAgent();
      if (reads === 2) throw new StubFault('Unavailable', 503, 'The Bureau did not answer.');
      throw faults.notFound('researcher');
    });
    landAt('/agents/researcher/edit');
    const { container, findByText, getByRole } = mountOutlet();

    expect(await findByText(AGENT_EDITOR_COPY.loadFailed.title)).not.toBeNull();
    expect(frameOf(container).dataset['state']).toBe('ready');
    await fireEvent.click(getByRole('button', { name: RETRY_LABEL }));
    await waitFor(() => expect(frameOf(container).dataset['state']).toBe('not-found'));
    expect(container.textContent).not.toContain(AGENT_EDITOR_COPY.loadFailed.title);
  });

  test('shows the load-failed alert with Retry when the page’s read finds nothing but the frame’s second look finds the file again', async () => {
    // Deleted and written back between the reads: the probe finds it, the page's read does not,
    // and the frame's second look finds it again; Retry then reads it.
    let reads = 0;
    bureau(() => {
      reads += 1;
      if (reads === 2) throw faults.notFound('researcher');
      return readyAgent();
    });
    landAt('/agents/researcher/edit');
    const { container, findByText, getByRole, findByRole } = mountOutlet();

    expect(await findByText(AGENT_EDITOR_COPY.loadFailed.title)).not.toBeNull();
    expect(reads).toBe(3);
    expect(frameOf(container).dataset['state']).toBe('ready');
    await fireEvent.click(getByRole('button', { name: RETRY_LABEL }));
    expect(await findByRole('heading', { level: 1, name: 'Edit Researcher' })).not.toBeNull();
    await waitFor(() => expect(container.querySelector('[data-editor="ready"]')).not.toBeNull());
    expect(container.textContent).not.toContain(AGENT_EDITOR_COPY.loadFailed.title);
  });

  test('is failing, not not found, when the Bureau breaks', async () => {
    stub = installBureauStub({});
    landAt('/agents/researcher/edit');
    const { container, findByRole } = mountOutlet();

    expect(
      await findByRole('heading', { level: 1, name: VIEW_COPY['agent-editor'].error.title }),
    ).not.toBeNull();
    expect(frameOf(container).dataset['state']).toBe('error');
  });
});

describe('a file deleted on disk while the editor is open', () => {
  test('turns a save into the not-found state, and writes nothing', async () => {
    const calls = bureau(() => readyAgent());
    landAt('/agents/researcher/edit');
    const { container, findByRole } = mountOutlet();
    await findByRole('heading', { level: 1, name: 'Edit Researcher' });
    const form = await findByRole('form', { name: AGENT_EDITOR_COPY.formLabel });
    const save = within(form).getByRole('button', { name: AGENT_EDITOR_COPY.saveAction });

    // The file is gone: the write says so, and so does every read after it.
    calls.on('bureau.agents.definitions.update', () => {
      throw faults.notFound('researcher');
    });
    calls.on('bureau.agents.definitions.get', () => {
      throw faults.notFound('researcher');
    });
    await fireEvent.click(save);

    expect(await findByRole('heading', { level: 1, name: NOT_FOUND?.title ?? '' })).not.toBeNull();
    await waitFor(() => expect(frameOf(container).dataset['state']).toBe('not-found'));
    expect(container.querySelector('form')).toBeNull();
    expect(router.pathname).toBe('/agents/researcher/edit');
  });

  test('turns a delete into the not-found state as well', async () => {
    const calls = bureau(() => readyAgent());
    landAt('/agents/researcher/edit');
    const { container, findByRole } = mountOutlet();
    await findByRole('heading', { level: 1, name: 'Edit Researcher' });
    const form = await findByRole('form', { name: AGENT_EDITOR_COPY.formLabel });
    const deleteAction = within(form).getByRole('button', {
      name: AGENT_EDITOR_COPY.deleteAction,
    });

    calls.on('bureau.agents.definitions.delete', () => {
      throw faults.notFound('researcher');
    });
    calls.on('bureau.agents.definitions.get', () => {
      throw faults.notFound('researcher');
    });
    await fireEvent.click(deleteAction);
    const dialog = await findByRole('dialog', {
      name: AGENT_PAGE_COPY.settings.deleteDialog.title('Researcher'),
    });
    await fireEvent.input(
      within(dialog).getByLabelText(AGENT_PAGE_COPY.settings.deleteDialog.typeLabel('researcher')),
      { target: { value: 'researcher' } },
    );
    await fireEvent.click(
      within(dialog).getByRole('button', { name: AGENT_PAGE_COPY.settings.deleteDialog.confirm }),
    );

    expect(await findByRole('heading', { level: 1, name: NOT_FOUND?.title ?? '' })).not.toBeNull();
    expect(frameOf(container).dataset['state']).toBe('not-found');
  });
});
