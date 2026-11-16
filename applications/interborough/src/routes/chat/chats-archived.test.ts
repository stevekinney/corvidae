/**
 * Archived chats in the chat list (COR-2285 V5, owner decision 2026-11-14): the list leaves them out
 * of All, Waiting on you and Done, and while any chat is archived one Archived chats row at the end of
 * the list opens them as a view of the same pane (`?view=archived`), with Chats as the way back. The
 * view's search searches the archived chats; with none it says so and goes back. An archived chat
 * opened by its address opens beside the list without a row in All.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { CHAT_COPY } from '../../app/copy/chat.ts';
import { router } from '../../lib/router.svelte.ts';
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

const LIST = CHAT_COPY.list;
const ARCHIVED_AT = '2026-11-03T12:00:00.000Z';
const CURRENT = [
  { ...CONTEXT, id: 'current-1', title: 'Plan the week', archivedAt: null },
  { ...CONTEXT, id: 'current-2', title: 'Draft the newsletter', archivedAt: null },
];
const ARCHIVED = [
  { ...CONTEXT, id: 'archived-1', title: 'Old invoices', archivedAt: ARCHIVED_AT },
  { ...CONTEXT, id: 'archived-2', title: 'Last year’s budget', archivedAt: ARCHIVED_AT },
];

/** A Bureau that filters by `archived` and cuts pages by `limit`, as `bureau.contexts.list` does. */
function serveChats(options: { current?: readonly unknown[]; archived?: readonly unknown[] } = {}) {
  const current = options.current ?? CURRENT;
  const archived = options.archived ?? ARCHIVED;
  const served = bureau({
    'bureau.contexts.list': (params) => {
      const contexts =
        params['archived'] === 'only'
          ? archived
          : params['archived'] === 'exclude'
            ? current
            : [...current, ...archived];
      const limit = typeof params['limit'] === 'number' ? params['limit'] : contexts.length;
      return { contexts: contexts.slice(0, limit), nextOffset: null };
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

function archivedEntry(region: HTMLElement): HTMLAnchorElement | null {
  return region.querySelector<HTMLAnchorElement>('[data-chats-archived-entry] a[href]');
}

async function openList(path = '/chats') {
  landAt(path);
  const view = mount();
  const region = await view.findByRole('region', { name: CHAT_COPY.sessionsTitle });
  return { ...view, region };
}

describe('the chat list and archived chats', () => {
  test('leaves archived chats out, asks once whether any is archived, and reads no archived list', async () => {
    const served = serveChats();
    const { region } = await openList();
    await waitFor(() => expect(rowIds(region)).toEqual(['current-1', 'current-2']));

    const lists = served.calls.filter((call) => call.method === 'bureau.contexts.list');
    expect(lists.map((call) => call.params)).toEqual(
      expect.arrayContaining([
        { origin: 'chat', archived: 'exclude', limit: 20, offset: 0 },
        { origin: 'chat', archived: 'only', limit: 1 },
      ]),
    );
    expect(lists).toHaveLength(2);
  });

  test('ends with one Archived chats row, after the last chat, while a chat is archived', async () => {
    serveChats();
    const { region } = await openList();
    await waitFor(() => expect(archivedEntry(region)).not.toBeNull());

    const entry = archivedEntry(region)!;
    expect(entry.textContent?.trim()).toBe(LIST.archivedTitle);
    expect(entry.getAttribute('href')).toBe('/chats?view=archived');
    // It is the last thing in the list: after the last chat's row.
    const lastChat = region.querySelector('[data-chat="current-2"]')!;
    expect(lastChat.compareDocumentPosition(entry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(region.querySelector('[data-chats-archived-entry] svg')).not.toBeNull();
    // No grey chip and no count: whole words.
    expect(region.querySelector('[data-chats-archived-entry] .cinder-badge')).toBeNull();
  });

  test('draws no Archived chats row when no chat is archived', async () => {
    serveChats({ archived: [] });
    const { region } = await openList();
    await waitFor(() => expect(rowIds(region)).toHaveLength(2));

    expect(archivedEntry(region)).toBeNull();
  });

  test('draws the row under the empty state when every chat is archived', async () => {
    serveChats({ current: [] });
    const { region, findByRole } = await openList();

    const title = await findByRole('heading', { level: 3, name: LIST.emptyTitle });
    await waitFor(() => expect(archivedEntry(region)).not.toBeNull());
    expect(
      title.compareDocumentPosition(archivedEntry(region)!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('opens the archived chats in the same pane, with Chats as the way back, and the focus on it', async () => {
    serveChats();
    const { region } = await openList();
    await waitFor(() => expect(archivedEntry(region)).not.toBeNull());

    await fireEvent.click(archivedEntry(region)!);

    expect(router.current.search.get('view')).toBe('archived');
    await waitFor(() => expect(rowIds(region)).toEqual(['archived-1', 'archived-2']));
    expect(within(region).getByRole('heading', { name: LIST.archivedTitle })).not.toBeNull();
    // The status segments count the chats that are not archived, so the view has none.
    expect(within(region).queryByRole('radiogroup', { name: LIST.segmentsLabel })).toBeNull();
    const back = within(region).getByRole('link', { name: LIST.backToChats });
    expect(back.textContent?.trim()).toBe(CHAT_COPY.sessionsTitle);
    expect(document.activeElement === back).toBe(true);
    // Each archived chat opens as any chat does, and keeps the view.
    expect(region.querySelector('[data-chat="archived-1"] a[href]')?.getAttribute('href')).toBe(
      '/chats/archived-1?view=archived',
    );
    expect(archivedEntry(region)).toBeNull();

    await fireEvent.click(back);

    expect(router.current.search.get('view')).toBeNull();
    await waitFor(() => expect(rowIds(region)).toEqual(['current-1', 'current-2']));
    await waitFor(() => expect(archivedEntry(region)).not.toBeNull());
    expect(document.activeElement === archivedEntry(region)).toBe(true);
  });

  test('searches the archived chats in their view', async () => {
    serveChats();
    const { region } = await openList('/chats?view=archived');
    await waitFor(() => expect(rowIds(region)).toEqual(['archived-1', 'archived-2']));

    await fireEvent.input(within(region).getByRole('searchbox', { name: LIST.searchLabel }), {
      target: { value: 'budget' },
    });

    await waitFor(() => expect(rowIds(region)).toEqual(['archived-2']));
  });

  test('says there are no archived chats when there are none, and goes back', async () => {
    serveChats({ archived: [] });
    const { region, findByRole } = await openList('/chats?view=archived');

    const title = await findByRole('heading', { level: 3, name: LIST.archivedEmpty.title });
    const state = title.closest('.cinder-empty-state') as HTMLElement;
    expect(within(state).getByText(LIST.archivedEmpty.description)).not.toBeNull();
    await fireEvent.click(within(state).getByRole('link', { name: LIST.archivedEmpty.back }));

    expect(router.current.search.get('view')).toBeNull();
    await waitFor(() => expect(rowIds(region)).toEqual(['current-1', 'current-2']));
  });

  test('opens an archived chat by its address beside the list, with no row for it in All', async () => {
    serveChats();
    const { region, container } = await openList('/chats/archived-1');

    // The pane's own heading names the archived chat. The page is large, so it is read by selector.
    await waitFor(() =>
      expect(container.querySelector('h1')?.textContent?.trim()).toBe('Old invoices'),
    );
    await waitFor(() => expect(rowIds(region)).toEqual(['current-1', 'current-2']));
    // The status segments count only the chats that are not archived.
    expect(region.querySelector('[data-cinder-segment-value="all"]')?.textContent).toContain('2');
  });
});
