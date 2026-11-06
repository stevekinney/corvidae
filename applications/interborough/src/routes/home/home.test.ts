/**
 * The page at `/` (design rows 01a to 01k, 01s to 01v): its heading is Cinder's `visually-hidden`
 * wrapper, so the page shows no heading of its own and a screen reader still finds "Home"; the
 * date line leads; four counts; the reviews waiting on you and the problems that need attention,
 * each in its own card, and the box that starts a chat. The Bureau answers as the sample world does
 * (`home-test-support.test-support.ts`), and each test changes what it is about.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { Window } from 'happy-dom';

import { router } from '../../lib/router.svelte.ts';
import { chooseOption, shownLabel } from '../chat/listbox.test-support.ts';
import { takeFirstMessage } from '../chat/new-chat-handoff.ts';
import HomeHarness from './home-test-harness.test-harness.svelte';
import {
  HOME_NOW,
  installHome,
  sampleHomeWorld,
  type HomeWorld,
  type InstalledHome,
} from './home-test-support.test-support.ts';

let installed: InstalledHome | undefined;

beforeAll(() => {
  // The date line and the times read the viewer's zone, which the board draws as Central time.
  process.env['TZ'] = 'America/Chicago';
});

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  setSystemTime(new Date(HOME_NOW));
});

afterEach(() => {
  cleanup();
  installed?.restore();
  installed = undefined;
  setSystemTime();
});

function open(world: HomeWorld = sampleHomeWorld()) {
  installed = installHome(world);
  return render(HomeHarness, { props: { client: installed.client } } as never);
}

/** The text of a card's rows, after the rows have been read. */
function cardOf(container: HTMLElement, title: string): HTMLElement {
  const card = container.querySelector<HTMLElement>(`[data-home-card="${title}"]`);
  if (card === null) throw new Error(`no ${title} card`);
  return card;
}

