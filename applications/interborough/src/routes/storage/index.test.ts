/**
 * Component tests for the Storage page: the `storage:admin` gate, the key table with its group,
 * starts-with and range controls, the selected key's pane, per-key Edit and Delete with a
 * confirmation, the lock on a key the application manages, and the storage line with its popover.
 */
import { formatTimeOfDay } from '@lostgradient/cinder';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { HttpClient } from '@lostgradient/weft';
import { focusManager } from '@tanstack/svelte-query';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { STORAGE_COPY } from '../../app/copy.ts';
import ToastHost from '../../app/toast-host.svelte';
import StorageRouteHarness from './storage-route-test-harness.test-harness.svelte';
import { serveStorage } from './storage-server.test-support.ts';

const BUREAU = ['settings', 'skill:'];

let server: ReturnType<typeof serveStorage> | undefined;

beforeEach(() => {
  render(ToastHost);
});

afterEach(() => {
  cleanup();
  server?.restore();
  server = undefined;
});

const client = () => new HttpClient({ baseUrl: 'http://localhost:7233' });

const KEYS = {
  'app:config': '{"theme":"dark","retries":3,"nested":{"a":1}}',
  'app:notes': 'plain text note',
  'cache:rates': '{"usd":1}',
  'skill:summarize': '{"name":"summarize"}',
  'wf:order-1': '{"state":"running"}',
  settings: '{"locked":false}',
};

/** Opens the page over `keys` and waits for the table. */
async function open(
  options: Partial<Parameters<typeof serveStorage>[0]> = {},
  scopes?: readonly string[],
  watchInterval?: number,
) {
  server = serveStorage({ keys: KEYS, bureauPrefixes: BUREAU, ...options });
  const view = render(StorageRouteHarness, {
    props: {
      client: client(),
      ...(scopes === undefined ? {} : { scopes }),
      ...(watchInterval === undefined ? {} : { watchInterval }),
    },
  } as never);
  return view;
}

/** What `open` hands back: the rendered page and its queries. */
type View = Awaited<ReturnType<typeof open>>;

/** The table row of `key`: a row is named by the whole key, though it may show the key shortened. */
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

/** The table's footer once it says `text`. */
const footerSays = (view: View, text: string) =>
  waitFor(() => expect(view.getByTestId('storage-count').textContent?.trim()).toBe(text));

describe('the gate', () => {
  test('a principal without storage:admin sees a lock state naming the scope, and no table', async () => {
    const view = await open({}, []);
    expect(view.getByText('Storage access requires storage:admin')).not.toBeNull();
    expect(view.getByText('Requires storage:admin')).not.toBeNull();
    expect(view.queryByRole('table')).toBeNull();
    // The heading's line still says where the installation runs, and the details open: they come
    // from the host, not from the storage the scope guards.
    expect(view.getByRole('button', { name: 'Storage details' })).not.toBeNull();
    expect(server?.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });
});

describe('the key table', () => {
  test('lists every key with its group and size, and says how many it holds', async () => {
    const view = await open();
    await view.findByRole('table');
    await footerSays(view, 'Showing 6 of 6 keys.');
    const row = rowOf(view, 'app:config');
    expect(row.textContent).toContain('App data and memory');
    expect(row.textContent).toContain(`${new TextEncoder().encode(KEYS['app:config']).length} B`);
    expect(rowOf(view, 'settings').textContent).toContain(STORAGE_COPY.noGroup);
    expect(view.getAllByRole('columnheader').map((header) => header.textContent?.trim())).toEqual([
      'Key',
      'Group',
      'Size',
      expect.stringMatching(/^Updated \(.+\)$/),
    ]);
  });

  test('offers the groups in storage in plain words, and a chosen group reads only its keys', async () => {
    const view = await open();
    await view.findByRole('table');
    const groups = (await view.findByLabelText('Group')) as HTMLSelectElement;
    await waitFor(() =>
      expect([...groups.options].map((option) => option.textContent?.trim())).toEqual([
        'All groups',
        'App data and memory',
        'cache:',
        'skill:',
        'wf:',
      ]),
    );

    await fireEvent.change(groups, { target: { value: 'app:' } });

    await footerSays(view, 'Showing 2 of 2 keys.');
    expect(view.container.querySelector('[data-cinder-row-id="cache:rates"]')).toBeNull();
    const scans = server?.calls.filter(
      (call) => new URL(call.url, 'http://localhost').pathname === '/v1/storage',
    );
    expect(
      scans?.some(
        (call) => new URL(call.url, 'http://localhost').searchParams.get('prefix') === 'app:',
      ),
    ).toBe(true);
  });

  test('starts with is a prefix read, narrows as it is typed, and can be cleared from the empty state', async () => {
    const view = await open();
    await view.findByRole('table');
    const field = view.getByLabelText(STORAGE_COPY.searchLabel);

    await fireEvent.input(field, { target: { value: 'app:n' } });
    await footerSays(view, 'Showing 1 of 1 key.');
    expect(rowOf(view, 'app:notes')).toBeDefined();
    // The server does the narrowing: the request carries the typed text as its prefix.
    const prefixes = server?.calls
      .filter((call) => new URL(call.url, 'http://localhost').pathname === '/v1/storage')
      .map((call) => new URL(call.url, 'http://localhost').searchParams.get('prefix'));
    expect(prefixes).toContain('app:n');

    // Text that is no key's start, and a case that is not ignored: nothing here starts with it.
    await fireEvent.input(field, { target: { value: 'NOTES' } });
    await view.findByText(STORAGE_COPY.noMatches.title);
    await fireEvent.click(view.getByRole('button', { name: STORAGE_COPY.noMatches.clear }));
    await footerSays(view, 'Showing 6 of 6 keys.');
  });

  test('a group and text that part ways match no key, and one that extends the other reads the longer', async () => {
    const view = await open();
    await view.findByRole('table');
    const groups = (await view.findByLabelText('Group')) as HTMLSelectElement;
    await waitFor(() =>
      expect([...groups.options].map((option) => option.value)).toContain('app:'),
    );
    await fireEvent.change(groups, { target: { value: 'app:' } });
    const field = view.getByLabelText(STORAGE_COPY.searchLabel);

    await fireEvent.input(field, { target: { value: 'cache:' } });
    await view.findByText(STORAGE_COPY.noMatches.title);

    await fireEvent.input(field, { target: { value: 'app:c' } });
    await footerSays(view, 'Showing 1 of 1 key.');
    expect(rowOf(view, 'app:config')).toBeDefined();
  });

  test('an empty store says so, with nothing to clear', async () => {
    const view = await open({ keys: {} });
    await view.findByText(STORAGE_COPY.empty.title);
    expect(view.queryByRole('button', { name: STORAGE_COPY.noMatches.clear })).toBeNull();
  });

  test('a read that fails is an error with Try again, not an empty store', async () => {
    const view = await open({ scanStatus: 500 });
    await view.findByText(STORAGE_COPY.failed.title);
    expect(view.queryByText(STORAGE_COPY.empty.title)).toBeNull();
    expect(view.getByRole('button', { name: 'Try again' })).not.toBeNull();
  });

  test('marks no key with a lock in the table, which has no Managed column, and shows no Load more button', async () => {
    const view = await open();
    await view.findByRole('table');
    await footerSays(view, 'Showing 6 of 6 keys.');
    expect(view.queryByText(STORAGE_COPY.managedBadge)).toBeNull();
    expect(view.queryByRole('button', { name: 'Load more' })).toBeNull();
  });
});

describe('scrolling to the end of the table', () => {
  const many = Object.fromEntries(
    Array.from({ length: 130 }, (_, index) => [`bulk:${String(index).padStart(4, '0')}`, 'v']),
  );
  const originalObserver = globalThis.IntersectionObserver;
  let observers: { callback: IntersectionObserverCallback }[] = [];

  beforeEach(() => {
    observers = [];
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
  });

  afterEach(() => {
    globalThis.IntersectionObserver = originalObserver;
  });

  /** Tells every observer the end of the table is in view. */
  const reachEnd = () =>
    observers.forEach((observer) =>
      observer.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        observer as unknown as IntersectionObserver,
      ),
    );

  test('reads on from the last key, and says how many are loaded of how many there are', async () => {
    const view = await open({ keys: many });
    await view.findByRole('table');
    await footerSays(view, 'Showing 100 of 130 keys. Scroll to load more.');
    const before = scanCount();

    reachEnd();

    await footerSays(view, 'Showing 130 of 130 keys.');
    expect(scanCount()).toBe(before + 1);
    const continued = server?.calls
      .filter((call) => new URL(call.url, 'http://localhost').pathname === '/v1/storage')
      .map((call) => new URL(call.url, 'http://localhost').searchParams.get('gt'));
    expect(continued).toContain('bulk:0099');
  });
});

