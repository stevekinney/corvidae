/**
 * The agent editor inside its view frame, through the route outlet: the states the frame owns
 * (not found, for an agent that is missing, one defined in code, or one whose file was deleted
 * while the page was open) and the editor's own routes in the route table.
 */
import { HttpClient } from '@lostgradient/weft';
import { fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { AGENT_EDITOR_COPY, VIEW_COPY } from '../../app/copy.ts';
import RouteOutletHarness from '../../app/shell/route-outlet.test-harness.svelte';
import {
  catalogFixture,
  faults,
  installBureauStub,
  readyAgent,
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
    expect(frameOf(container).dataset['state']).toBe('ready');
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
    const { container, findByRole, getByRole } = mountOutlet();
    await findByRole('heading', { level: 1, name: 'Edit Researcher' });

    // The file is gone: the write says so, and so does every read after it.
    calls.on('bureau.agents.definitions.update', () => {
      throw faults.notFound('researcher');
    });
    calls.on('bureau.agents.definitions.get', () => {
      throw faults.notFound('researcher');
    });
    await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.saveAction }));

    expect(await findByRole('heading', { level: 1, name: NOT_FOUND?.title ?? '' })).not.toBeNull();
    await waitFor(() => expect(frameOf(container).dataset['state']).toBe('not-found'));
    expect(container.querySelector('form')).toBeNull();
    expect(router.pathname).toBe('/agents/researcher/edit');
  });

  test('turns a delete into the not-found state as well', async () => {
    const calls = bureau(() => readyAgent());
    landAt('/agents/researcher/edit');
    const { container, findByRole, getByRole } = mountOutlet();
    await findByRole('heading', { level: 1, name: 'Edit Researcher' });

    calls.on('bureau.agents.definitions.delete', () => {
      throw faults.notFound('researcher');
    });
    calls.on('bureau.agents.definitions.get', () => {
      throw faults.notFound('researcher');
    });
    await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.deleteAction }));
    const dialog = await findByRole('dialog', { name: AGENT_EDITOR_COPY.deleteDialog.title });
    await fireEvent.click(
      within(dialog).getByRole('button', { name: AGENT_EDITOR_COPY.deleteDialog.confirm }),
    );

    expect(await findByRole('heading', { level: 1, name: NOT_FOUND?.title ?? '' })).not.toBeNull();
    expect(frameOf(container).dataset['state']).toBe('not-found');
  });
});
