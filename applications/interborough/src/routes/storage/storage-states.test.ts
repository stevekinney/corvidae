/**
 * The Storage page's slower and rarer states: a page of keys that fails to load, a read the person
 * stops (the table's and a key's), a key too long to show in a line, a rewritten value that is not
 * text, the storage details when the host does not say where it keeps its state, and the
 * Settings link that opens from them. Each is a state the page owns and words itself.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { flushSync } from 'svelte';

import { STORAGE_COPY } from '../../app/copy.ts';
import ToastHost from '../../app/toast-host.svelte';
import { router } from '../../lib/router.svelte.ts';
import { LONG_KEY_CHARACTERS } from './storage-groups.ts';
import StorageRouteHarness from './storage-route-test-harness.test-harness.svelte';
import { serveStorage } from './storage-server.test-support.ts';

let server: ReturnType<typeof serveStorage> | undefined;

beforeEach(() => {
  render(ToastHost);
});

afterEach(() => {
  jest.useRealTimers();
  cleanup();
  server?.restore();
  server = undefined;
  globalThis.IntersectionObserver = originalObserver;
});

const originalObserver = globalThis.IntersectionObserver;

function open(options: Partial<Parameters<typeof serveStorage>[0]> = {}, watchInterval?: number) {
  server = serveStorage({ keys: { 'app:notes': 'plain text note' }, ...options });
  return render(StorageRouteHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost:7233' }),
      ...(watchInterval === undefined ? {} : { watchInterval }),
    },
  } as never);
}

type View = ReturnType<typeof open>;

const rowOf = (view: View, key: string): HTMLElement => {
  const row = [...view.container.querySelectorAll<HTMLElement>('[data-cinder-row-id]')].find(
    (candidate) => candidate.getAttribute('data-cinder-row-id') === key,
  );
  if (!row) throw new Error(`No row for ${key}`);
  return row;
};

async function select(view: View, key: string): Promise<HTMLElement> {
  await waitFor(() => expect(rowOf(view, key)).toBeDefined());
  await fireEvent.click(rowOf(view, key));
  return view.findByTestId('storage-key');
}

/** Runs the page with every timer faked, once its lazy page is loaded, so a slow read needs no real time. */
async function openSlow(options: Partial<Parameters<typeof serveStorage>[0]>) {
  jest.useFakeTimers();
  const view = open(options);
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  flushSync();
  return view;
}

const advance = (milliseconds: number): void => {
  jest.advanceTimersByTime(milliseconds);
  flushSync();
};

describe('a page of keys that fails to load', () => {
  const many = Object.fromEntries(
    Array.from({ length: 130 }, (_, index) => [`bulk:${String(index).padStart(4, '0')}`, 'v']),
  );

  test('says so under the table, and Load more reads it again', async () => {
    const observers: { callback: IntersectionObserverCallback }[] = [];
    globalThis.IntersectionObserver = class {
      readonly callback: IntersectionObserverCallback;
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
        observers.push(this);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    } as unknown as typeof IntersectionObserver;
    const view = open({ keys: many });
    await view.findByRole('table');
    await waitFor(() =>
      expect(view.getByTestId('storage-count').textContent?.trim()).toBe(
        'Showing 100 of 130 keys. Scroll to load more.',
      ),
    );
    if (server) server.control.pageStatus = 500;
    const reachEnd = () =>
      observers.forEach((observer) =>
        observer.callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          observer as unknown as IntersectionObserver,
        ),
      );
    reachEnd();

    const retry = await view.findByRole('button', { name: STORAGE_COPY.loadMore.retry });
    expect(view.queryByTestId('storage-count')).toBeNull();
    if (server) server.control.pageStatus = undefined;
    await fireEvent.click(retry);

    await waitFor(() =>
      expect(view.getByTestId('storage-count').textContent?.trim()).toBe(
        'Showing 130 of 130 keys.',
      ),
    );
  });
});