describe('Range', () => {
  const dated = {
    'audit:2026-10-31T20:00:00Z': 'a',
    'audit:2026-11-01T22:12:31Z': 'b',
    'audit:2026-11-02T15:00:02Z': 'c',
    'audit:2026-11-02T16:33:08Z': 'd',
    'audit:2026-11-03T09:00:00Z': 'e',
    'goal:seeded-goal': 'f',
  };

  /** Switches to Range and returns its two fields. */
  async function openRange(view: View) {
    await view.findByRole('table');
    await fireEvent.click(view.getByRole('radio', { name: STORAGE_COPY.modeRange }));
    const range = view.getByRole('group', { name: STORAGE_COPY.range.label });
    return {
      start: within(range).getByLabelText(STORAGE_COPY.range.startLabel),
      end: within(range).getByLabelText(STORAGE_COPY.range.endLabel),
    };
  }

  test('replaces the search field with two key fields, and lists the keys from one to the other, both ends included', async () => {
    const view = await open({ keys: dated });
    const { start, end } = await openRange(view);
    expect(view.queryByLabelText(STORAGE_COPY.searchLabel)).toBeNull();
    expect(view.queryByRole('button', { name: 'Apply' })).toBeNull();

    await fireEvent.input(start, { target: { value: 'audit:2026-11-01' } });
    await fireEvent.input(end, { target: { value: 'audit:2026-11-02' } });

    // Every key that starts with the last one is in the range, so the 16:33 key is.
    await footerSays(view, 'Showing 3 keys.');
    expect(
      [...view.container.querySelectorAll('[data-cinder-row-id]')].map((row) =>
        row.getAttribute('data-cinder-row-id'),
      ),
    ).toEqual([
      'audit:2026-11-01T22:12:31Z',
      'audit:2026-11-02T15:00:02Z',
      'audit:2026-11-02T16:33:08Z',
    ]);
  });

  test('a chosen group narrows the range to the group’s keys', async () => {
    const view = await open({ keys: dated });
    const groups = (await view.findByLabelText('Group')) as HTMLSelectElement;
    await waitFor(() =>
      expect([...groups.options].map((option) => option.value)).toContain('goal:'),
    );
    const { start, end } = await openRange(view);

    await fireEvent.change(groups, { target: { value: 'goal:' } });
    await fireEvent.input(start, { target: { value: 'audit:' } });
    await fireEvent.input(end, { target: { value: 'zzz' } });

    await footerSays(view, 'Showing 1 key.');
    expect(rowOf(view, 'goal:seeded-goal')).toBeDefined();
  });

  test('an end that sorts before the start is marked on the End field, and the table keeps the last good result and says so', async () => {
    const view = await open({ keys: dated });
    const { start, end } = await openRange(view);
    await fireEvent.input(start, { target: { value: 'audit:2026-11-01' } });
    await fireEvent.input(end, { target: { value: 'audit:2026-11-02' } });
    await footerSays(view, 'Showing 3 keys.');

    await fireEvent.input(end, { target: { value: 'audit:2026-10-31' } });

    await waitFor(() => expect(end.getAttribute('aria-invalid')).toBe('true'));
    expect(start.getAttribute('aria-invalid')).toBeNull();
    const problem = view.getByText(STORAGE_COPY.range.reversed);
    expect(problem.getAttribute('role')).toBe('alert');
    expect(end.getAttribute('aria-describedby')).toBe(problem.id);
    expect(view.getByTestId('storage-last-result').textContent).toBe(
      'Showing the last result: 3 keys from audit:2026-11-01 to audit:2026-11-02.',
    );
    // Nothing was read for the reversed range: the three keys are still the table.
    expect(view.container.querySelectorAll('[data-cinder-row-id]')).toHaveLength(3);

    await fireEvent.input(end, { target: { value: 'audit:2026-11-03' } });
    await footerSays(view, 'Showing 4 keys.');
    expect(view.queryByText(STORAGE_COPY.range.reversed)).toBeNull();
    expect(end.getAttribute('aria-invalid')).toBeNull();
    expect(view.queryByTestId('storage-last-result')).toBeNull();
  });

  test('says when no key falls in the range', async () => {
    const view = await open({ keys: dated });
    const { start, end } = await openRange(view);
    await fireEvent.input(start, { target: { value: 'audit:2027' } });
    await fireEvent.input(end, { target: { value: 'audit:2028' } });
    await view.findByText(STORAGE_COPY.noKeysInRange.title);
  });
});

describe('a read that fails', () => {
  test('can be tried again, and then lists the keys', async () => {
    const view = await open({ scanStatus: 500 });
    await view.findByText(STORAGE_COPY.failed.title);
    if (server) server.control.scanStatus = undefined;

    await fireEvent.click(view.getByRole('button', { name: 'Try again' }));

    await view.findByRole('table');
    expect(view.queryByText(STORAGE_COPY.failed.title)).toBeNull();
  });
});

