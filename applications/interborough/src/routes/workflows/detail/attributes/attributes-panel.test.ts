import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import { HttpClientError } from '@lostgradient/weft';

import { RUN_DETAIL_COPY } from '../../../../app/copy.ts';
import type { AttributesClient } from './attributes-data.ts';
import AttributesPanelHarness from './attributes-panel.test-harness.svelte';

type Store = Record<string, unknown>;

/** A fake server: `get` answers the store as it is, `set` merges into it, as the real operation does. */
function fakeClient(
  store: Store | null,
  options: { setFault?: Error } = {},
): { client: AttributesClient; gets: () => number; sets: unknown[] } {
  const sets: unknown[] = [];
  let gets = 0;
  const client: AttributesClient = {
    operations: {
      'weft.workflows.attributes.get': async () => {
        gets += 1;
        if (store === null) {
          throw new HttpClientError(404, 'Attributes for workflow "wf-1" not found', {
            data: { resource: 'attributes', identifier: 'wf-1' },
          });
        }
        return { ...store };
      },
      'weft.workflows.attributes.set': async (input: { attributes?: unknown }) => {
        sets.push(input);
        if (options.setFault !== undefined) throw options.setFault;
        Object.assign(store ?? {}, input.attributes);
        return { ok: true as const };
      },
    },
  };
  return { client, gets: () => gets, sets };
}

const SEEDED: Store = {
  region: 'us-east',
  retries: 3,
  urgent: false,
  labels: ['gold', 'beta'],
  dueAt: '2026-06-15T12:30:00.000Z',
  'weft:failureCategory': 'application',
};

function renderPanel(
  client: AttributesClient,
  props: { canRead?: boolean; canWrite?: boolean } = {},
) {
  return render(AttributesPanelHarness, {
    props: { client, workflowId: 'wf-1', canRead: true, canWrite: true, ...props },
  });
}

function rowFor(container: HTMLElement, key: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(`[data-attribute-key="${key}"]`);
  if (row === null) throw new Error(`no row for ${key}`);
  return row;
}

