/**
 * The chat list's own header and states (design rows 16c, 16f, 16g, 17u to 17x, 11g, 11h): the
 * title with its secondary "+", the search and the status segments, the day bands, and each state
 * of the list (first use, no results, loading, failing) read inside the pane while the rest of the
 * page stays live.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { dateLine, viewerTimeZone, zoneLabel } from '../../lib/format/clock.ts';
import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
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

const NOW = Date.now();
const HOUR = 3_600_000;
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();

/** Four chats as the sample world has them: two waiting, one done, one ended, on three days. */
const CHATS = [
  {
    ...CONTEXT,
    id: 'refund',
    title: 'Please refund order 4471, it arrived damaged.',
    agentName: 'tool-runner',
    lastMessagePreview: 'I found order 4471 ($42.00). I need your approval to refund it.',
    activity: 'awaiting-input',
    updatedAt: at(0),
  },
  {
    ...CONTEXT,
    id: 'release',
    title: 'Ship the release notes fix.',
    agentName: 'request-human-input',
    lastMessagePreview: 'Which environment should the release go to?',
    activity: 'awaiting-input',
    updatedAt: at(1),
  },
  {
    ...CONTEXT,
    id: 'hello',
    title: 'Say hello',
    agentName: 'assistant',
    lastMessagePreview: 'Hello! How can I help?',
    updatedAt: at(24),
  },
  {
    ...CONTEXT,
    id: 'billing',
    title: 'Rename the billing tables',
    agentName: 'tool-runner',
    lastMessagePreview: 'Rename the billing tables',
    endReason: 'host-stopped',
    updatedAt: at(72),
  },
];

function serveChats() {
  const served = bureau({
    'bureau.contexts.list': () => ({ contexts: CHATS, nextOffset: null }),
    'bureau.reviews.list': () => ({ reviews: [] }),
    'bureau.agents.list': () => ({ agents: [AGENT] }),
  });
  restore = served.restore;
  return served;
}

/** The segment of the status control with this value. */
function segment(scope: HTMLElement, value: string): HTMLElement {
  const found = scope.querySelector<HTMLElement>(`[data-cinder-segment-value="${value}"]`);
  if (found === null) throw new Error(`No ${value} segment.`);
  return found;
}

async function list() {
  const result = mount();
  const region = await result.findByRole('region', { name: 'Chats' });
  await waitFor(() => expect(region.querySelectorAll('[data-chat]')).toHaveLength(4));
  return { ...result, region };
}