describe('Home', () => {
  test('has one level-one heading, visually hidden, which says Home, and the date line leads (01b, 01c)', async () => {
    const { getByRole, getByTestId } = open();
    const heading = getByRole('heading', { level: 1, name: 'Home' });
    expect(heading.classList.contains('cinder-sr-only')).toBe(true);
    expect(getByTestId('home-date').textContent?.trim()).toBe(
      'Monday, Nov 2 · Times show in Central time (CST)',
    );
    expect(getByRole('heading', { level: 1 })).toBe(heading);
  });

  test('says four counts under the labels Health uses: 0, 2, 0 and 4 (01d)', async () => {
    const { getByTestId } = open();
    const counts = getByTestId('home-counts');
    await waitFor(() => {
      const stats = [...counts.querySelectorAll('.cinder-statistic')].map((stat) =>
        stat.textContent?.replaceAll(/\s+/g, ' ').trim(),
      );
      expect(stats).toEqual([
        'Running now 0',
        'Needs you 2',
        'Failed in 24 hours 0',
        'Missed schedule runs (7 days) 4',
      ]);
    });
    // A dot stands only before a non-zero bad count.
    const dotted = [...counts.querySelectorAll('.cinder-statistic')]
      .filter((stat) => stat.hasAttribute('data-cinder-attention'))
      .map(
        (stat) => stat.textContent?.includes('Needs you') || stat.textContent?.includes('Missed'),
      );
    expect(dotted).toEqual([true, true]);
  });

  test('counts the runs that are going, and never one waiting on a review', async () => {
    const world = sampleHomeWorld();
    world.world.tasks = [
      {
        id: 'run-going',
        contextId: 'c1',
        agentName: 'assistant',
        owner: 'anonymous:local',
        actor: null,
        kind: 'chat',
        status: 'working',
        finishReason: null,
        statusMessage: null,
        createdAt: '2026-11-02T10:44:00-06:00',
        updatedAt: '2026-11-02T10:44:00-06:00',
        cleanup: null,
        openWaits: [],
      },
      {
        id: 'run-parked',
        contextId: 'c2',
        agentName: 'assistant',
        owner: 'anonymous:local',
        actor: null,
        kind: 'chat',
        status: 'input-required',
        finishReason: null,
        statusMessage: null,
        createdAt: '2026-11-02T10:44:00-06:00',
        updatedAt: '2026-11-02T10:44:00-06:00',
        cleanup: null,
        openWaits: [],
      },
    ];
    const { getByTestId } = open(world);
    await waitFor(() =>
      expect(getByTestId('home-counts').textContent?.replaceAll(/\s+/g, ' ')).toContain(
        'Running now 1',
      ),
    );
  });

  test('says a count it cannot read as a dash, leaves the others alone, and never claims all is well', async () => {
    const { container, getByTestId } = open(sampleHomeWorld({ attentionRefused: true }));
    await waitFor(() => {
      const stats = [...getByTestId('home-counts').querySelectorAll('.cinder-statistic')].map(
        (stat) => stat.textContent?.replaceAll(/\s+/g, ' ').trim(),
      );
      expect(stats).toEqual([
        'Running now 0',
        'Needs you 2',
        'Failed in 24 hours 0',
        'Missed schedule runs (7 days) —',
      ]);
    });
    // Needs attention could not be read, so it says nothing about the host being fine.
    expect(container.querySelector('[data-testid="attention-clear"]')).toBeNull();
  });

  test('lists the reviews waiting on you, oldest first, with the button that opens each (01f, 01g)', async () => {
    const { container } = open();
    const card = cardOf(container, 'Needs you');
    await waitFor(() => expect(within(card).getAllByRole('listitem')).toHaveLength(2));
    const rows = within(card).getAllByRole('listitem');
    const text = (row: HTMLElement) => row.textContent?.replaceAll(/\s+/g, ' ').trim();
    expect(text(rows[0]!)).toContain('Which environment should the release go to?');
    expect(text(rows[0]!)).toContain('Question · Request human input · 1 h ago');
    expect(within(rows[0]!).getByRole('link', { name: 'Answer' }).getAttribute('href')).toBe(
      '/reviews?review=bureau%3Ahuman-wait%3Arelease',
    );
    expect(text(rows[1]!)).toContain('Refund order 4471 for $42.00?');
    expect(text(rows[1]!)).toContain('Approval · Tool runner · Can’t be undone · 4 min ago');
    expect(within(rows[1]!).getByRole('link', { name: 'Review' })).not.toBeNull();
    expect(within(card).getByRole('link', { name: 'Open Reviews' }).getAttribute('href')).toBe(
      '/reviews',
    );
  });

  test('opens a review inside the application when its button is clicked', async () => {
    const { container } = open();
    const card = cardOf(container, 'Needs you');
    const answer = await within(card).findByRole('link', { name: 'Answer' });
    await fireEvent.click(answer);
    expect(router.current.route?.pattern).toBe('/reviews');
    expect(router.search.get('review')).toBe('bureau:human-wait:release');
  });

  test('lists the problems that need attention, storage first and the provider last (01h, 01i, 01j)', async () => {
    const { container } = open();
    const card = cardOf(container, 'Needs attention');
    await waitFor(() => expect(within(card).getAllByRole('listitem')).toHaveLength(3));
    const titles = within(card)
      .getAllByRole('listitem')
      .map((row) => row.textContent?.replaceAll(/\s+/g, ' ').trim());
    expect(titles[0]).toContain('Storage is over its warning level');
    expect(titles[0]).toContain('1.6 GB used');
    expect(titles[1]).toContain('Daily summary missed 4 runs since Oct 30');
    // The schedule's agent and cadence arrive once the schedules are read.
    await waitFor(() =>
      expect(
        within(card).getAllByRole('listitem')[1]?.textContent?.replaceAll(/\s+/g, ' '),
      ).toContain('Schedule · Assistant · Every day at 3:00 AM (9:00 AM UTC)'),
    );
    expect(titles[2]).toContain('No model provider connected');
    expect(within(card).getByRole('link', { name: 'Open Health' }).getAttribute('href')).toBe(
      '/health',
    );
    // The provider notice is the third row alone: no banner or alert says it again.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain('Connect a model provider to chat');
  });

  test('has two rows under Needs attention when the host has no storage rule (01i)', async () => {
    const world = sampleHomeWorld({
      attention: sampleHomeWorld().attention.filter((item) => item.kind !== 'alert'),
    });
    const { container } = open(world);
    const card = cardOf(container, 'Needs attention');
    await waitFor(() => expect(within(card).getAllByRole('listitem')).toHaveLength(2));
    expect(card.textContent).not.toContain('Storage is over its warning level');
  });

  test('lists the chats last in, with the status, the latest message and the time (01l)', async () => {
    const { container } = open();
    const card = cardOf(container, 'Recent chats');
    await waitFor(() => expect(within(card).getAllByRole('listitem')).toHaveLength(3));
    const rows = within(card)
      .getAllByRole('listitem')
      .map((row) => row.textContent?.replaceAll(/\s+/g, ' ').trim());
    expect(rows[0]).toContain('Waiting on you');
    expect(rows[0]).toContain('Please refund order 4471, it arrived damaged.');
    // A chat that waits on you says the question it asks.
    expect(rows[0]).toContain('Refund order 4471 for $42.00?');
    expect(rows[0]).toContain('10:42 AM');
    expect(rows[1]).toContain('Which environment should the release go to?');
    expect(rows[2]).toContain('Done');
    expect(rows[2]).toContain('Yesterday, 4:12 PM');
    expect(
      within(card)
        .getAllByRole('link', { name: /Say hello/ })[0]
        ?.getAttribute('href'),
    ).toBe('/chats/chat-hello');
  });

  test('opens a chat inside the application when its row is clicked', async () => {
    const { container } = open();
    const card = cardOf(container, 'Recent chats');
    const link = await within(card).findByRole('link', { name: /Say hello/ });
    await fireEvent.click(link);
    expect(router.current.route?.pattern).toBe('/chats/:chat');
  });
});