describe('AttributesPanel', () => {
  test('lists every attribute the run has, with its value', async () => {
    const { client } = fakeClient({ ...SEEDED });
    const { container, findByText } = renderPanel(client);

    await findByText('us-east');
    expect(container.querySelector('[data-state="ready"]')).not.toBeNull();
    expect(rowFor(container, 'region').textContent).toContain('us-east');
    expect(rowFor(container, 'retries').textContent).toContain('3');
    expect(rowFor(container, 'urgent').textContent).toContain('false');
    expect(rowFor(container, 'labels').textContent).toContain('gold');
    expect(rowFor(container, 'labels').textContent).toContain('beta');
    expect(rowFor(container, 'dueAt').textContent).toContain('2026-06-15T12:30:00.000Z');
    expect(rowFor(container, 'weft:failureCategory').textContent).toContain('application');
  });

  test('renders data-state="empty" with its copy for a run with no attribute record', async () => {
    const { client } = fakeClient(null);
    const { container, findByText, queryByRole } = renderPanel(client);

    await findByText(RUN_DETAIL_COPY.attributes.empty);
    const section = container.querySelector('[data-state="empty"]');
    expect(section).not.toBeNull();
    // An empty record is not a fault: no alert, and nothing to edit.
    expect(queryByRole('alert')).toBeNull();
    expect(container.querySelector('[data-attribute-key]')).toBeNull();
  });

  test('renders nothing, and reads nothing, without attributes:read', async () => {
    const { client, gets } = fakeClient({ ...SEEDED });
    const { container } = renderPanel(client, { canRead: false });

    expect(container.querySelector('[data-state]')).toBeNull();
    expect(container.textContent).not.toContain('us-east');
    expect(gets()).toBe(0);
  });

  test('offers no edit control without attributes:write', async () => {
    const { client } = fakeClient({ ...SEEDED });
    const { container, findByText, queryAllByRole } = renderPanel(client, { canWrite: false });

    await findByText('us-east');
    expect(queryAllByRole('button', { name: /^Edit/ })).toHaveLength(0);
    expect(container.querySelector('[data-attribute-key] button')).toBeNull();
  });

  test('offers no edit control for an engine-owned weft: key', async () => {
    const { client } = fakeClient({ ...SEEDED });
    const { container, findByText } = renderPanel(client);

    await findByText('us-east');
    const owned = rowFor(container, 'weft:failureCategory');
    expect(owned.querySelector('button')).toBeNull();
    expect(owned.getAttribute('data-engine-owned')).toBe('true');
    // The same run's other keys do offer one.
    expect(rowFor(container, 'region').querySelector('button')).not.toBeNull();
  });

  test('has no control to add or remove a key', async () => {
    const { client } = fakeClient({ ...SEEDED });
    const { findByText, queryByRole } = renderPanel(client);

    await findByText('us-east');
    expect(queryByRole('button', { name: /add|new|remove|delete/i })).toBeNull();
  });

  test('edits a string and then shows the value a fresh get returns', async () => {
    const store = { ...SEEDED };
    const { client, sets, gets } = fakeClient(store);
    const { container, findByLabelText, getByRole, findByText } = renderPanel(client);

    await findByText('us-east');
    const readsBefore = gets();
    await fireEvent.click(getByRole('button', { name: 'Edit region' }));
    await fireEvent.input(await findByLabelText('region'), { target: { value: 'eu-central' } });
    await fireEvent.click(getByRole('button', { name: 'Save region' }));

    await waitFor(() =>
      expect(sets).toEqual([{ workflowId: 'wf-1', attributes: { region: 'eu-central' } }]),
    );
    // The value on the page is what the refetch returned, not what was typed.
    await waitFor(() => expect(rowFor(container, 'region').textContent).toContain('eu-central'));
    expect(gets()).toBeGreaterThan(readsBefore);
    expect(rowFor(container, 'region').textContent).not.toContain('us-east');
    // The editor closes once the save lands. (Compared as a boolean: a failed `toBeNull()` on an element
    // formats the whole happy-dom node, which takes about a second a try.)
    await waitFor(() => expect(container.querySelector('input') === null).toBe(true));
  });

  test('edits a number in its own type', async () => {
    const { client, sets } = fakeClient({ ...SEEDED });
    const { findByLabelText, getByRole, findByText } = renderPanel(client);

    await findByText('us-east');
    await fireEvent.click(getByRole('button', { name: 'Edit retries' }));
    const input = await findByLabelText('retries');
    expect(input.getAttribute('type')).toBe('number');
    await fireEvent.input(input, { target: { value: '7' } });
    await fireEvent.click(getByRole('button', { name: 'Save retries' }));

    await waitFor(() => expect(sets).toEqual([{ workflowId: 'wf-1', attributes: { retries: 7 } }]));
  });

  test('refuses a number that is not one, without calling set', async () => {
    const { client, sets } = fakeClient({ ...SEEDED });
    const { findByLabelText, getByRole, findByText } = renderPanel(client);

    await findByText('us-east');
    await fireEvent.click(getByRole('button', { name: 'Edit retries' }));
    await fireEvent.input(await findByLabelText('retries'), { target: { value: '' } });
    await fireEvent.click(getByRole('button', { name: 'Save retries' }));

    expect(await findByText(RUN_DETAIL_COPY.attributes.invalidNumber)).not.toBeNull();
    expect(sets).toEqual([]);
  });

  test('edits a boolean with a switch', async () => {
    const { client, sets } = fakeClient({ ...SEEDED });
    const { getByRole, findByText } = renderPanel(client);

    await findByText('us-east');
    await fireEvent.click(getByRole('button', { name: 'Edit urgent' }));
    await fireEvent.click(getByRole('switch', { name: 'urgent' }));
    await fireEvent.click(getByRole('button', { name: 'Save urgent' }));

    await waitFor(() =>
      expect(sets).toEqual([{ workflowId: 'wf-1', attributes: { urgent: true } }]),
    );
  });

  test('edits a date and sends it as an ISO string', async () => {
    const { client, sets } = fakeClient({ ...SEEDED });
    const { findByLabelText, getByRole, findByText } = renderPanel(client);

    await findByText('us-east');
    await fireEvent.click(getByRole('button', { name: 'Edit dueAt' }));
    await fireEvent.input(await findByLabelText('dueAt'), {
      target: { value: '2026-07-01T09:00:00Z' },
    });
    await fireEvent.click(getByRole('button', { name: 'Save dueAt' }));

    await waitFor(() =>
      expect(sets).toEqual([
        { workflowId: 'wf-1', attributes: { dueAt: '2026-07-01T09:00:00.000Z' } },
      ]),
    );
  });

  test('refuses a date that does not parse, without calling set', async () => {
    const { client, sets } = fakeClient({ ...SEEDED });
    const { findByLabelText, getByRole, findByText } = renderPanel(client);

    await findByText('us-east');
    await fireEvent.click(getByRole('button', { name: 'Edit dueAt' }));
    await fireEvent.input(await findByLabelText('dueAt'), { target: { value: 'next tuesday' } });
    await fireEvent.click(getByRole('button', { name: 'Save dueAt' }));

    expect(await findByText(RUN_DETAIL_COPY.attributes.invalidDate)).not.toBeNull();
    expect(sets).toEqual([]);
  });

  test('edits a list of strings', async () => {
    const { client, sets } = fakeClient({ ...SEEDED });
    const { findAllByLabelText, getByRole, findByText } = renderPanel(client);

    await findByText('us-east');
    await fireEvent.click(getByRole('button', { name: 'Edit labels' }));
    // The tag list and its text input both carry the label; the input is what takes a new tag.
    const labelled = await findAllByLabelText('labels');
    const input = labelled.find((element) => element.tagName === 'INPUT');
    if (input === undefined) throw new Error('no text input for the list editor');
    await fireEvent.input(input, { target: { value: 'priority' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await fireEvent.click(getByRole('button', { name: 'Save labels' }));

    await waitFor(() =>
      expect(sets).toEqual([
        { workflowId: 'wf-1', attributes: { labels: ['gold', 'beta', 'priority'] } },
      ]),
    );
  });

  test('shows a rejected set in the fault banner and leaves the displayed values as they were', async () => {
    const store = { ...SEEDED };
    const { client } = fakeClient(store, {
      setFault: new HttpClientError(400, 'Unknown search attribute "region"', {
        data: { issues: [] },
      }),
    });
    const { container, findByLabelText, getByRole, findByText, findByRole } = renderPanel(client);

    await findByText('us-east');
    await fireEvent.click(getByRole('button', { name: 'Edit region' }));
    await fireEvent.input(await findByLabelText('region'), { target: { value: 'eu-central' } });
    await fireEvent.click(getByRole('button', { name: 'Save region' }));

    const alert = await findByRole('alert');
    expect(alert.querySelector('.weft-workflow-detail__fault-banner')).not.toBeNull();
    expect(alert.textContent).toContain('Unknown search attribute "region"');
    // The value on the page is still the one the run holds.
    expect(rowFor(container, 'region').textContent).toContain('us-east');
    expect(store['region']).toBe('us-east');
  });

  test('shows a fault from reading the attributes in the fault banner', async () => {
    const client: AttributesClient = {
      operations: {
        'weft.workflows.attributes.get': async () => {
          throw new HttpClientError(500, 'Internal server error');
        },
        'weft.workflows.attributes.set': async () => ({ ok: true as const }),
      },
    };
    const { findByRole, container } = renderPanel(client);

    const alert = await findByRole('alert');
    expect(alert.querySelector('.weft-workflow-detail__fault-banner')).not.toBeNull();
    expect(container.querySelector('[data-state="error"]')).not.toBeNull();
  });
});
