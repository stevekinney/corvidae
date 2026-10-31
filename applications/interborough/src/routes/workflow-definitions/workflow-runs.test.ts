/**
 * `/workflows/:workflow/runs`: the runs list of `/runs`, filtered by the type, with each row linking
 * to the run. The type is the address's, so the list offers no type filter of its own, and a
 * filter it does offer keeps the page on this address.
 */
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import {
  codeDefinition,
  emptyWorld,
  installWorkflowWorld,
  runFixture,
  type WorkflowStub,
} from '../../lib/workflow-world.test-support.ts';
import Harness from './area-harness.test-harness.svelte';

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

function open(path: string) {
  stub = installWorkflowWorld(
    emptyWorld({
      definitions: [codeDefinition('order-processing'), codeDefinition('other')],
      runs: [
        runFixture('run-one', 'order-processing'),
        runFixture('run-two', 'order-processing', { status: 'failed' }),
        runFixture('run-elsewhere', 'other'),
      ],
    }),
  );
  router.navigate(path, { replace: true });
  return render(Harness, { props: { client: stub.client, scopes: AUTHORIZATION_SCOPES } } as never);
}

describe('the runs of a type', () => {
  test('are the runs list filtered by the type, and each row links to its run', async () => {
    const { container } = open('/workflows/order-processing/runs');
    await waitFor(() => expect(container.querySelectorAll('tbody tr').length).toBe(2));

    expect(stub?.callsTo('GET /workflows').at(-1)?.params).toMatchObject({
      type: 'order-processing',
    });
    const links = [...container.querySelectorAll<HTMLAnchorElement>('tbody a')].map((link) =>
      link.getAttribute('href'),
    );
    expect(links).toEqual([
      '/workflows/order-processing/runs/run-one',
      '/workflows/order-processing/runs/run-two',
    ]);
    expect(container.textContent).not.toContain('run-elsewhere');
    expect(container.querySelector('[data-view="workflows"]')?.getAttribute('data-state')).toBe(
      'ready',
    );
  });

  test('say whose runs they are, and link back to the type', async () => {
    const { container } = open('/workflows/order-processing/runs');
    await waitFor(() => expect(container.querySelectorAll('tbody tr').length).toBe(2));
    const heading = container.querySelector('h1');
    expect(heading?.textContent).toContain('order-processing');
    expect(container.querySelector('a[href="/workflows/order-processing"]')).not.toBeNull();
  });

  test('offer no filter by type, because the address names it', async () => {
    const { container } = open('/workflows/order-processing/runs');
    await waitFor(() => expect(container.querySelectorAll('tbody tr').length).toBe(2));
    expect(container.querySelector('#weft-workflow-filter-type')).toBeNull();
  });

  test('keep a status filter on this address, and on this type', async () => {
    const { container, getByRole } = open('/workflows/order-processing/runs');
    await waitFor(() => expect(container.querySelectorAll('tbody tr').length).toBe(2));
    getByRole('button', { name: /failed/i }).click();
    await waitFor(() => expect(router.pathname).toBe('/workflows/order-processing/runs'));
    expect(router.current.search.get('status')).toBe('failed');
    await waitFor(() =>
      expect(stub?.callsTo('GET /workflows').at(-1)?.params).toMatchObject({
        type: 'order-processing',
        status: 'failed',
      }),
    );
  });

  test('ignore a type in the query string, because the address’s type is the one', async () => {
    const { container } = open('/workflows/order-processing/runs?type=other');
    await waitFor(() => expect(container.querySelectorAll('tbody tr').length).toBe(2));
    expect(stub?.callsTo('GET /workflows').at(-1)?.params).toMatchObject({
      type: 'order-processing',
    });
  });
});

describe('the heading of the runs of a type', () => {
  test('links to the type, and leaves a modified click to the browser', async () => {
    const { container } = open('/workflows/order-processing/runs');
    await waitFor(() => expect(container.querySelectorAll('tbody tr').length).toBe(2));
    const link = container.querySelector<HTMLAnchorElement>('h1 a');
    expect(link?.getAttribute('href')).toBe('/workflows/order-processing');

    link?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }),
    );
    expect(router.pathname).toBe('/workflows/order-processing/runs');
    link?.click();
    expect(router.pathname).toBe('/workflows/order-processing');
  });

  test('offers no way to start or aggregate runs of every type, which this list is not', async () => {
    const { container } = open('/workflows/order-processing/runs');
    await waitFor(() => expect(container.querySelectorAll('tbody tr').length).toBe(2));
    expect(container.textContent).not.toContain('Start workflow');
    expect(container.textContent).not.toContain('Aggregate view');
  });

  test('says no run matches a filter, and clears it without leaving the type', async () => {
    const { container, findByRole } = open('/workflows/order-processing/runs?status=cancelled');
    const clear = await findByRole('button', { name: 'Clear filters' });
    clear.click();
    await waitFor(() => expect(router.current.search.get('status')).toBeNull());
    expect(router.pathname).toBe('/workflows/order-processing/runs');
    await waitFor(() => expect(container.querySelectorAll('tbody tr').length).toBe(2));
  });
});