describe('Home with nothing waiting on you and a provider connected', () => {
  const calm = () => {
    const base = sampleHomeWorld();
    return sampleHomeWorld({
      world: { ...base.world, reviews: [] },
      attention: [],
      providerConnected: true,
      chats: base.chats.map((chat, index) => ({
        ...chat,
        activity: 'idle' as const,
        lastMessagePreview:
          [
            'You approved it. Refunded $42.00 to the original payment method.',
            'You answered Staging.',
            'Hello! How can I help?',
          ][index] ?? chat.lastMessagePreview,
      })),
    });
  };

  test('reads zero everywhere, with no dots (01s)', async () => {
    const { getByTestId } = open(calm());
    const counts = getByTestId('home-counts');
    await waitFor(() => {
      const stats = [...counts.querySelectorAll('.cinder-statistic')].map((stat) =>
        stat.textContent?.replaceAll(/\s+/g, ' ').trim(),
      );
      expect(stats).toEqual([
        'Running now 0',
        'Needs you 0',
        'Failed in 24 hours 0',
        'Missed schedule runs (7 days) 0',
      ]);
    });
    expect(counts.querySelector('[data-cinder-attention]')).toBeNull();
  });

  test('says nothing is waiting on you, with the link to Reviews at the end of its line (01t)', async () => {
    const { container } = open(calm());
    const card = cardOf(container, 'Needs you');
    const empty = await within(card).findByRole('group', { name: 'Nothing is waiting on you' });
    expect(empty.textContent).toContain('Approvals and questions from your agents show up here.');
    expect(empty.getAttribute('data-cinder-layout')).toBe('row');
    expect(within(empty).getByRole('link', { name: 'Open Reviews' }).getAttribute('href')).toBe(
      '/reviews',
    );
    // The link is in the line, not also in the title row.
    expect(within(card).getAllByRole('link', { name: 'Open Reviews' })).toHaveLength(1);
  });

  test('collapses Needs attention to one line with the link to Health (01u)', async () => {
    const { container, getByTestId } = open(calm());
    const line = await waitFor(() => getByTestId('attention-clear'));
    expect(line.textContent?.replaceAll(/\s+/g, ' ').trim()).toBe(
      'Nothing needs attention · Storage, schedules, providers and hooks are fine. Open Health',
    );
    expect(within(line).getByRole('link', { name: 'Open Health' }).getAttribute('href')).toBe(
      '/health',
    );
    expect(container.querySelector('[data-home-card="Needs attention"]')).toBeNull();
  });

  test('says each chat Done, with what happened on line two (01v)', async () => {
    const { container } = open(calm());
    const card = cardOf(container, 'Recent chats');
    await waitFor(() => expect(within(card).getAllByRole('listitem')).toHaveLength(3));
    const rows = within(card)
      .getAllByRole('listitem')
      .map((row) => row.textContent?.replaceAll(/\s+/g, ' ').trim());
    for (const row of rows) expect(row).toContain('Done');
    expect(rows[0]).toContain('You approved it. Refunded $42.00 to the original payment method.');
    expect(rows[0]).toContain('10:42 AM');
    expect(rows[1]).toContain('You answered Staging.');
    expect(rows[1]).toContain('9:46 AM');
    expect(rows[2]).toContain('Hello! How can I help?');
    expect(rows[2]).toContain('Yesterday, 4:12 PM');
  });
});