describe('the pane header', () => {
  test('is "Chats" with a secondary "+" named New chat, then a Search chats field (16c)', async () => {
    serveChats();
    landAt('/chats');

    const { region, findByRole } = await list();

    const heading = await findByRole('heading', { level: 1 });
    expect(heading.textContent?.trim()).toBe('Chats');
    const header = region.querySelector('header') as HTMLElement;
    const plus = within(header).getByRole('link', { name: 'New chat' });
    expect(plus.getAttribute('href')).toBe('/chats/new');
    expect(plus.getAttribute('data-cinder-variant')).toBe('secondary');
    expect(plus.textContent?.trim()).toBe('');
    // The tooltip says the same words as the accessible name.
    const tooltips = within(header).getAllByRole('tooltip', { hidden: true });
    expect(tooltips.map((tooltip) => tooltip.textContent?.trim())).toContain('New chat');
    // With no chat open the list is all there is, so it offers no toggle to hide it (COR-2327).
    expect(within(header).queryByRole('button', { name: 'Hide chats' })).toBeNull();
    // The field is below the title row, not beside it.
    const field = within(header).getByRole('searchbox', { name: 'Search chats' });
    expect(plus.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('has status segments that count every chat: All 4, Waiting on you 2, Done 1; Ended is in All only (11g)', async () => {
    serveChats();
    landAt('/chats');

    const { region } = await list();

    const segments = within(region).getByRole('radiogroup', { name: 'Status' });
    expect(
      [...segments.querySelectorAll('[role="radio"]')].map((segment) =>
        segment.textContent?.replaceAll(/\s+/g, ' ').replace(/ ?, ?/, ', ').trim(),
      ),
    ).toEqual(['All, 4', 'Waiting on you, 2', 'Done, 1']);
  });

  test('narrows the list to the segment chosen, and back to All', async () => {
    serveChats();
    landAt('/chats');
    const { region } = await list();

    await fireEvent.click(segment(region, 'waiting'));
    await waitFor(() => expect(region.querySelectorAll('[data-chat]')).toHaveLength(2));
    expect(
      [...region.querySelectorAll('[data-chat]')].map((row) => row.getAttribute('data-chat')),
    ).toEqual(['refund', 'release']);

    await fireEvent.click(segment(region, 'done'));
    await waitFor(() => expect(region.querySelectorAll('[data-chat]')).toHaveLength(1));
    expect(region.querySelector('[data-chat="hello"]')).not.toBeNull();

    await fireEvent.click(segment(region, 'all'));
    await waitFor(() => expect(region.querySelectorAll('[data-chat]')).toHaveLength(4));
  });
});

describe('the rows (16f, 16g, 11h)', () => {
  test('lead line two with the status word: Waiting on you with the question, Done, and Ended, a chat-only word', async () => {
    serveChats();
    landAt('/chats');

    const { region } = await list();

    const row = (id: string) => region.querySelector(`[data-chat="${id}"]`)?.textContent ?? '';
    expect(row('refund')).toContain('Waiting on you');
    expect(row('refund')).toContain(
      'I found order 4471 ($42.00). I need your approval to refund it.',
    );
    expect(row('release')).toContain('Waiting on you');
    expect(row('hello')).toContain('Done');
    expect(row('hello')).toContain('Hello! How can I help?');
    expect(row('billing')).toContain('Ended');
    expect(row('billing')).toContain('The server restarted before I finished.');
    // The agent that said it rides in the row's tooltip; a narrow pane has no room to print it.
    expect(
      region.querySelector('[data-chat="refund"] .cinder-stacked-list-item__meta-text')
        ?.textContent ?? '',
    ).not.toContain('Tool runner');
  });

  test('sit under day bands that name the day and the zone the times are in', async () => {
    serveChats();
    landAt('/chats');

    const { region } = await list();

    const zone = viewerTimeZone();
    const bands = [...region.querySelectorAll('.cinder-data-list-group__header')].map((band) =>
      band.textContent?.replaceAll(/\s+/g, ' ').trim(),
    );
    const zoneName = zoneLabel(NOW, zone);
    expect(bands).toEqual([
      `Today ${zoneName}`,
      `Yesterday, ${dateLine(NOW - 24 * HOUR, zone)} ${zoneName}`,
      `${dateLine(NOW - 72 * HOUR, zone)} ${zoneName}`,
    ]);
  });
});

describe('searching', () => {
  test('narrows the list by title, message or agent, and says what was searched when nothing matches (17v)', async () => {
    serveChats();
    landAt('/chats');
    const { region, findByRole } = await list();
    const field = within(region).getByRole('searchbox', { name: 'Search chats' });

    await fireEvent.input(field, { target: { value: 'refund' } });
    await waitFor(() => expect(region.querySelectorAll('[data-chat]')).toHaveLength(1));
    expect(region.querySelector('[data-chat="refund"]')).not.toBeNull();

    await fireEvent.input(field, { target: { value: 'parcelly' } });
    const title = await findByRole('heading', { level: 3, name: 'No chats match “parcelly”' });
    const state = title.closest('.cinder-empty-state') as HTMLElement;
    expect(state.textContent).toContain('Check the spelling or try another word.');
    expect(region.querySelectorAll('[data-chat]')).toHaveLength(0);
    // The header stays live, and the one button of the state clears the search.
    expect(within(region).getByRole('searchbox', { name: 'Search chats' })).not.toBeNull();
    await fireEvent.click(within(state).getByRole('button', { name: 'Clear search' }));
    await waitFor(() => expect(region.querySelectorAll('[data-chat]')).toHaveLength(4));
    expect((field as HTMLInputElement).value).toBe('');
  });

  test('says a segment with no chat in it, and Show all chats goes back', async () => {
    const served = bureau({
      'bureau.contexts.list': () => ({ contexts: [CHATS[2]], nextOffset: null }),
      'bureau.reviews.list': () => ({ reviews: [] }),
    });
    restore = served.restore;
    landAt('/chats');
    const { findByRole, findAllByRole } = mount();
    await findAllByRole('link', { name: /Say hello/ });

    await fireEvent.click(
      await findByRole('radiogroup', { name: 'Status' }).then((group) => segment(group, 'waiting')),
    );
    const title = await findByRole('heading', { level: 3, name: 'Nothing is waiting on you' });
    await fireEvent.click(
      within(title.closest('.cinder-empty-state') as HTMLElement).getByRole('button', {
        name: 'Show all chats',
      }),
    );

    await findAllByRole('link', { name: /Say hello/ });
  });
});

describe('the states of the list', () => {
  test('first use is "No chats yet" with the only primary New chat, and the header "+" stays secondary (17u)', async () => {
    const served = bureau({
      'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }),
      'bureau.reviews.list': () => ({ reviews: [] }),
    });
    restore = served.restore;
    landAt('/chats');

    const { findByRole, container } = mount();

    const title = await findByRole('heading', { level: 3, name: 'No chats yet' });
    const state = title.closest('.cinder-empty-state') as HTMLElement;
    expect(state.textContent).toContain('Start one with an agent.');
    expect(
      within(state).getByRole('link', { name: 'New chat' }).getAttribute('data-cinder-variant'),
    ).toBe('primary');
    // Nothing else on the page is a primary: not the "+", and not the pane beside the list.
    expect(container.querySelectorAll('[data-cinder-variant="primary"]')).toHaveLength(1);
    expect(
      container.querySelector('header a[href="/chats/new"]')?.getAttribute('data-cinder-variant'),
    ).toBe('secondary');
    const pane = await findByRole('region', { name: 'Open chat' });
    expect(pane.textContent).toContain('No chat open');
  });

  test('loading is skeleton rows under the live header, after 300 milliseconds (17w)', async () => {
    restore = installFetchImplementation(() => new Promise<Response>(() => {}));
    landAt('/chats');

    const { findByRole, container } = mount();

    const region = await findByRole('region', { name: 'Chats' });
    expect(within(region).getByRole('heading', { level: 1, name: 'Chats' })).not.toBeNull();
    expect(within(region).getByRole('link', { name: 'New chat' })).not.toBeNull();
    // The segments have no counts to give yet, and say so rather than claiming none.
    expect(
      [...region.querySelectorAll('[role="radio"]')].map((segment) =>
        segment.textContent?.replaceAll(/\s+/g, ' ').trim(),
      ),
    ).toEqual(['All, loading–', 'Waiting on you, loading–', 'Done, loading–']);
    // load-proof: the skeleton's own delay is a product rule (nothing before 300 ms); waiting for it to show is waiting for the rule, never for speed
    await waitFor(() => expect(region.querySelector('.cinder-skeleton-list')).not.toBeNull());
    expect(within(region).getByRole('status').textContent).toContain('Loading chats');
    expect(container.querySelectorAll('[data-chat]')).toHaveLength(0);
  });

  test('failing keeps the error in the list with its own Try again, and the pane beside it live (17x)', async () => {
    let healthy = false;
    const served = bureau(
      {
        'bureau.reviews.list': () => ({ reviews: [] }),
        'bureau.contexts.list': () => {
          if (!healthy) throw new Error('The server broke.');
          return { contexts: [CHATS[2]], nextOffset: null };
        },
      },
      undefined,
    );
    restore = served.restore;
    landAt('/chats');

    const { findByRole, findAllByRole } = mount();

    const title = await findByRole('heading', { level: 3, name: 'Couldn’t load chats' });
    const state = title.closest('.cinder-error-state') as HTMLElement;
    expect(state.textContent).toContain('Interborough didn’t send them back.');
    expect(
      within(state).getByRole('button', { name: 'Try again' }).getAttribute('data-cinder-variant'),
    ).toBe('secondary');
    const pane = await findByRole('region', { name: 'Open chat' });
    expect(pane).not.toBeNull();
    // The list is not there to choose from, so the pane does not point at it.
    expect(pane.textContent).not.toContain('Choose a chat from the list');
    expect(within(pane).getByRole('heading', { name: 'No chat open' })).not.toBeNull();
    expect(within(pane).getByRole('link', { name: 'New chat' })).not.toBeNull();
    expect(await findByRole('searchbox', { name: 'Search chats' })).not.toBeNull();

    healthy = true;
    await fireEvent.click(within(state).getByRole('button', { name: 'Try again' }));

    await findAllByRole('link', { name: /Say hello/ });
  });
});

describe('the list on a phone and a modified click', () => {
  test('a phone’s list is its own screen titled Chat, with no search or segments (06l)', async () => {
    serveChats();
    landAt('/chats');
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === '(max-width: 639.98px)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      const { findByRole, queryByRole } = mount();

      const heading = await findByRole('heading', { level: 1 });
      expect(heading.textContent?.trim()).toBe('Chat');
      expect(queryByRole('searchbox', { name: 'Search chats' })).toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });

  test('a modified click is left to the browser, so a row can open in another tab', async () => {
    serveChats();
    landAt('/chats');
    const { region } = await list();
    const link = region.querySelector<HTMLAnchorElement>('a[href^="/chats/"]');
    if (link === null) throw new Error('No row link.');

    const modified = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    link.dispatchEvent(modified);
    expect(modified.defaultPrevented).toBe(false);

    const plain = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(true);
  });

  test('a wide pane names the agent before each row’s message (11g)', async () => {
    serveChats();
    landAt('/chats');
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 600,
    });
    try {
      const { region } = await list();

      const agents = [...region.querySelectorAll('.ib-chat-row__agent')].map((element) =>
        element.textContent?.trim(),
      );
      expect(agents.length).toBeGreaterThan(0);
      expect(agents.every((text) => text?.endsWith(','))).toBe(true);
    } finally {
      if (original === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
      else Object.defineProperty(HTMLElement.prototype, 'clientWidth', original);
    }
  });
});
