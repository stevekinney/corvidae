/**
 * Component tests for the Storage page: the `storage:admin` gate, the key table with its group and
 * search controls, the selected key's pane, per-key Edit and Delete with a confirmation, the lock on
 * a key the application manages, and the storage line with its capabilities popover.
 */
import { HttpClient } from '@lostgradient/weft';
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
) {
  server = serveStorage({ keys: KEYS, bureauPrefixes: BUREAU, ...options });
  const view = render(StorageRouteHarness, {
    props: { client: client(), ...(scopes === undefined ? {} : { scopes }) },
  } as never);
  return view;
}

/** What `open` hands back: the rendered page and its queries. */
type View = Awaited<ReturnType<typeof open>>;

const rowOf = (view: View, key: string): HTMLElement => {
  const row = [...view.container.querySelectorAll<HTMLElement>('[data-key-row]')].find(
    (candidate) => candidate.textContent?.includes(key),
  );
  if (!row) throw new Error(`No row for ${key}`);
  return row;
};

async function select(view: View, key: string): Promise<HTMLElement> {
  await waitFor(() => expect(rowOf(view, key)).toBeDefined());
  await fireEvent.click(within(rowOf(view, key)).getByRole('button'));
  return view.findByTestId('storage-key');
}

describe('the gate', () => {
  test('a principal without storage:admin sees a lock state naming the scope, and no table', async () => {
    const view = await open({}, []);
    expect(view.getByText('Storage access requires storage:admin')).not.toBeNull();
    expect(view.getByText('Requires storage:admin')).not.toBeNull();
    expect(view.queryByRole('table')).toBeNull();
    expect(view.queryByTestId('storage-backend')).toBeNull();
    expect(server?.calls).toHaveLength(0);
  });
});

describe('the key table', () => {
  test('lists every key with its group and size, and says how many it holds', async () => {
    const view = await open();
    await view.findByRole('table');
    await waitFor(() => expect(view.getByTestId('storage-count').textContent).toContain('6 keys'));
    const row = rowOf(view, 'app:config');
    expect(row.textContent).toContain('app:');
    expect(row.textContent).toContain(`${new TextEncoder().encode(KEYS['app:config']).length} B`);
    expect(rowOf(view, 'settings').textContent).toContain(STORAGE_COPY.noGroup);
    expect(view.getAllByRole('columnheader').map((header) => header.textContent?.trim())).toEqual([
      'Key',
      'Group',
      'Size',
    ]);
  });

  test('offers the groups in storage, and a chosen group reads only its keys', async () => {
    const view = await open();
    await view.findByRole('table');
    const groups = (await view.findByLabelText('Group')) as HTMLSelectElement;
    await waitFor(() =>
      expect([...groups.options].map((option) => option.textContent?.trim())).toEqual([
        'All groups',
        'app:',
        'cache:',
        'skill:',
        'wf:',
      ]),
    );

    await fireEvent.change(groups, { target: { value: 'app:' } });

    await waitFor(() => expect(view.getByTestId('storage-count').textContent).toContain('2 keys'));
    expect(view.queryByText('cache:rates')).toBeNull();
    const scans = server?.calls.filter(
      (call) => new URL(call.url, 'http://localhost').pathname === '/v1/storage',
    );
    expect(
      scans?.some(
        (call) => new URL(call.url, 'http://localhost').searchParams.get('prefix') === 'app:',
      ),
    ).toBe(true);
  });

  test('a search keeps the keys that contain the text, and can be cleared from the empty state', async () => {
    const view = await open();
    await view.findByRole('table');
    const field = view.getByLabelText(STORAGE_COPY.searchLabel);

    await fireEvent.input(field, { target: { value: 'NOTES' } });
    // The browser fires `search` when Enter is pressed in a search field.
    await fireEvent(field, new window.Event('search'));
    await waitFor(() => expect(view.getByTestId('storage-count').textContent).toContain('1 key'));
    expect(rowOf(view, 'app:notes')).toBeDefined();

    await fireEvent.input(field, { target: { value: 'nothing-like-this' } });
    // The browser fires `search` when Enter is pressed in a search field.
    await fireEvent(field, new window.Event('search'));
    await view.findByText(STORAGE_COPY.noMatches.title);
    await fireEvent.click(view.getByRole('button', { name: STORAGE_COPY.noMatches.clear }));
    await waitFor(() => expect(view.getByTestId('storage-count').textContent).toContain('6 keys'));
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

  test('continues from the last key with Load more', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 130 }, (_, index) => [`bulk:${String(index).padStart(4, '0')}`, 'v']),
    );
    const view = await open({ keys: many });
    await view.findByRole('table');
    await waitFor(() =>
      expect(view.getByTestId('storage-count').textContent).toContain('100 keys so far'),
    );

    await fireEvent.click(view.getByRole('button', { name: STORAGE_COPY.loadMore }));

    await waitFor(() => expect(view.getByTestId('storage-count').textContent).toBe('130 keys'));
    expect(view.queryByRole('button', { name: STORAGE_COPY.loadMore })).toBeNull();
  });
});