describe('Home’s Start a chat card (01k)', () => {
  test('has a message box, a ghost Agent select that reads Assistant, and a live Send', async () => {
    const { getByTestId } = open();
    const card = getByTestId('home-start-chat');
    expect(card.querySelector('textarea')?.getAttribute('placeholder')).toBe(
      'Ask an agent to do something',
    );
    await waitFor(() => expect(shownLabel(card)).toContain('Assistant'));
    expect(card.querySelector('[data-cinder-variant="ghost"]')).not.toBeNull();
    const send = within(card).getByRole('button', { name: 'Send' });
    expect(send.getAttribute('data-cinder-variant')).toBe('primary');
    expect(send.querySelector('svg')).not.toBeNull();
    expect((send as HTMLButtonElement).disabled).toBe(false);
    // Assistant is scripted, so Send is live with no provider connected.
    expect(card.textContent).not.toContain('Connect a model provider');
  });

  test('Send opens New chat with the agent and the typed message', async () => {
    const { getByTestId } = open();
    const card = getByTestId('home-start-chat');
    await waitFor(() => expect(shownLabel(card)).toContain('Assistant'));
    const box = card.querySelector('textarea');
    if (box === null) throw new Error('no message box');
    await fireEvent.input(box, { target: { value: 'What did I approve yesterday?' } });
    await fireEvent.click(within(card).getByRole('button', { name: 'Send' }));
    expect(router.current.route?.pattern).toBe('/chats/new');
    expect(router.search.get('agent')).toBe('assistant');
    // The message is handed to the chat apart from the address, so no link can send it.
    expect(router.search.has('message')).toBe(false);
    expect(takeFirstMessage('assistant')).toBe('What did I approve yesterday?');
  });

  test('Send with nothing typed opens New chat with the agent alone', async () => {
    const { getByTestId } = open();
    const card = getByTestId('home-start-chat');
    await waitFor(() => expect(shownLabel(card)).toContain('Assistant'));
    await fireEvent.click(within(card).getByRole('button', { name: 'Send' }));
    expect(router.current.route?.pattern).toBe('/chats/new');
    expect(router.search.get('agent')).toBe('assistant');
    expect(router.search.has('message')).toBe(false);
    expect(takeFirstMessage('assistant')).toBeUndefined();
  });

  test('a model agent with no provider replaces the box with the blocked row, and Use Assistant switches back', async () => {
    const { getByTestId } = open();
    const card = getByTestId('home-start-chat');
    await waitFor(() => expect(shownLabel(card)).toContain('Assistant'));
    await chooseOption(card, 'Tool runner', 'home-start-chat-agent');
    const blocked = await waitFor(() => {
      const row = card.querySelector('[data-chat-composer-status="blocked"]');
      if (row === null) throw new Error('the blocked row is not drawn');
      return row;
    });
    expect(blocked.textContent).toContain('Connect a model provider to chat');
    expect(card.querySelector('textarea')).toBeNull();
    expect(
      within(card).getByRole('link', { name: 'Connect a provider' }).getAttribute('href'),
    ).toBe('/settings/models');
    await fireEvent.click(within(card).getByRole('button', { name: 'Use Assistant' }));
    await waitFor(() => expect(card.querySelector('textarea')).not.toBeNull());
    expect(card.querySelector('[data-chat-composer-status="blocked"]')).toBeNull();
  });

  test('a model agent is not blocked once a provider holds a key', async () => {
    const { getByTestId } = open(sampleHomeWorld({ providerConnected: true }));
    const card = getByTestId('home-start-chat');
    await waitFor(() => expect(shownLabel(card)).toContain('Assistant'));
    await chooseOption(card, 'Tool runner', 'home-start-chat-agent');
    await waitFor(() => expect(shownLabel(card)).toContain('Tool runner'));
    expect(card.querySelector('[data-chat-composer-status="blocked"]')).toBeNull();
    expect(card.querySelector('textarea')).not.toBeNull();
  });
});
