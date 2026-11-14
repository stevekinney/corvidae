/**
 * Archived chats in the chat list (COR-2285 V5): the list leaves them out of All, Waiting on you and
 * Done, and the Archived segment, in the same control, reads and lists them alone; with none it says
 * there are no archived chats. An archived chat opened by its address opens beside the list without a
 * row in All.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { CHAT_COPY } from '../../app/copy/chat.ts';
import Chats from './chats.svelte';
import { AGENT, bureau, CONTEXT, landAt } from './pages.test-support.ts';
import QueryPage from './query-page.test-harness.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const mount = () => render(QueryPage, { props: { page: Chats } } as never);

const ARCHIVED_AT = '2026-11-03T12:00:00.000Z';
const CURRENT = [
  { ...CONTEXT, id: 'current-1', title: 'Plan the week', archivedAt: null },
  { ...CONTEXT, id: 'current-2', title: 'Draft the newsletter', archivedAt: null },
];
const ARCHIVED = [{ ...CONTEXT, id: 'archived-1', title: 'Old invoices', archivedAt: ARCHIVED_AT }];

/** A Bureau that filters by `archived` as `bureau.contexts.list` does. */
function serveChats(archived: readonly unknown[] = ARCHIVED) {
  const served = bureau({
    'bureau.contexts.list': (params) => {
      if (params['archived'] === 'only') return { contexts: archived, nextOffset: null };
      if (params['archived'] === 'exclude') return { contexts: CURRENT, nextOffset: null };
      return { contexts: [...CURRENT, ...archived], nextOffset: null };
    },
    'bureau.contexts.get': (params) =>
      [...CURRENT, ...ARCHIVED].find((context) => context.id === params['contextId']) ?? CONTEXT,
    'bureau.reviews.list': () => ({ reviews: [] }),
    'bureau.agents.list': () => ({ agents: [AGENT] }),
  });
  restore = served.restore;
  return served;
}

function rowIds(region: HTMLElement): (string | null)[] {
  return [...region.querySelectorAll('[data-chat]')].map((row) => row.getAttribute('data-chat'));
}

function segment(scope: HTMLElement, value: string): HTMLElement {
  const found = scope.querySelector<HTMLElement>(`[data-cinder-segment-value="${value}"]`);
  if (found === null) throw new Error(`No ${value} segment.`);
  return found;
}

describe('the chat list and archived chats', () => {
  test('leaves archived chats out by default, and reads no archived list until it is chosen', async () => {
    const served = serveChats();
    landAt('/chats');

    const { findByRole } = mount();
    const region = await findByRole('region', { name: 'Chats' });
    await waitFor(() => expect(rowIds(region)).toEqual(['current-1', 'current-2']));

    const lists = served.calls.filter((call) => call.method === 'bureau.contexts.list');
    expect(lists.map((call) => call.params['archived'])).toEqual(['exclude']);
  });

  test('Archived, in the status control, lists the archived chats alone, and All brings the rest back', async () => {
    const served = serveChats();
    landAt('/chats');
    const { findByRole } = mount();
    const region = await findByRole('region', { name: 'Chats' });
    await waitFor(() => expect(rowIds(region)).toHaveLength(2));

    const control = within(region).getByRole('radiogroup', { name: 'Status' });
    const archived = within(control).getByRole('radio', { name: CHAT_COPY.list.segments.archived });
    await fireEvent.click(archived);

    await waitFor(() => expect(rowIds(region)).toEqual(['archived-1']));
    const request = served.calls.find(
      (call) => call.method === 'bureau.contexts.list' && call.params['archived'] === 'only',
    );
    expect(request?.params).toEqual({ origin: 'chat', archived: 'only', limit: 20, offset: 0 });

    await fireEvent.click(segment(region, 'all'));
    await waitFor(() => expect(rowIds(region)).toEqual(['current-1', 'current-2']));
  });

  test('says there are no archived chats when there are none, and Show all chats goes back', async () => {
    serveChats([]);
    landAt('/chats');
    const { findByRole } = mount();
    const region = await findByRole('region', { name: 'Chats' });
    await waitFor(() => expect(rowIds(region)).toHaveLength(2));

    await fireEvent.click(segment(region, 'archived'));

    const empty = CHAT_COPY.list.segmentEmpty.archived;
    const title = await findByRole('heading', { level: 3, name: empty.title });
    const state = title.closest('.cinder-empty-state') as HTMLElement;
    expect(within(state).getByText(empty.description)).not.toBeNull();
    await fireEvent.click(within(state).getByRole('button', { name: CHAT_COPY.list.showAll }));
    await waitFor(() => expect(rowIds(region)).toHaveLength(2));
  });

  test('opens an archived chat by its address beside the list, with no row for it in All', async () => {
    serveChats();
    landAt('/chats/archived-1');

    const { findByRole, container } = mount();

    const region = await findByRole('region', { name: 'Chats' });
    // The pane's own heading names the archived chat. The page is large, so it is read by selector.
    await waitFor(() =>
      expect(container.querySelector('h1')?.textContent?.trim()).toBe('Old invoices'),
    );
    await waitFor(() => expect(rowIds(region)).toEqual(['current-1', 'current-2']));
    // The status segments count only the chats that are not archived.
    expect(segment(region, 'all').textContent).toContain('2');
  });
});