describe('a search that reads on', () => {
  const many = Object.fromEntries(
    Array.from({ length: 1_300 }, (_, index) => [`bulk:${String(index).padStart(5, '0')}`, 'v']),
  );

  test('says how far it has read, and Load more continues until the keys run out', async () => {
    const view = await open({ keys: many });
    await view.findByRole('table');
    const field = view.getByLabelText(STORAGE_COPY.searchLabel);
    await fireEvent.input(field, { target: { value: 'not-in-any-key' } });
    await fireEvent(field, new window.Event('search'));

    await view.findByText(STORAGE_COPY.keepSearching.title);
    expect(view.getByText(STORAGE_COPY.keepSearching.description(1_000))).not.toBeNull();
    await fireEvent.click(view.getByRole('button', { name: STORAGE_COPY.loadMore }));

    await view.findByText(STORAGE_COPY.noMatches.title);
    expect(view.queryByText(STORAGE_COPY.keepSearching.title)).toBeNull();
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
    expect(pane.getByText('app:', { selector: 'dd' })).not.toBeNull();
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

  test('shows a value that is not a JSON object as it is, with no switch', async () => {
    const view = await open();
    const pane = within(await select(view, 'app:notes'));
    await waitFor(() => expect(pane.getByText('plain text note')).not.toBeNull());
    expect(pane.queryByRole('radio', { name: STORAGE_COPY.detail.jsonSwitch })).toBeNull();
  });

  test('says a binary value is not text, and offers no Edit', async () => {
    const view = await open({ keys: { 'app:blob': new Uint8Array([0xff, 0xfe, 0x00]) } });
    const pane = within(await select(view, 'app:blob'));
    expect(pane.getByText(STORAGE_COPY.detail.binaryNote)).not.toBeNull();
    expect(pane.queryByRole('button', { name: STORAGE_COPY.detail.edit })).toBeNull();
    expect(pane.getByRole('button', { name: STORAGE_COPY.detail.delete })).not.toBeNull();
  });
});

describe('a key the application manages', () => {
  for (const key of ['wf:order-1', 'skill:summarize', 'settings']) {
    test(`${key} is locked: no Edit, no Delete, and the reason`, async () => {
      const view = await open();
      const pane = within(await select(view, key));
      expect(pane.getByTestId('storage-key-managed')).not.toBeNull();
      expect(pane.queryByRole('button', { name: STORAGE_COPY.detail.edit })).toBeNull();
      expect(pane.queryByRole('button', { name: STORAGE_COPY.detail.delete })).toBeNull();
      expect(pane.getByRole('button', { name: STORAGE_COPY.detail.copyKey })).not.toBeNull();
    });
  }

  test('the table marks a managed key with a lock, and a key of the application with none', async () => {
    const view = await open();
    await view.findByRole('table');
    await waitFor(() => expect(rowOf(view, 'app:config')).toBeDefined());
    // The lock is announced; the host's list arrives after the table, so wait for it.
    await waitFor(() =>
      expect(
        within(rowOf(view, 'wf:order-1')).queryByText(STORAGE_COPY.managedBadge),
      ).not.toBeNull(),
    );
    expect(within(rowOf(view, 'app:config')).queryByText(STORAGE_COPY.managedBadge)).toBeNull();
  });

  test('while the host cannot say which keys it manages, no key can be edited or deleted', async () => {
    const view = await open({ bureauPrefixes: null });
    const pane = within(await select(view, 'app:config'));
    await waitFor(() => expect(pane.getByText(STORAGE_COPY.detail.unknownManaged)).not.toBeNull());
    expect(pane.queryByRole('button', { name: STORAGE_COPY.detail.edit })).toBeNull();
    expect(pane.queryByRole('button', { name: STORAGE_COPY.detail.delete })).toBeNull();
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

/** Opens a key, starts editing it, and returns the pane once the editor is up. */
async function startEditing(view: View, key: string) {
  const pane = within(await select(view, key));
  await waitFor(() =>
    expect(pane.getByRole('button', { name: STORAGE_COPY.detail.edit })).not.toBeNull(),
  );
  await fireEvent.click(pane.getByRole('button', { name: STORAGE_COPY.detail.edit }));
  return pane;
}

describe('Edit', () => {
  test('saves only after the confirmation, and only if the key still holds what was read', async () => {
    const view = await open();
    const pane = await startEditing(view, 'app:notes');
    const editor = pane.getByLabelText(STORAGE_COPY.detail.editLabel);
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
      expect(pane.queryByLabelText(STORAGE_COPY.detail.editLabel)?.outerHTML ?? null).toBeNull(),
    );
  });

  test('writes nothing when the key changed after it was opened, and says so', async () => {
    const view = await open();
    const pane = await startEditing(view, 'app:notes');
    await fireEvent.input(pane.getByLabelText(STORAGE_COPY.detail.editLabel), {
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
    expect(pane.getByLabelText(STORAGE_COPY.detail.editLabel)).not.toBeNull();
  });

  test('a storage that cannot write conditionally takes a plain put', async () => {
    const view = await open({ conditionalBatch: false });
    await view.findByRole('button', { name: /SQLite/ });
    // The capability arrives with the page; wait for the view to have read it before saving.
    const pane = await startEditing(view, 'app:notes');
    await waitFor(() =>
      expect(server?.calls.some((call) => call.body?.includes('weft.storage.capabilities'))).toBe(
        true,
      ),
    );
    await fireEvent.input(pane.getByLabelText(STORAGE_COPY.detail.editLabel), {
      target: { value: 'plain put' },
    });
    await fireEvent.click(pane.getByRole('button', { name: STORAGE_COPY.detail.save }));
    const dialog = await view.findByRole('dialog');
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
    await fireEvent.input(pane.getByLabelText(STORAGE_COPY.detail.editLabel), {
      target: { value: 'changed' },
    });
    if (server) server.control.refuseWrites = true;
    await fireEvent.click(pane.getByRole('button', { name: STORAGE_COPY.detail.save }));
    const dialog = await view.findByRole('dialog');
    await fireEvent.click(
      within(dialog).getByRole('button', { name: STORAGE_COPY.confirmSave.confirm }),
    );

    expect(await pane.findByText(STORAGE_COPY.detail.saveFailed)).not.toBeNull();
    expect(pane.getByText('Raw storage access requires storage:admin.')).not.toBeNull();
    expect(pane.getByLabelText(STORAGE_COPY.detail.editLabel)).not.toBeNull();
  });

  test('refuses to save text where the value was JSON, and says why', async () => {
    const view = await open();
    const pane = await startEditing(view, 'cache:rates');

    await fireEvent.input(pane.getByLabelText(STORAGE_COPY.detail.editLabel), {
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
    expect(pane.queryByLabelText(STORAGE_COPY.detail.editLabel)).toBeNull();
    expect(conditionalBatchOf(server)).toBeUndefined();
    expect(server?.calls.some((call) => call.method === 'PUT')).toBe(false);
  });
});

describe('Delete', () => {
  test('removes the key only after the confirmation, only if it still holds what was read, and closes the pane', async () => {
    const view = await open();
    const pane = within(await select(view, 'cache:rates'));
    await waitFor(() =>
      expect(pane.getByRole('button', { name: STORAGE_COPY.detail.delete })).not.toBeNull(),
    );
    await fireEvent.click(pane.getByRole('button', { name: STORAGE_COPY.detail.delete }));

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
    await waitFor(() => expect(view.getByTestId('storage-count').textContent).toContain('5 keys'));
  });

  test('leaves a key that changed after it was opened, and says so', async () => {
    const view = await open();
    const pane = within(await select(view, 'cache:rates'));
    await waitFor(() =>
      expect(pane.getByRole('button', { name: STORAGE_COPY.detail.delete })).not.toBeNull(),
    );
    server?.store.set('cache:rates', new TextEncoder().encode('{"usd":2}'));
    await fireEvent.click(pane.getByRole('button', { name: STORAGE_COPY.detail.delete }));
    const dialog = await view.findByRole('dialog');
    await fireEvent.click(
      within(dialog).getByRole('button', { name: STORAGE_COPY.confirmDelete.confirm }),
    );

    expect(await pane.findByText(STORAGE_COPY.detail.deleteFailed)).not.toBeNull();
    expect(pane.getByText(STORAGE_COPY.detail.changedUnderYou)).not.toBeNull();
    expect(server?.store.has('cache:rates')).toBe(true);
  });

  test('a delete the server refuses is an error in the pane', async () => {
    const view = await open();
    const pane = within(await select(view, 'cache:rates'));
    await waitFor(() =>
      expect(pane.getByRole('button', { name: STORAGE_COPY.detail.delete })).not.toBeNull(),
    );
    if (server) server.control.refuseWrites = true;
    await fireEvent.click(pane.getByRole('button', { name: STORAGE_COPY.detail.delete }));
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
      expect(pane.getByRole('button', { name: STORAGE_COPY.detail.delete })).not.toBeNull(),
    );
    await waitFor(() =>
      expect(server?.calls.some((call) => call.body?.includes('weft.storage.capabilities'))).toBe(
        true,
      ),
    );
    await fireEvent.click(pane.getByRole('button', { name: STORAGE_COPY.detail.delete }));
    const dialog = await view.findByRole('dialog');
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
      expect(pane.getByRole('button', { name: STORAGE_COPY.detail.delete })).not.toBeNull(),
    );
    await fireEvent.click(pane.getByRole('button', { name: STORAGE_COPY.detail.delete }));
    const dialog = await view.findByRole('dialog');
    await fireEvent.click(
      within(dialog).getByRole('button', { name: STORAGE_COPY.confirmDelete.confirm }),
    );

    await view.findByText(STORAGE_COPY.noMatches.title);
    expect((view.getByLabelText('Group') as HTMLSelectElement).value).toBe('cache:');
    await fireEvent.click(view.getByRole('button', { name: STORAGE_COPY.noMatches.clear }));
    await waitFor(() => expect(view.getByTestId('storage-count').textContent).toContain('5 keys'));
  });

  test('closing after a delete leaves open the key the person moved to while it ran', async () => {
    const view = await open();
    const pane = within(await select(view, 'cache:rates'));
    await waitFor(() =>
      expect(pane.getByRole('button', { name: STORAGE_COPY.detail.delete })).not.toBeNull(),
    );
    await fireEvent.click(pane.getByRole('button', { name: STORAGE_COPY.detail.delete }));
    const dialog = await view.findByRole('dialog');
    await fireEvent.click(
      within(dialog).getByRole('button', { name: STORAGE_COPY.confirmDelete.confirm }),
    );
    // The person opens another key at once; the delete finishing must not close that one.
    await fireEvent.click(within(rowOf(view, 'app:notes')).getByRole('button'));

    await waitFor(() => expect(server?.store.has('cache:rates')).toBe(false));
    await waitFor(() => expect(view.getByTestId('storage-count').textContent).toContain('5 keys'));
    expect(view.getByTestId('storage-key-name').textContent).toBe('app:notes');
  });
});

describe('the storage line', () => {
  test('names a local SQLite file, and opens the six facts the storage reports', async () => {
    const view = await open();
    const line = await view.findByRole('button', {
      name: /SQLite · \/home\/me\/\.interborough\/database\.sqlite/,
    });

    await fireEvent.click(line);

    expect(await view.findByText('Persistence')).not.toBeNull();
    for (const term of [
      'Read after write',
      'Scan consistency',
      'Atomic batch',
      'Conditional batch',
      'Bounded range delete',
    ]) {
      expect(view.getByText(term)).not.toBeNull();
    }
  });

  test('names Postgres and S3 for a remote installation', async () => {
    const view = await open({ mode: 'remote' });
    expect(
      await view.findByRole('button', {
        name: /Postgres and S3 · db\.example\.test:5432\/interborough/,
      }),
    ).not.toBeNull();
  });
});
