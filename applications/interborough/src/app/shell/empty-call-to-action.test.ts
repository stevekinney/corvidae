/**
 * An empty view offers a way to create its first item. The link only changes the query string, so
 * the frame must stop calling the view empty at that location, or the picker and the page never
 * mount and an empty install cannot make its first run or schedule.
 */
import { HttpClient } from '@lostgradient/weft';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { taskFixture } from '../../lib/bureau-fixtures.test-support.ts';
import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import { VIEW_COPY, WORKFLOW_COPY } from '../copy.ts';
import Harness from './route-outlet.test-harness.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

/**
 * What every list answers when it is empty: the engine's (`items`) and the Bureau's tasks and
 * goals, which the runs view asks. One body serves them all, because each reads only its own field.
 */
const EMPTY = { items: [], total: 0, tasks: [], nextPageToken: null, goals: [], nextOffset: null };

/** The same, with one item in each list. */
const ONE = {
  items: [{ id: 'first-item' }],
  total: 1,
  tasks: [taskFixture({ id: 'first-item' })],
  nextPageToken: null,
  goals: [],
  nextOffset: null,
};

/** An engine and a Bureau with nothing in them: every list is empty. */
function stubEmptyEngine(): void {
  restore = installFetchImplementation(async (_input, init) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { id?: unknown }) : {};
    if (typeof init?.body === 'string') {
      return Response.json({ jsonrpc: '2.0', id: body.id, result: EMPTY });
    }
    return Response.json(EMPTY);
  });
}

function landAt(path: string): void {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

function mount() {
  return render(Harness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  });
}

const FLOWS = [
  {
    view: 'runs',
    path: '/runs',
    creating: '/runs?view=start',
    // The empty runs view points to a chat, which a caller without `workflows:read` can start; the
    // engine's start flow is reached by its address.
    label: null,
    heading: { role: 'heading', name: WORKFLOW_COPY.runPicker.title },
  },
  {
    view: 'schedules',
    path: '/schedules',
    creating: '/schedules/new',
    label: 'Create a schedule',
    heading: { role: 'heading', name: 'New schedule' },
  },
] as const;

describe('an empty view’s call to action', () => {
  for (const flow of FLOWS) {
    const label = flow.label;
    if (label !== null) {
      test(`opens the ${flow.view} creation flow`, async () => {
        stubEmptyEngine();
        landAt(flow.path);
        const { container, findByRole } = mount();

        await fireEvent.click(await findByRole('link', { name: label }));

        expect(await findByRole(flow.heading.role, { name: flow.heading.name })).not.toBeNull();
        const frame = container.querySelector(`.weft-view[data-view="${flow.view}"]`);
        expect(frame?.getAttribute('data-state')).toBe('ready');
      });
    }

    test(`shows the creation flow when ${flow.creating} is opened directly`, async () => {
      stubEmptyEngine();
      landAt(flow.creating);
      const { container, findByRole } = mount();
      expect(await findByRole(flow.heading.role, { name: flow.heading.name })).not.toBeNull();
      const frame = container.querySelector(`.weft-view[data-view="${flow.view}"]`);
      expect(frame?.getAttribute('data-state')).toBe('ready');
    });

    test(`asks again when the ${flow.view} creation flow is left, in case it made the first item`, async () => {
      stubEmptyEngine();
      landAt(flow.creating);
      const { container, findByRole } = mount();
      await findByRole(flow.heading.role, { name: flow.heading.name });

      // Leave the flow, as saving does, with the engine now holding an item.
      restore?.();
      restore = installFetchImplementation(async (_input, init) => {
        const body =
          typeof init?.body === 'string' ? (JSON.parse(init.body) as { id?: unknown }) : {};
        return typeof init?.body === 'string'
          ? Response.json({ jsonrpc: '2.0', id: body.id, result: ONE })
          : Response.json(ONE);
      });
      router.navigate(flow.path);
      await waitFor(() => {
        const frame = container.querySelector(`.weft-view[data-view="${flow.view}"]`);
        expect(frame?.getAttribute('data-state')).toBe('ready');
      });
    });
  }

  test('is the empty state’s own link, from the copy', () => {
    expect(VIEW_COPY.runs.empty?.action).toEqual({ label: 'Start a chat', href: '/chats/new' });
    expect(VIEW_COPY.schedules.empty?.action?.href).toBe('/schedules/new');
  });

  test('of the empty runs view is a chat, which a caller without the engine’s scope can start', async () => {
    stubEmptyEngine();
    landAt('/runs');
    const { findByRole } = render(Harness, {
      props: { client: new HttpClient({ baseUrl: 'http://localhost/api' }), scopes: [] },
    });

    const link = await findByRole('link', { name: 'Start a chat' });

    expect(link.getAttribute('href')).toBe('/chats/new');
  });
});
