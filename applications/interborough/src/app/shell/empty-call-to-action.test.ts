/**
 * An empty view offers a way to create its first item. The link only changes the query string, so
 * the frame must stop calling the view empty at that location, or the wizard and the drawer never
 * mount and an empty install cannot make its first run or schedule.
 */
import { HttpClient } from '@lostgradient/weft';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import { VIEW_COPY } from '../copy.ts';
import Harness from './route-outlet.test-harness.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

/** An engine with nothing in it: every list is empty. */
function stubEmptyEngine(): void {
  restore = installFetchImplementation(async (_input, init) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { id?: unknown }) : {};
    if (typeof init?.body === 'string') {
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { items: [], total: 0 } });
    }
    return Response.json({ items: [], total: 0 });
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
    label: 'Start a run',
    heading: { role: 'heading', name: 'Start workflow' },
  },
  {
    view: 'schedules',
    path: '/schedules',
    creating: '/schedules?create=1',
    label: 'Create a schedule',
    heading: { role: 'dialog', name: 'Create schedule' },
  },
] as const;

describe('an empty view’s call to action', () => {
  for (const flow of FLOWS) {
    test(`opens the ${flow.view} creation flow`, async () => {
      stubEmptyEngine();
      landAt(flow.path);
      const { container, findByRole } = mount();

      await fireEvent.click(await findByRole('link', { name: flow.label }));

      expect(await findByRole(flow.heading.role, { name: flow.heading.name })).not.toBeNull();
      const frame = container.querySelector(`.weft-view[data-view="${flow.view}"]`);
      expect(frame?.getAttribute('data-state')).toBe('ready');
    });

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
        const one = { items: [{ id: 'first-item' }], total: 1 };
        return typeof init?.body === 'string'
          ? Response.json({ jsonrpc: '2.0', id: body.id, result: one })
          : Response.json(one);
      });
      router.navigate(flow.path);
      await waitFor(() => {
        const frame = container.querySelector(`.weft-view[data-view="${flow.view}"]`);
        expect(frame?.getAttribute('data-state')).toBe('ready');
      });
    });
  }

  test('is the empty state’s own link, from the copy', () => {
    expect(VIEW_COPY.runs.empty?.action?.href).toBe('/runs?view=start');
    expect(VIEW_COPY.schedules.empty?.action?.href).toBe('/schedules?create=1');
  });
});