describe('the selected key', () => {
  test('shows its group, size and name, and the value as fields with a switch to the JSON itself', async () => {
    const view = await open();
    const pane = within(await select(view, 'app:config'));
    expect(pane.getByTestId('storage-key-name').textContent).toBe('app:config');
    // One line over the key: its group, its size, and when it was written (this stub records none).
    expect(pane.getByTestId('storage-key-summary').textContent?.trim()).toBe(
      `App data and memory · ${new TextEncoder().encode(KEYS['app:config']).length} B`,
    );
    await waitFor(() => expect(pane.getByText('dark')).not.toBeNull());
    expect(pane.getByText('Theme')).not.toBeNull();

    await fireEvent.click(pane.getByRole('radio', { name: STORAGE_COPY.detail.jsonSwitch }));

    await waitFor(() =>
      expect(
        pane
          .getByRole('radio', { name: STORAGE_COPY.detail.jsonSwitch })
          .getAttribute('aria-checked'),
      ).toBe('true'),
    );
    expect(view.getByTestId('storage-key').textContent).toContain('retries: 3');
    expect(pane.queryByText('Theme')).toBeNull();
  });

  test('shows a value that is not JSON as text under its size, with no switch and a note saying why', async () => {
    const view = await open();
    const pane = within(await select(view, 'app:notes'));
    await waitFor(() => expect(pane.getByText('plain text note')).not.toBeNull());

    expect(pane.getByText('Value · text, 15 B')).not.toBeNull();
    expect(pane.queryByRole('radio', { name: STORAGE_COPY.detail.jsonSwitch })).toBeNull();
    expect(pane.getByTestId('storage-text-note').textContent).toBe(
      'This value isn’t JSON, so there is no Fields or JSON switch.',
    );
  });

  test('shows a very large value as its first 64 KB, and Copy value still copies all of it', async () => {
    const line = '2026-11-02 09:00:02 server started\n';
    const log = line.repeat(70_000);
    const view = await open({ keys: { ...KEYS, 'log:server': log } });
    const pane = within(await select(view, 'log:server'));
    await pane.findByText('Value · text, 2.3 MB');

    expect(pane.getByTestId('storage-text-note').textContent).toBe(
      'Showing the first 64 KB. Copy value copies all 2.3 MB. This value isn’t JSON, so there is no Fields or JSON switch.',
    );
    expect(pane.queryByRole('radio', { name: STORAGE_COPY.detail.jsonSwitch })).toBeNull();
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          written.push(text);
        },
      },
    });
    await fireEvent.click(pane.getByRole('button', { name: STORAGE_COPY.detail.copyValue }));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]).toBe(log);
  });

  test('says a binary value is not text, and offers no Edit', async () => {
    const view = await open({ keys: { 'app:blob': new Uint8Array([0xff, 0xfe, 0x00]) } });
    const pane = within(await select(view, 'app:blob'));
    expect(pane.getByText(STORAGE_COPY.detail.binaryNote)).not.toBeNull();
    expect(pane.queryByRole('button', { name: STORAGE_COPY.detail.edit })).toBeNull();
    expect(pane.getByRole('button', { name: STORAGE_COPY.detail.moreActions })).not.toBeNull();
  });
});

describe('a key the application manages', () => {
  for (const key of ['wf:order-1', 'skill:summarize', 'settings']) {
    test(`${key} is locked: no Edit, no Delete, and the reason`, async () => {
      const view = await open();
      const pane = within(await select(view, key));
      expect(pane.getByTestId('storage-key-managed')).not.toBeNull();
      expect(pane.queryByRole('button', { name: STORAGE_COPY.detail.edit })).toBeNull();
      expect(pane.queryByRole('button', { name: STORAGE_COPY.detail.moreActions })).toBeNull();
      expect(pane.getByRole('button', { name: STORAGE_COPY.detail.copyKey })).not.toBeNull();
    });
  }

  test('the lock line names the group in monospace, in the sentence the design words', async () => {
    const view = await open();
    const pane = within(await select(view, 'wf:order-1'));
    const lock = pane.getByTestId('storage-key-managed');
    await waitFor(() =>
      expect(lock.textContent?.replaceAll(/\s+/g, ' ').trim()).toBe(
        'Locked: Interborough manages keys that start with wf: and needs them to recover runs.',
      ),
    );
    expect(lock.querySelector('.ib-storage-key__prefix')?.textContent).toBe('wf:');
  });

  test('while the host cannot say which keys it manages, no key can be edited or deleted', async () => {
    const view = await open({ bureauPrefixes: null });
    const pane = within(await select(view, 'app:config'));
    await waitFor(() => expect(pane.getByText(STORAGE_COPY.detail.unknownManaged)).not.toBeNull());
    expect(pane.queryByRole('button', { name: STORAGE_COPY.detail.edit })).toBeNull();
    expect(pane.queryByRole('button', { name: STORAGE_COPY.detail.moreActions })).toBeNull();
  });
});

/** The wire body of a conditional batch the server received, with its values decoded. */
function conditionalBatchOf(server: ReturnType<typeof serveStorage> | undefined) {
  const call = server?.calls.find((candidate) => candidate.url.endsWith('/-/conditional-batch'));
  if (call?.body === undefined) return undefined;
  const body = JSON.parse(call.body) as {
    conditions: { key: string; expectedValue: string | null }[];
    operations: { type: string; key: string; value?: string }[];
  };
  const decode = (value: string | null | undefined) =>
    value === null || value === undefined ? value : Buffer.from(value, 'base64').toString('utf8');
  return {
    conditions: body.conditions.map((condition) => ({
      key: condition.key,
      expected: decode(condition.expectedValue),
    })),
    operations: body.operations.map((operation) => ({
      type: operation.type,
      key: operation.key,
      value: decode(operation.value),
    })),
  };
}

/** How many times the server has been asked for a page of keys. */
const scanCount = (): number =>
  server?.calls.filter(
    (call) =>
      call.method === 'GET' && new URL(call.url, 'http://localhost').pathname === '/v1/storage',
  ).length ?? 0;

/** Brings the window back into focus, which makes every stale query read again. */
function refocusWindow(): void {
  focusManager.setFocused(false);
  focusManager.setFocused(true);
}

/** Opens the "⋯" menu at the end of the pane's buttons and chooses Delete, which asks to confirm. */
async function chooseDelete(view: View, pane: ReturnType<typeof within>): Promise<void> {
  await fireEvent.click(pane.getByRole('button', { name: STORAGE_COPY.detail.moreActions }));
  await fireEvent.click(await view.findByRole('menuitem', { name: STORAGE_COPY.detail.delete }));
}