describe('a read the person stops', () => {
  test('the table says nothing was changed, and Try again reads the keys again', async () => {
    const view = await openSlow({ holdScan: true });
    advance(10_500);
    await fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
    flushSync();
    expect(view.getByText(STORAGE_COPY.stopped.title)).not.toBeNull();
    expect(view.getByText(STORAGE_COPY.stopped.description)).not.toBeNull();
    expect(view.queryByTestId('storage-loading')).toBeNull();

    if (server) server.control.holdScan = false;
    jest.useRealTimers();
    await fireEvent.click(view.getByRole('button', { name: STORAGE_COPY.stopped.tryAgain }));
    expect(await view.findByRole('table')).not.toBeNull();
  });

  test('the key pane says it stopped, and Try again reads the value again', async () => {
    const view = open();
    await view.findByRole('table');
    if (server) server.control.holdValues = true;
    jest.useFakeTimers();
    const pane = within(await select(view, 'app:notes'));
    advance(10_500);
    await fireEvent.click(await pane.findByRole('button', { name: 'Cancel' }));
    flushSync();
    expect(pane.getByTestId('storage-key-stopped').textContent).toBe(
      STORAGE_COPY.detail.valueStopped,
    );

    if (server) server.control.holdValues = false;
    jest.useRealTimers();
    await fireEvent.click(pane.getByRole('button', { name: STORAGE_COPY.detail.valueRetry }));
    expect(await pane.findByText('plain text note')).not.toBeNull();
  });
});

describe('a key too long for a line', () => {
  test('is counted in characters and copied whole', async () => {
    const key = `long:${'k'.repeat(LONG_KEY_CHARACTERS + 20)}`;
    const view = open({ keys: { [key]: 'v' } });
    await view.findByRole('table');
    const pane = within(await select(view, key));
    expect(pane.getByText(STORAGE_COPY.detail.characters(key.length))).not.toBeNull();
    expect(pane.getByTestId('storage-key-name').textContent).toBe(key);
  });
});

describe('a rewritten value that is not text', () => {
  test('Show new value closes the editor, as there is no text to put in it', async () => {
    const view = open({}, 25);
    const pane = within(await select(view, 'app:notes'));
    await waitFor(() =>
      expect(pane.getByRole('button', { name: STORAGE_COPY.detail.edit })).not.toBeNull(),
    );
    await fireEvent.click(pane.getByRole('button', { name: STORAGE_COPY.detail.edit }));
    await fireEvent.input(pane.getByRole('textbox', { name: STORAGE_COPY.detail.editLabel }), {
      target: { value: 'mine' },
    });
    server?.store.set('app:notes', new Uint8Array([0xff, 0xfe, 0x00, 0x80]));
    const alert = await pane.findByTestId('storage-rewritten');

    await fireEvent.click(
      within(alert.closest('.cinder-alert') as HTMLElement).getByRole('button', {
        name: 'Show new value',
      }),
    );

    await waitFor(() =>
      expect(
        pane.queryByRole('textbox', { name: STORAGE_COPY.detail.editLabel })?.outerHTML ?? null,
      ).toBeNull(),
    );
    expect(pane.queryByTestId('storage-rewritten')).toBeNull();
  });
});

describe('the storage details when the host does not say where it is', () => {
  test('shows dashes for the location, and its Settings link opens the retention settings', async () => {
    const view = open({ hostPaths: false });
    await fireEvent.click(await view.findByRole('button', { name: 'Storage details' }));
    const details = within(await view.findByTestId('storage-details'));
    await waitFor(() =>
      expect(details.getAllByRole('definition')[1]?.textContent?.trim()).toBe('—'),
    );

    const link = details.getByRole('link', { name: 'Settings › Data and retention' });
    expect(await fireEvent.click(link, { ctrlKey: true })).toBe(true);
    expect(await fireEvent.click(link)).toBe(false);
    await waitFor(() => expect(router.pathname).toBe('/settings/data-and-retention'));
  });
});

describe('the search form', () => {
  test('is never submitted to the page', async () => {
    const view = open();
    await view.findByRole('table');
    const form = view.container.querySelector('form') as HTMLFormElement;
    expect(await fireEvent.submit(form)).toBe(false);
  });
});

describe('a group chosen before the list moved on', () => {
  test('stays in the Group select', async () => {
    const view = open({ keys: { 'app:notes': 'a', 'cache:rates': 'b' } });
    await view.findByRole('table');
    const select = (await view.findByLabelText('Group')) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBeGreaterThan(2));
    const cache = [...select.options].find((option) => option.value.startsWith('cache'));
    if (cache === undefined) throw new Error('no cache group');
    await fireEvent.change(select, { target: { value: cache.value } });
    server?.store.delete('cache:rates');
    const { focusManager } = await import('@tanstack/svelte-query');
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await waitFor(() => expect(select.value).toBe(cache.value));
  });
});