/** Opens a key, starts editing it, and returns the pane once the editor is up. */
async function startEditing(view: View, key: string) {
  const pane = within(await select(view, key));
  await waitFor(() =>
    expect(pane.getByRole('button', { name: STORAGE_COPY.detail.edit })).not.toBeNull(),
  );
  await fireEvent.click(pane.getByRole('button', { name: STORAGE_COPY.detail.edit }));
  return pane;
}

/** The wall-clock time the sample key was rewritten at. */
const REWRITTEN_AT = Date.UTC(2026, 10, 2, 16, 45);

/** Opens `app:notes` in the editor with a poll every 25 ms, types `mine`, and has the application rewrite it. */
async function rewriteWhileEditing(options: { readonly time: boolean } = { time: true }) {
  const view = await open({}, undefined, 25);
  const pane = await startEditing(view, 'app:notes');
  await fireEvent.input(pane.getByRole('textbox', { name: STORAGE_COPY.detail.editLabel }), {
    target: { value: 'mine' },
  });
  if (options.time) server?.control.writtenAt.set('app:notes', REWRITTEN_AT);
  server?.store.set('app:notes', new TextEncoder().encode('theirs'));
  const alert = await pane.findByTestId('storage-rewritten');
  return { view, pane, alert };
}

describe('Rewritten while editing', () => {
  test('warns that the key changed and when, keeps the draft, and offers three ways on', async () => {
    const { pane, alert } = await rewriteWhileEditing();

    expect(alert.querySelector('strong')?.textContent).toBe(STORAGE_COPY.detail.rewritten.lead);
    expect(alert.textContent).toContain(
      `The app wrote a new value at ${formatTimeOfDay(REWRITTEN_AT)}.`,
    );
    expect(
      alert.closest('[role="alert"], [data-cinder-variant="warning"], .cinder-alert'),
    ).not.toBeNull();
    // The alert says what happened and nothing else; the three ways on are one row under the editor.
    expect(alert.closest('.cinder-alert')?.querySelectorAll('button')).toHaveLength(0);
    const editor = pane.getByRole('textbox', { name: STORAGE_COPY.detail.editLabel });
    const buttons = pane
      .getAllByRole('button')
      .filter((button) =>
        Boolean(editor.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING),
      );
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      'Discard my edit',
      'Save over it…',
      'Show new value',
    ]);
    expect(buttons.map((button) => button.getAttribute('data-cinder-variant'))).toEqual([
      'secondary',
      'secondary',
      'primary',
    ]);
    // The draft is still there, the editor's own buttons give way to these, and the line above folds the key in.
    expect(
      (pane.getByRole('textbox', { name: STORAGE_COPY.detail.editLabel }) as HTMLTextAreaElement)
        .value,
    ).toBe('mine');
    expect(pane.queryByRole('button', { name: STORAGE_COPY.detail.save })).toBeNull();
    expect(pane.getByTestId('storage-key-summary').textContent?.trim()).toMatch(
      /^App data and memory · \d+ B · app:notes$/,
    );
    // Nothing is overwritten silently.
    expect(new TextDecoder().decode(server?.store.get('app:notes'))).toBe('theirs');
    expect(conditionalBatchOf(server)).toBeUndefined();
  });

  test('says only that the app wrote a new value when the storage records no write time', async () => {
    const { alert } = await rewriteWhileEditing({ time: false });

    expect(alert.textContent).toContain('The app wrote a new value.');
    expect(alert.textContent).not.toContain(' at ');
  });

  test('Discard my edit closes the editor and shows the new value', async () => {
    const { pane } = await rewriteWhileEditing();

    await fireEvent.click(
      pane.getByRole('button', { name: STORAGE_COPY.detail.rewritten.discard }),
    );

    await waitUntil(() => pane.queryByRole('textbox') === null);
    expect(pane.queryByRole('textbox')).toBeNull();
    await pane.findByText('theirs');
    expect(pane.queryByTestId('storage-rewritten')).toBeNull();
    expect(new TextDecoder().decode(server?.store.get('app:notes'))).toBe('theirs');
  });

  test('Save over it asks first, then writes the draft over the newer value, fenced on that value', async () => {
    const { view, pane } = await rewriteWhileEditing();

    await fireEvent.click(
      pane.getByRole('button', { name: STORAGE_COPY.detail.rewritten.saveOver }),
    );
    const dialog = await view.findByRole('dialog');
    expect(dialog.textContent).toContain(STORAGE_COPY.confirmSaveOver.title);
    expect(dialog.textContent).toContain(`was written at ${formatTimeOfDay(REWRITTEN_AT)}`);
    expect(conditionalBatchOf(server)).toBeUndefined();
    await fireEvent.click(
      within(dialog).getByRole('button', { name: STORAGE_COPY.confirmSaveOver.confirm }),
    );

    await waitFor(() => expect(conditionalBatchOf(server)).toBeDefined());
    expect(conditionalBatchOf(server)).toEqual({
      conditions: [{ key: 'app:notes', expected: 'theirs' }],
      operations: [{ type: 'put', key: 'app:notes', value: 'mine' }],
    });
    expect(new TextDecoder().decode(server?.store.get('app:notes'))).toBe('mine');
  });

  test('Show new value puts the new value in the editor, and a save after it is fenced on that value', async () => {
    const { view, pane } = await rewriteWhileEditing();

    await fireEvent.click(
      pane.getByRole('button', { name: STORAGE_COPY.detail.rewritten.showNew }),
    );

    await waitUntil(() => pane.queryByTestId('storage-rewritten') === null);
    const editor = pane.getByRole('textbox', {
      name: STORAGE_COPY.detail.editLabel,
    }) as HTMLTextAreaElement;
    expect(editor.value).toBe('theirs');
    await fireEvent.input(editor, { target: { value: 'theirs, and more' } });
    await fireEvent.click(pane.getByRole('button', { name: STORAGE_COPY.detail.save }));
    const dialog = await view.findByRole('dialog');
    await fireEvent.click(
      within(dialog).getByRole('button', { name: STORAGE_COPY.confirmSave.confirm }),
    );

    await waitFor(() => expect(conditionalBatchOf(server)).toBeDefined());
    expect(conditionalBatchOf(server)?.conditions).toEqual([
      { key: 'app:notes', expected: 'theirs' },
    ]);
    expect(new TextDecoder().decode(server?.store.get('app:notes'))).toBe('theirs, and more');
  });

  test('says nothing while the key still holds what the editor opened on', async () => {
    const view = await open({}, undefined, 25);
    const pane = await startEditing(view, 'app:notes');
    const reads = () =>
      server?.calls.filter((call) => call.method === 'GET' && call.url.includes('lte=app%3Anotes'))
        .length ?? 0;
    await waitUntil(() => reads() >= 3);

    expect(pane.queryByTestId('storage-rewritten')).toBeNull();
    expect(pane.getByRole('button', { name: STORAGE_COPY.detail.save })).not.toBeNull();
  });
});

describe('Edit', () => {
  test('saves only after the confirmation, and only if the key still holds what was read', async () => {
    const view = await open();
    const pane = await startEditing(view, 'app:notes');
    const editor = pane.getByRole('textbox', { name: STORAGE_COPY.detail.editLabel });
    expect((editor as HTMLTextAreaElement).value).toBe('plain text note');

    await fireEvent.input(editor, { target: { value: 'a new note' } });
    await fireEvent.click(pane.getByRole('button', { name: STORAGE_COPY.detail.save }));

    const dialog = await view.findByRole('dialog');
    expect(conditionalBatchOf(server)).toBeUndefined();
    await fireEvent.click(
      within(dialog).getByRole('button', { name: STORAGE_COPY.confirmSave.confirm }),
    );

    await waitFor(() => expect(conditionalBatchOf(server)).toBeDefined());
    expect(conditionalBatchOf(server)).toEqual({
      conditions: [{ key: 'app:notes', expected: 'plain text note' }],
      operations: [{ type: 'put', key: 'app:notes', value: 'a new note' }],
    });
    expect(new TextDecoder().decode(server?.store.get('app:notes'))).toBe('a new note');
    expect(await view.findByText(STORAGE_COPY.detail.saved('app:notes'))).not.toBeNull();
    await waitFor(() =>
      expect(
        pane.queryByRole('textbox', { name: STORAGE_COPY.detail.editLabel })?.outerHTML ?? null,
      ).toBeNull(),
    );
  });

  test('writes nothing when the key changed after it was opened, and says so', async () => {
    const view = await open();
    const pane = await startEditing(view, 'app:notes');
    await fireEvent.input(pane.getByRole('textbox', { name: STORAGE_COPY.detail.editLabel }), {
      target: { value: 'my version' },
    });
    // Someone else writes the key while the editor is open.
    server?.store.set('app:notes', new TextEncoder().encode('their version'));

    await fireEvent.click(pane.getByRole('button', { name: STORAGE_COPY.detail.save }));
    const dialog = await view.findByRole('dialog');
    await fireEvent.click(
      within(dialog).getByRole('button', { name: STORAGE_COPY.confirmSave.confirm }),
    );

    expect(await pane.findByText(STORAGE_COPY.detail.changedUnderYou)).not.toBeNull();
    expect(new TextDecoder().decode(server?.store.get('app:notes'))).toBe('their version');
    expect(pane.getByRole('textbox', { name: STORAGE_COPY.detail.editLabel })).not.toBeNull();
  });

  test('fences the save on the value that was opened, not on what a refetch read since', async () => {
    const view = await open();
    const pane = await startEditing(view, 'app:notes');
    await fireEvent.input(pane.getByRole('textbox', { name: STORAGE_COPY.detail.editLabel }), {
      target: { value: 'my version' },
    });
    // Another writer changes the key, and the window regains focus, so the table reads it again.
    const scansBefore = scanCount();
    server?.store.set('app:notes', new TextEncoder().encode('their version'));
    refocusWindow();
    await waitUntil(() => scanCount() > scansBefore);
    await waitFor(() => expect(rowOf(view, 'app:notes').textContent).toContain('13 B'));

    await fireEvent.click(pane.getByRole('button', { name: STORAGE_COPY.detail.save }));
    const dialog = await view.findByRole('dialog');
    await fireEvent.click(
      within(dialog).getByRole('button', { name: STORAGE_COPY.confirmSave.confirm }),
    );

    expect(await pane.findByText(STORAGE_COPY.detail.changedUnderYou)).not.toBeNull();
    expect(conditionalBatchOf(server)?.conditions).toEqual([
      { key: 'app:notes', expected: 'plain text note' },
    ]);
    expect(new TextDecoder().decode(server?.store.get('app:notes'))).toBe('their version');
  });

  test('while the editor is open the pane offers the editor’s buttons and nothing that changes the key another way', async () => {
    const view = await open();
    const pane = await startEditing(view, 'app:notes');
    expect(pane.queryByRole('button', { name: STORAGE_COPY.detail.moreActions })).toBeNull();
    expect(pane.queryByRole('button', { name: STORAGE_COPY.detail.edit })).toBeNull();
    expect(pane.getAllByRole('button').map((button) => button.textContent?.trim())).toEqual([
      STORAGE_COPY.detail.cancel,
      STORAGE_COPY.detail.save,
    ]);
  });

  test('a refusal outlives the pane when the key was deleted by another writer', async () => {
    const view = await open();
    const pane = await startEditing(view, 'app:notes');
    await fireEvent.input(pane.getByRole('textbox', { name: STORAGE_COPY.detail.editLabel }), {
      target: { value: 'my version' },
    });
    server?.store.delete('app:notes');
    await fireEvent.click(pane.getByRole('button', { name: STORAGE_COPY.detail.save }));
    const dialog = await view.findByRole('dialog');
    await fireEvent.click(
      within(dialog).getByRole('button', { name: STORAGE_COPY.confirmSave.confirm }),
    );

    // The refetch drops the key from the table, which closes the pane; the message is still said.
    await waitFor(() => expect(view.queryByTestId('storage-key')?.outerHTML ?? null).toBeNull());
    expect(await view.findByText(STORAGE_COPY.detail.changedUnderYou)).not.toBeNull();
    expect(server?.store.has('app:notes')).toBe(false);
  });

  test('a refused save reads the key again, so opening it shows what it holds now', async () => {
    const view = await open();
    const pane = await startEditing(view, 'app:notes');
    await fireEvent.input(pane.getByRole('textbox', { name: STORAGE_COPY.detail.editLabel }), {
      target: { value: 'my version' },
    });
    server?.store.set('app:notes', new TextEncoder().encode('their version'));
    const scansBefore = scanCount();

    await fireEvent.click(pane.getByRole('button', { name: STORAGE_COPY.detail.save }));
    const dialog = await view.findByRole('dialog');
    await fireEvent.click(
      within(dialog).getByRole('button', { name: STORAGE_COPY.confirmSave.confirm }),
    );

    expect(await pane.findByText(STORAGE_COPY.detail.changedUnderYou)).not.toBeNull();
    await waitFor(() => expect(scanCount()).toBeGreaterThan(scansBefore));
    await waitFor(() => expect(rowOf(view, 'app:notes').textContent).toContain('13 B'));
  });

  test('writes nothing while the storage has not said whether it can write conditionally', async () => {
    const view = await open({ capabilitiesStatus: 500 });
    const pane = await startEditing(view, 'app:notes');
    await waitFor(() =>
      expect(server?.calls.some((call) => call.body?.includes('weft.storage.capabilities'))).toBe(
        true,
      ),
    );
    await fireEvent.input(pane.getByRole('textbox', { name: STORAGE_COPY.detail.editLabel }), {
      target: { value: 'unchecked' },
    });
    await fireEvent.click(pane.getByRole('button', { name: STORAGE_COPY.detail.save }));
    const dialog = await view.findByRole('dialog');
    await fireEvent.click(
      within(dialog).getByRole('button', { name: STORAGE_COPY.confirmSave.confirm }),
    );

    expect(await pane.findByText(STORAGE_COPY.detail.capabilityUnknown)).not.toBeNull();
    expect(server?.calls.some((call) => call.method === 'PUT')).toBe(false);
    expect(conditionalBatchOf(server)).toBeUndefined();
    expect(new TextDecoder().decode(server?.store.get('app:notes'))).toBe('plain text note');
  });

  test('a storage that cannot write conditionally takes a plain put', async () => {
    const view = await open({ conditionalBatch: false });
    await view.findByRole('button', { name: 'Storage details' });
    // The capability arrives with the page; wait for the view to have read it before saving.
    const pane = await startEditing(view, 'app:notes');
    await waitFor(() =>
      expect(server?.calls.some((call) => call.body?.includes('weft.storage.capabilities'))).toBe(
        true,
      ),
    );
    await fireEvent.input(pane.getByRole('textbox', { name: STORAGE_COPY.detail.editLabel }), {
      target: { value: 'plain put' },
    });
    await fireEvent.click(pane.getByRole('button', { name: STORAGE_COPY.detail.save }));
    const dialog = await view.findByRole('dialog');
    // Where the person confirms, the dialog says nothing will check the value first.
    expect(dialog.textContent).toContain(STORAGE_COPY.confirmSave.description('app:notes', true));
    await fireEvent.click(
      within(dialog).getByRole('button', { name: STORAGE_COPY.confirmSave.confirm }),
    );

    await waitFor(() =>
      expect(server?.calls.filter((call) => call.method === 'PUT')).toHaveLength(1),
    );
    const put = server?.calls.find((call) => call.method === 'PUT');
    expect(put?.url).toContain('/v1/storage/app%3Anotes');
    expect(put?.body).toBe('plain put');
    expect(conditionalBatchOf(server)).toBeUndefined();
  });

  test('a save the server refuses is an error in the pane, and the editor stays open', async () => {
    const view = await open();
    const pane = await startEditing(view, 'app:notes');
    await fireEvent.input(pane.getByRole('textbox', { name: STORAGE_COPY.detail.editLabel }), {
      target: { value: 'changed' },
    });
    if (server) server.control.refuseWrites = true;
    await fireEvent.click(pane.getByRole('button', { name: STORAGE_COPY.detail.save }));
    const dialog = await view.findByRole('dialog');
    await fireEvent.click(
      within(dialog).getByRole('button', { name: STORAGE_COPY.confirmSave.confirm }),
    );

    const alert = await pane.findByTestId('storage-save-failed');
    expect(alert.textContent?.replaceAll(/\s+/g, ' ').trim()).toBe(
      `${STORAGE_COPY.detail.saveFailed.lead} Raw storage access requires storage:admin. ${STORAGE_COPY.detail.saveFailed.kept}`,
    );
    expect(pane.getByRole('textbox', { name: STORAGE_COPY.detail.editLabel })).not.toBeNull();
  });

  test('refuses to save text where the value was JSON, and says why', async () => {
    const view = await open();
    const pane = await startEditing(view, 'cache:rates');

    await fireEvent.input(pane.getByRole('textbox', { name: STORAGE_COPY.detail.editLabel }), {
      target: { value: '{"usd":' },
    });

    expect(pane.getByText(STORAGE_COPY.detail.notJson)).not.toBeNull();
    expect(
      (pane.getByRole('button', { name: STORAGE_COPY.detail.save }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test('cancelling leaves the value as it was', async () => {
    const view = await open();
    const pane = await startEditing(view, 'app:notes');
    await fireEvent.click(pane.getByRole('button', { name: STORAGE_COPY.detail.cancel }));
    expect(pane.queryByRole('textbox', { name: STORAGE_COPY.detail.editLabel })).toBeNull();
    expect(conditionalBatchOf(server)).toBeUndefined();
    expect(server?.calls.some((call) => call.method === 'PUT')).toBe(false);
  });
});

describe('Delete', () => {
  test('removes the key only after the confirmation, only if it still holds what was read, and closes the pane', async () => {
    const view = await open();
    const pane = within(await select(view, 'cache:rates'));
    await waitFor(() =>
      expect(pane.getByRole('button', { name: STORAGE_COPY.detail.moreActions })).not.toBeNull(),
    );
    await chooseDelete(view, pane);

    const dialog = await view.findByRole('dialog');
    expect(conditionalBatchOf(server)).toBeUndefined();
    await fireEvent.click(
      within(dialog).getByRole('button', { name: STORAGE_COPY.confirmDelete.confirm }),
    );

    await waitFor(() => expect(conditionalBatchOf(server)).toBeDefined());
    expect(conditionalBatchOf(server)).toEqual({
      conditions: [{ key: 'cache:rates', expected: '{"usd":1}' }],
      operations: [{ type: 'delete', key: 'cache:rates', value: undefined }],
    });
    expect(server?.store.has('cache:rates')).toBe(false);
    expect(await view.findByText(STORAGE_COPY.detail.deleted('cache:rates'))).not.toBeNull();
    await waitFor(() => expect(view.queryByTestId('storage-key')?.outerHTML ?? null).toBeNull());
    await footerSays(view, 'Showing 5 of 5 keys.');
  });

  test('leaves a key that changed after it was opened, and says so', async () => {
    const view = await open();
    const pane = within(await select(view, 'cache:rates'));
    await waitFor(() =>
      expect(pane.getByRole('button', { name: STORAGE_COPY.detail.moreActions })).not.toBeNull(),
    );
    server?.store.set('cache:rates', new TextEncoder().encode('{"usd":2}'));
    await chooseDelete(view, pane);
    const dialog = await view.findByRole('dialog');
    await fireEvent.click(
      within(dialog).getByRole('button', { name: STORAGE_COPY.confirmDelete.confirm }),
    );

    expect(await pane.findByText(STORAGE_COPY.detail.deleteFailed)).not.toBeNull();
    expect(pane.getByText(STORAGE_COPY.detail.changedUnderYou)).not.toBeNull();
    expect(server?.store.has('cache:rates')).toBe(true);
  });

  test('fences the delete on the value that was opened, not on what a refetch read since', async () => {
    const view = await open();
    const pane = within(await select(view, 'cache:rates'));
    await waitFor(() =>
      expect(pane.getByRole('button', { name: STORAGE_COPY.detail.moreActions })).not.toBeNull(),
    );
    await chooseDelete(view, pane);
    const dialog = await view.findByRole('dialog');
    const scansBefore = scanCount();
    server?.store.set('cache:rates', new TextEncoder().encode('{"usd":22}'));
    refocusWindow();
    await waitUntil(() => scanCount() > scansBefore);
    await waitFor(() => expect(rowOf(view, 'cache:rates').textContent).toContain('10 B'));
    await fireEvent.click(
      within(dialog).getByRole('button', { name: STORAGE_COPY.confirmDelete.confirm }),
    );

    expect(await pane.findByText(STORAGE_COPY.detail.changedUnderYou)).not.toBeNull();
    expect(server?.store.has('cache:rates')).toBe(true);
  });

  test('writes nothing while the storage has not said whether it can write conditionally', async () => {
    const view = await open({ capabilitiesStatus: 500 });
    const pane = within(await select(view, 'cache:rates'));
    await waitFor(() =>
      expect(pane.getByRole('button', { name: STORAGE_COPY.detail.moreActions })).not.toBeNull(),
    );
    await waitFor(() =>
      expect(server?.calls.some((call) => call.body?.includes('weft.storage.capabilities'))).toBe(
        true,
      ),
    );
    await chooseDelete(view, pane);
    const dialog = await view.findByRole('dialog');
    await fireEvent.click(
      within(dialog).getByRole('button', { name: STORAGE_COPY.confirmDelete.confirm }),
    );

    expect(await pane.findByText(STORAGE_COPY.detail.capabilityUnknown)).not.toBeNull();
    expect(server?.calls.some((call) => call.method === 'DELETE')).toBe(false);
    expect(conditionalBatchOf(server)).toBeUndefined();
    expect(server?.store.has('cache:rates')).toBe(true);
  });

  test('a delete the server refuses is an error in the pane', async () => {
    const view = await open();
    const pane = within(await select(view, 'cache:rates'));
    await waitFor(() =>
      expect(pane.getByRole('button', { name: STORAGE_COPY.detail.moreActions })).not.toBeNull(),
    );
    if (server) server.control.refuseWrites = true;
    await chooseDelete(view, pane);
    const dialog = await view.findByRole('dialog');
    await fireEvent.click(
      within(dialog).getByRole('button', { name: STORAGE_COPY.confirmDelete.confirm }),
    );

    expect(await pane.findByText(STORAGE_COPY.detail.deleteFailed)).not.toBeNull();
    expect(pane.getByText('Raw storage access requires storage:admin.')).not.toBeNull();
    expect(server?.store.has('cache:rates')).toBe(true);
  });

  test('a storage that cannot write conditionally takes a plain delete', async () => {
    const view = await open({ conditionalBatch: false });
    const pane = within(await select(view, 'cache:rates'));
    await waitFor(() =>
      expect(pane.getByRole('button', { name: STORAGE_COPY.detail.moreActions })).not.toBeNull(),
    );
    await waitFor(() =>
      expect(server?.calls.some((call) => call.body?.includes('weft.storage.capabilities'))).toBe(
        true,
      ),
    );
    await chooseDelete(view, pane);
    const dialog = await view.findByRole('dialog');
    expect(dialog.textContent?.replaceAll(/\s+/g, ' ')).toContain(
      `cache:rates${STORAGE_COPY.confirmDelete.afterKey('9 B', true)}`,
    );
    await fireEvent.click(
      within(dialog).getByRole('button', { name: STORAGE_COPY.confirmDelete.confirm }),
    );

    await waitFor(() => expect(server?.store.has('cache:rates')).toBe(false));
    expect(server?.calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
    expect(conditionalBatchOf(server)).toBeUndefined();
  });

  test('a group left empty by the delete stays chosen, and the empty table offers to clear it', async () => {
    const view = await open();
    const groups = (await view.findByLabelText('Group')) as HTMLSelectElement;
    await waitFor(() =>
      expect([...groups.options].map((option) => option.value)).toContain('cache:'),
    );
    await fireEvent.change(groups, { target: { value: 'cache:' } });
    const pane = within(await select(view, 'cache:rates'));
    await waitFor(() =>
      expect(pane.getByRole('button', { name: STORAGE_COPY.detail.moreActions })).not.toBeNull(),
    );
    await chooseDelete(view, pane);
    const dialog = await view.findByRole('dialog');
    await fireEvent.click(
      within(dialog).getByRole('button', { name: STORAGE_COPY.confirmDelete.confirm }),
    );

    await view.findByText(STORAGE_COPY.noMatches.title);
    expect((view.getByLabelText('Group') as HTMLSelectElement).value).toBe('cache:');
    await fireEvent.click(view.getByRole('button', { name: STORAGE_COPY.noMatches.clear }));
    await footerSays(view, 'Showing 5 of 5 keys.');
  });

  test('closing after a delete leaves open the key the person moved to while it ran', async () => {
    const view = await open();
    const pane = within(await select(view, 'cache:rates'));
    await waitFor(() =>
      expect(pane.getByRole('button', { name: STORAGE_COPY.detail.moreActions })).not.toBeNull(),
    );
    await chooseDelete(view, pane);
    const dialog = await view.findByRole('dialog');
    await fireEvent.click(
      within(dialog).getByRole('button', { name: STORAGE_COPY.confirmDelete.confirm }),
    );
    // The person opens another key at once; the delete finishing must not close that one.
    await fireEvent.click(rowOf(view, 'app:notes'));

    await waitFor(() => expect(server?.store.has('cache:rates')).toBe(false));
    await footerSays(view, 'Showing 5 of 5 keys.');
    expect(view.getByTestId('storage-key-name').textContent).toBe('app:notes');
  });
});

describe('the storage line', () => {
  test('names a local SQLite file, and opens the five facts, with the chevron turned up', async () => {
    const view = await open({ sizeBytes: 2_048 });
    expect(await view.findByText('Running on SQLite in ~/.interborough')).not.toBeNull();
    const trigger = await view.findByRole('button', { name: 'Storage details' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    const details = within(await view.findByTestId('storage-details'));
    await waitFor(() =>
      expect(details.getAllByRole('term').map((term) => term.textContent?.trim())).toEqual([
        'Backend',
        'Location',
        'Size',
        'Keys',
        'Writes',
      ]),
    );
    const definitions = details
      .getAllByRole('definition')
      .map((value) => value.textContent?.trim());
    expect(definitions).toEqual([
      'SQLite',
      '~/.interborough',
      '2.0 KB',
      '6',
      'Per key; managed keys are locked',
    ]);
    expect(details.getByRole('link', { name: 'Settings › Data and retention' })).not.toBeNull();
    // The capabilities are not drawn: the popover replaces that tab.
    expect(view.queryByText('Persistence')).toBeNull();
    expect(view.queryByText('Conditional batch')).toBeNull();
  });

  test('shows a dash for a size the backend cannot report, never zero', async () => {
    const view = await open({ sizeBytes: null });
    await fireEvent.click(await view.findByRole('button', { name: 'Storage details' }));
    const details = within(await view.findByTestId('storage-details'));
    await waitFor(() =>
      expect(details.getAllByRole('definition')[2]?.textContent?.trim()).toBe('—'),
    );
  });

  test('names Postgres and S3 for a remote installation', async () => {
    const view = await open({ mode: 'remote' });
    expect(
      await view.findByText('Running on Postgres and S3 in db.example.test:5432/interborough'),
    ).not.toBeNull();
  });
});

describe('before a key is chosen', () => {
  test('the pane says what to do, with a database glyph, and no row is highlighted', async () => {
    const view = await open();
    await view.findByRole('table');
    const pane = within(await view.findByLabelText(STORAGE_COPY.detail.paneLabel));
    expect(pane.getByRole('heading', { name: STORAGE_COPY.detail.emptyTitle })).not.toBeNull();
    expect(pane.getByText(STORAGE_COPY.detail.emptyDescription)).not.toBeNull();
    expect(view.container.querySelector('tbody tr[aria-current="true"]')).toBeNull();
    expect(view.queryByTestId('storage-key')).toBeNull();
  });
});

describe('reading the value of a chosen key', () => {
  test('shows the group and the key at once, Copy key disabled, and nothing else, while the value is read', async () => {
    const view = await open();
    await view.findByRole('table');
    if (server) server.control.holdValues = true;
    const pane = within(await select(view, 'app:notes'));

    expect(pane.getByTestId('storage-key-summary').textContent?.trim()).toBe('App data and memory');
    expect(pane.getByTestId('storage-key-name').textContent).toBe('app:notes');
    expect(
      (pane.getByRole('button', { name: STORAGE_COPY.detail.copyKey }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    for (const name of [
      STORAGE_COPY.detail.copyValue,
      STORAGE_COPY.detail.edit,
      STORAGE_COPY.detail.moreActions,
    ]) {
      expect(pane.queryByRole('button', { name })).toBeNull();
    }
    // The value is a skeleton after the 300 ms every loading state waits, and a quick read never shows one.
    await waitFor(() =>
      expect(pane.getByText(STORAGE_COPY.detail.valueLoadingLabel)).not.toBeNull(),
    );
    expect(pane.queryByText('plain text note')).toBeNull();
  });

  test('says when the value could not be read, and reads it again on Try again', async () => {
    const view = await open();
    await view.findByRole('table');
    if (server) server.control.valueStatus = 500;
    const pane = within(await select(view, 'app:notes'));

    expect(await pane.findByText(STORAGE_COPY.detail.valueFailed)).not.toBeNull();
    expect(pane.queryByRole('button', { name: STORAGE_COPY.detail.edit })).toBeNull();

    if (server) server.control.valueStatus = undefined;
    await fireEvent.click(pane.getByRole('button', { name: STORAGE_COPY.detail.valueRetry }));

    expect(await pane.findByText('plain text note')).not.toBeNull();
    expect(pane.getByRole('button', { name: STORAGE_COPY.detail.edit })).not.toBeNull();
  });

  test('says when the key was removed after its row was listed', async () => {
    const view = await open();
    await view.findByRole('table');
    server?.store.delete('app:notes');
    const pane = within(await select(view, 'app:notes'));

    expect(await pane.findByText(STORAGE_COPY.detail.valueGone)).not.toBeNull();
    expect(pane.queryByRole('button', { name: STORAGE_COPY.detail.edit })).toBeNull();
  });
});

describe('the buttons of a key the application does not manage', () => {
  test('Copy key, Copy value and Edit are buttons, and Delete is only in the menu at the end of the row', async () => {
    const view = await open();
    const pane = within(await select(view, 'app:config'));
    await waitFor(() =>
      expect(pane.getByRole('button', { name: STORAGE_COPY.detail.edit })).not.toBeNull(),
    );

    const names = pane.getAllByRole('button').map((button) => button.textContent?.trim());
    expect(names.slice(0, 3)).toEqual([
      STORAGE_COPY.detail.copyKey,
      STORAGE_COPY.detail.copyValue,
      STORAGE_COPY.detail.edit,
    ]);
    expect(pane.queryByRole('button', { name: STORAGE_COPY.detail.delete })).toBeNull();
    await fireEvent.click(pane.getByRole('button', { name: STORAGE_COPY.detail.moreActions }));
    expect(await view.findByRole('menuitem', { name: STORAGE_COPY.detail.delete })).not.toBeNull();
  });

  test('Delete asks first, names the key and its size, and says it cannot be undone', async () => {
    const view = await open();
    const pane = within(await select(view, 'cache:rates'));
    await waitFor(() =>
      expect(pane.getByRole('button', { name: STORAGE_COPY.detail.moreActions })).not.toBeNull(),
    );
    await chooseDelete(view, pane);

    const dialog = await view.findByRole('dialog');
    expect(dialog.textContent?.replaceAll(/\s+/g, ' ')).toContain(
      'Delete this key? cache:rates and its 9 B value are removed from storage. This can’t be undone.',
    );
    expect(within(dialog).getByRole('button', { name: 'Delete key' })).not.toBeNull();
    expect(server?.store.has('cache:rates')).toBe(true);
  });

  test('a save that fails says so in one line over the editor, keeps the typed value, and folds the key into the line above', async () => {
    const view = await open();
    const pane = await startEditing(view, 'app:notes');
    await fireEvent.input(pane.getByRole('textbox', { name: STORAGE_COPY.detail.editLabel }), {
      target: { value: 'kept text' },
    });
    if (server) server.control.refuseWrites = true;
    await fireEvent.click(pane.getByRole('button', { name: STORAGE_COPY.detail.save }));
    const dialog = await view.findByRole('dialog');
    await fireEvent.click(
      within(dialog).getByRole('button', { name: STORAGE_COPY.confirmSave.confirm }),
    );

    const alert = await pane.findByTestId('storage-save-failed');
    expect(alert.querySelector('strong')?.textContent).toBe(STORAGE_COPY.detail.saveFailed.lead);
    // The alert sits above the editor, and the editor keeps what was typed.
    const editor = pane.getByRole('textbox', {
      name: STORAGE_COPY.detail.editLabel,
    }) as HTMLTextAreaElement;
    expect(alert.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(editor.value).toBe('kept text');
    expect(pane.getByTestId('storage-key-summary').textContent?.trim()).toMatch(
      /^App data and memory · \d+ B · app:notes$/,
    );
    expect(pane.queryByTestId('storage-key-name')).toBeNull();
    expect(pane.getByRole('button', { name: STORAGE_COPY.detail.save }).textContent?.trim()).toBe(
      'Save value',
    );
  });
});
