/**
 * The page at `/` (design rows 01a to 01k, 01s to 01v): its heading is Cinder's `visually-hidden`
 * wrapper, so the page shows no heading of its own and a screen reader still finds "Home"; the
 * date line leads; four counts; the reviews waiting on you and the problems that need attention,
 * each in its own card, and the box that starts a chat. The Bureau answers as the sample world does
 * (`home-test-support.test-support.ts`), and each test changes what it is about. A new
 * installation (no chat yet) is the first-run checklist (rows 01y to 02b, 13c to 13j, 14c to 14j),
 * and a run that is going is the Running now card (rows 01w, 01x).
 */
import { waitUntil } from '@lostgradient/testing/wait-until';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from 'bun:test';
import { Window } from 'happy-dom';

import { FIRST_RUN_SAID_HELLO_KEY } from '../../app/first-run.ts';
import { contextFixture, taskFixture } from '../../lib/bureau-fixtures.test-support.ts';
import { StubFault } from '../../lib/bureau-stub.test-support.ts';
import { emptyBureauWorld } from '../../lib/bureau-world.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { chooseOption, shownLabel } from '../chat/listbox.test-support.ts';
import { takeFirstMessage } from '../chat/new-chat-handoff.ts';
import HomeHarness from './home-test-harness.test-harness.svelte';
import {
  DAILY_SUMMARY,
  HOME_NOW,
  installHome,
  SAMPLE_ATTENTION,
  sampleHomeWorld,
  type HomeWorld,
  type InstalledHome,
} from './home-test-support.test-support.ts';

let installed: InstalledHome | undefined;

// `bun test` runs in UTC without naming it in `TZ`, so the zone to give back is the one in effect.
const previousZone = process.env['TZ'] ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

beforeAll(() => {
  // The date line and the times read the viewer's zone, which the board draws as Central time.
  process.env['TZ'] = 'America/Chicago';
});

afterAll(() => {
  // The zone is the process's: another file in this worker reads its own.
  process.env['TZ'] = previousZone;
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

/**
 * Opens Home and waits until it is drawn: it draws nothing until the three answers the first-run
 * checklist is made of are in, so the overview is never drawn only to be replaced.
 */
async function open(
  world: HomeWorld = sampleHomeWorld(),
  workspace?: { workspaceId: string; actorId: string },
) {
  installed = installHome(world);
  const rendered = render(HomeHarness, { props: { client: installed.client, workspace } } as never);
  await rendered.findByTestId('home-date');
  return rendered;
}

/** The text of a card's rows, after the rows have been read. */
function cardOf(container: HTMLElement, title: string): HTMLElement {
  const card = container.querySelector<HTMLElement>(`[data-home-card="${title}"]`);
  if (card === null) throw new Error(`no ${title} card`);
  return card;
}

describe('Home', () => {
  test('has one level-one heading, visually hidden, which says Home, and the date line leads (01b, 01c)', async () => {
    const { getByRole, getByTestId } = await open();
    const heading = getByRole('heading', { level: 1, name: 'Home' });
    expect(heading.classList.contains('cinder-sr-only')).toBe(true);
    expect(getByTestId('home-date').textContent?.trim()).toBe(
      'Monday, Nov 2 · Times show in Central time (CST)',
    );
    expect(getByRole('heading', { level: 1 })).toBe(heading);
  });

  test('says four counts under the labels Health uses: 0, 2, 0 and 4 (01d)', async () => {
    const { getByTestId } = await open();
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
    const { getByTestId } = await open(world);
    await waitFor(() =>
      expect(getByTestId('home-counts').textContent?.replaceAll(/\s+/g, ' ')).toContain(
        'Running now 1',
      ),
    );
  });

  test('says a count it cannot read as a dash, leaves the others alone, and never claims all is well', async () => {
    const { container, getByTestId } = await open(sampleHomeWorld({ attentionRefused: true }));
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
    const { container } = await open();
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
    const { container } = await open();
    const card = cardOf(container, 'Needs you');
    const answer = await within(card).findByRole('link', { name: 'Answer' });
    await fireEvent.click(answer);
    expect(router.current.route?.pattern).toBe('/reviews');
    expect(router.search.get('review')).toBe('bureau:human-wait:release');
  });

  test('lists the problems that need attention, storage first and the provider last (01h, 01i, 01j)', async () => {
    const { container } = await open();
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
    const { container } = await open(world);
    const card = cardOf(container, 'Needs attention');
    await waitFor(() => expect(within(card).getAllByRole('listitem')).toHaveLength(2));
    expect(card.textContent).not.toContain('Storage is over its warning level');
  });

  test('lists the chats last in, with the status, the latest message and the time (01l)', async () => {
    const { container } = await open();
    const card = cardOf(container, 'Recent chats');
    await waitFor(() => expect(within(card).getAllByRole('listitem')).toHaveLength(3));
    const rows = within(card)
      .getAllByRole('listitem')
      .map((row) => row.textContent?.replaceAll(/\s+/g, ' ').trim());
    expect(rows[0]).toContain('Waiting on you');
    expect(rows[0]).toContain('Please refund order 4471, it arrived damaged.');
    // A chat that waits on an approval says what the agent said (01l, 16f); one that waits on a
    // question says the question.
    expect(rows[0]).toContain('I found order 4471 ($42.00). I need your approval to refund it.');
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
    const { container } = await open();
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
    const { getByTestId } = await open(calm());
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
    const { container } = await open(calm());
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
    const { container, getByTestId } = await open(calm());
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
    const { container } = await open(calm());
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
    const { getByTestId } = await open();
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
    const { getByTestId } = await open();
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
    const { getByTestId } = await open();
    const card = getByTestId('home-start-chat');
    await waitFor(() => expect(shownLabel(card)).toContain('Assistant'));
    await fireEvent.click(within(card).getByRole('button', { name: 'Send' }));
    expect(router.current.route?.pattern).toBe('/chats/new');
    expect(router.search.get('agent')).toBe('assistant');
    expect(router.search.has('message')).toBe(false);
    expect(takeFirstMessage('assistant')).toBeUndefined();
  });

  test('a model agent with no provider replaces the box with the blocked row, and Use Assistant switches back', async () => {
    const { getByTestId } = await open();
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
    const { getByTestId } = await open(sampleHomeWorld({ providerConnected: true }));
    const card = getByTestId('home-start-chat');
    await waitFor(() => expect(shownLabel(card)).toContain('Assistant'));
    await chooseOption(card, 'Tool runner', 'home-start-chat-agent');
    await waitFor(() => expect(shownLabel(card)).toContain('Tool runner'));
    expect(card.querySelector('[data-chat-composer-status="blocked"]')).toBeNull();
    expect(card.querySelector('textarea')).not.toBeNull();
  });
});

/** A new installation: no chat, no provider, and the sample world's problems left out (they are not a new host's). */
function freshInstallation(overrides: Partial<HomeWorld> = {}): HomeWorld {
  return sampleHomeWorld({
    chats: [],
    attention: [{ kind: 'no-provider', area: 'providers', at: null, provider: null }],
    world: emptyBureauWorld({ reviews: [] }),
    ...overrides,
  });
}

/** The checklist's row for a step, by its title. */
function stepOf(container: HTMLElement, id: 'provider' | 'agent' | 'chat'): HTMLElement {
  const items = [...container.querySelectorAll<HTMLElement>('.cinder-steps__item')];
  const item = items[['provider', 'agent', 'chat'].indexOf(id)];
  if (item === undefined) throw new Error(`no ${id} step`);
  return item;
}

const words = (element: Element) => element.textContent?.replaceAll(/\s+/g, ' ').trim();

describe('Home on a new installation (01y, 01z, 13c, 13d, 13f, 14c, 14d)', () => {
  test('leads with the welcome line and a hidden Home heading, in place of the date line (01z, 13c, 14d)', async () => {
    const { getByRole, getByTestId, queryByText } = await open(freshInstallation());
    expect(getByTestId('home-date').textContent?.trim()).toBe(
      'Welcome. Three steps to your first chat.',
    );
    expect(queryByText(/Times show in/)).toBeNull();
    const heading = getByRole('heading', { level: 1, name: 'Home' });
    expect(heading.classList.contains('cinder-sr-only')).toBe(true);
  });

  test('shows "Get started" reading 0 of 3 done, with the three steps in order (01y, 13f)', async () => {
    const { container, getByRole } = await open(freshInstallation());
    const checklist = getByRole('heading', { level: 2, name: 'Get started' });
    expect(words(checklist.closest('.cinder-steps') as Element)).toContain('0 of 3 done');
    expect(words(stepOf(container, 'provider'))).toBe(
      '1 Connect a provider Agents need a model provider before they can answer. Connect a provider',
    );
    expect(words(stepOf(container, 'agent'))).toBe(
      '2 Create an agent, or start from Assistant Assistant works now; other agents need a provider. Use Assistant Create an agent',
    );
    expect(words(stepOf(container, 'chat'))).toBe(
      '3 Say hello Send a first message to see a chat run end to end. Start a chat',
    );
  });

  test('step 1 holds the only primary button; the others are secondary, and the link is quiet (13g, 01y)', async () => {
    const { container } = await open(freshInstallation());
    const primaries = [...container.querySelectorAll('.cinder-steps .cinder-button')].filter(
      (button) => button.getAttribute('data-cinder-variant') === 'primary',
    );
    expect(primaries.map(words)).toEqual(['Connect a provider']);
    const agent = stepOf(container, 'agent');
    expect(
      within(agent)
        .getByRole('button', { name: 'Use Assistant' })
        .getAttribute('data-cinder-variant'),
    ).toBe('ghost-accent');
    expect(
      within(agent)
        .getByRole('link', { name: 'Create an agent' })
        .getAttribute('data-cinder-variant'),
    ).toBe('secondary');
    expect(
      within(stepOf(container, 'chat'))
        .getByRole('link', { name: 'Start a chat' })
        .getAttribute('data-cinder-variant'),
    ).toBe('secondary');
  });

  test('each button goes where its step is done: Models, a new agent, and New chat with Assistant (02a, 13g, 14c)', async () => {
    const { container } = await open(freshInstallation());
    expect(
      within(stepOf(container, 'provider'))
        .getByRole('link', { name: 'Connect a provider' })
        .getAttribute('href'),
    ).toBe('/settings/models');
    expect(
      within(stepOf(container, 'agent'))
        .getByRole('link', { name: 'Create an agent' })
        .getAttribute('href'),
    ).toBe('/agents/new');
    const start = within(stepOf(container, 'chat')).getByRole('link', { name: 'Start a chat' });
    // Live, not disabled, while steps 1 and 2 are open: Assistant is scripted and needs no provider.
    expect(start.getAttribute('aria-disabled')).toBeNull();
    expect(start.getAttribute('href')).toBe('/chats/new?agent=assistant');
    await fireEvent.click(start);
    expect(router.current.route?.pattern).toBe('/chats/new');
    expect(router.search.get('agent')).toBe('assistant');
  });

  test('hides the counts, Needs you, the composer and the provider row; step 1 stands in for it (01z, 13d, 13j, 14e)', async () => {
    const { container, queryByRole, queryByText } = await open(freshInstallation());
    expect(container.querySelector('[data-testid="home-counts"]')).toBeNull();
    expect(container.querySelector('[data-home-card="Needs you"]')).toBeNull();
    expect(container.querySelector('[data-testid="home-start-chat"]')).toBeNull();
    expect(container.querySelector('[data-home-card="Needs attention"]')).toBeNull();
    expect(container.querySelector('[data-testid="attention-clear"]')).toBeNull();
    expect(queryByText('No model provider connected')).toBeNull();
    // No banner: nothing in the page is an alert.
    expect(queryByRole('alert')).toBeNull();
    expect(queryByText(/Connect a model provider/)).toBeNull();
  });

  test('keeps a problem that is not the provider, under Needs attention (13d)', async () => {
    const { container } = await open(
      freshInstallation({ attention: SAMPLE_ATTENTION, schedules: [DAILY_SUMMARY] }),
    );
    const card = cardOf(container, 'Needs attention');
    await waitFor(() => expect(within(card).getAllByRole('listitem')).toHaveLength(2));
    expect(card.textContent).not.toContain('No model provider connected');
  });

  test('says there are no chats yet under the checklist, with a chat icon and no All chats link (02b, 13h, 14d)', async () => {
    const { container } = await open(freshInstallation());
    const card = cardOf(container, 'Recent chats');
    await waitFor(() =>
      expect(within(card).getByRole('group', { name: 'No chats yet' })).toBeDefined(),
    );
    expect(words(card)).toBe(
      'Recent chats No chats yet Your chats appear here once you send a first message.',
    );
    expect(card.querySelector('.cinder-empty-state-icon svg')).not.toBeNull();
    expect(within(card).queryByRole('link', { name: 'All chats' })).toBeNull();
    expect(within(card).getByRole('heading', { level: 3, name: 'No chats yet' })).toBeDefined();
  });

  test('keys off whether a chat happened, not off the providers: a chat ends the checklist with no provider (14c)', async () => {
    const { container, getByTestId } = await open(sampleHomeWorld());
    expect(container.querySelector('[data-testid="home-first-run"]')).toBeNull();
    expect(getByTestId('home-counts')).toBeDefined();
    // The provider notice is back in Needs attention, where it blocks something.
    await waitFor(() =>
      expect(cardOf(container, 'Needs attention').textContent).toContain(
        'No model provider connected',
      ),
    );
  });

  test('a chat list that cannot be read shows the overview, not a checklist it cannot vouch for', async () => {
    const world = freshInstallation();
    installed = installHome(world);
    installed.stub.on('bureau.contexts.list', () => {
      throw new StubFault('Unavailable', 503, 'Unavailable');
    });
    const { findByTestId, container } = render(HomeHarness, {
      props: { client: installed.client },
    } as never);
    await findByTestId('home-counts');
    expect(container.querySelector('[data-testid="home-first-run"]')).toBeNull();
  });

  test('never returns once a chat happened, even after every chat is deleted', async () => {
    const identity = { workspaceId: 'workspace-home', actorId: 'actor-home' };
    const key = `interborough:identity:${JSON.stringify([identity.workspaceId, identity.actorId])}:${FIRST_RUN_SAID_HELLO_KEY}`;
    window.localStorage.removeItem(key);
    try {
      const first = await open(sampleHomeWorld(), identity);
      await first.findByTestId('home-counts');
      await waitUntil(() => window.localStorage.getItem(key) === 'true');
      cleanup();
      installed?.restore();
      const second = await open(freshInstallation(), identity);
      await second.findByTestId('home-counts');
      expect(second.container.querySelector('[data-testid="home-first-run"]')).toBeNull();
    } finally {
      window.localStorage.removeItem(key);
    }
  });
});

describe('Home’s checklist on a host with no Assistant', () => {
  /** A host whose only agents are ones that need a model: Assistant comes from a plugin or the host. */
  async function withoutAssistant() {
    const world = freshInstallation();
    installed = installHome(world);
    installed.stub.on('bureau.agents.list', () => ({
      agents: [
        {
          name: 'tool-runner',
          displayName: 'tool-runner',
          description: null,
          definitionRevision: 1,
          kind: 'code',
          a2a: false,
          media: { modalities: {}, mimeFamilies: [], mediaLimits: [] },
        },
      ],
    }));
    const rendered = render(HomeHarness, { props: { client: installed.client } } as never);
    await rendered.findByTestId('home-date');
    return rendered;
  }

  test('offers no Use Assistant, and Start a chat opens New chat to pick an agent', async () => {
    const { container } = await withoutAssistant();
    const agent = stepOf(container, 'agent');
    expect(within(agent).queryByRole('button', { name: 'Use Assistant' })).toBeNull();
    expect(within(agent).getByRole('link', { name: 'Create an agent' })).toBeDefined();
    expect(
      within(stepOf(container, 'chat'))
        .getByRole('link', { name: 'Start a chat' })
        .getAttribute('href'),
    ).toBe('/chats/new');
  });
});

describe('Home’s checklist as steps are done (14e, 14j)', () => {
  test('with a provider connected the checklist skips to step 2 and the composer comes back (14e, 14j)', async () => {
    const { container, getByTestId } = await open(freshInstallation({ providerConnected: true }));
    expect(getByTestId('home-date').textContent?.trim()).toBe('Welcome. Two steps left.');
    expect(words(container.querySelector('.cinder-steps') as Element)).toContain('1 of 3 done');
    const provider = stepOf(container, 'provider');
    expect(words(provider)).toContain('Anthropic is connected.');
    expect(provider.getAttribute('data-cinder-state')).toBe('complete');
    expect(within(provider).queryByRole('link')).toBeNull();
    // The current step is now the second, and its main button is the primary one.
    expect(stepOf(container, 'agent').getAttribute('data-cinder-state')).toBe('current');
    expect(
      within(stepOf(container, 'agent'))
        .getByRole('link', { name: 'Create an agent' })
        .getAttribute('data-cinder-variant'),
    ).toBe('primary');
    const card = getByTestId('home-start-chat');
    // It sits under the checklist, in the checklist's own column.
    expect(card.closest('.ib-home__main')).toBe(
      getByTestId('home-first-run').closest('.ib-home__main'),
    );
    expect(card.closest('.ib-home__main')).not.toBeNull();
    expect(
      getByTestId('home-first-run').compareDocumentPosition(card) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(card.querySelector('textarea')).not.toBeNull();
    await waitFor(() => expect(shownLabel(card)).toContain('Assistant'));
    expect((within(card).getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  test('after steps 1 and 2 it says one step left, and Start a chat is primary (14j)', async () => {
    const { container, getByTestId } = await open(
      freshInstallation({ providerConnected: true, fileAgent: true }),
    );
    expect(getByTestId('home-date').textContent?.trim()).toBe('Welcome. One step left.');
    expect(words(container.querySelector('.cinder-steps') as Element)).toContain('2 of 3 done');
    expect(words(stepOf(container, 'agent'))).toBe(
      'Completed Create an agent, or start from Assistant Researcher is ready to use.',
    );
    expect(
      within(stepOf(container, 'chat'))
        .getByRole('link', { name: 'Start a chat' })
        .getAttribute('data-cinder-variant'),
    ).toBe('primary');
    expect(getByTestId('home-start-chat')).toBeDefined();
    expect(container.querySelector('[data-testid="home-counts"]')).toBeNull();
  });

  test('Use Assistant does step 2, which then says Assistant is ready to use', async () => {
    const { container, getByTestId } = await open(freshInstallation({ providerConnected: true }));
    await fireEvent.click(
      within(stepOf(container, 'agent')).getByRole('button', { name: 'Use Assistant' }),
    );
    await waitFor(() =>
      expect(words(stepOf(container, 'agent'))).toBe(
        'Completed Create an agent, or start from Assistant Assistant is ready to use.',
      ),
    );
    expect(stepOf(container, 'agent').getAttribute('data-cinder-state')).toBe('complete');
    expect(getByTestId('home-date').textContent?.trim()).toBe('Welcome. One step left.');
    // Step 3 is next, so its button is the primary.
    expect(
      within(stepOf(container, 'chat'))
        .getByRole('link', { name: 'Start a chat' })
        .getAttribute('data-cinder-variant'),
    ).toBe('primary');
  });

  test('steps are done in any order: step 2 first leaves step 1 current', async () => {
    const { container, getByTestId } = await open(freshInstallation({ fileAgent: true }));
    expect(getByTestId('home-date').textContent?.trim()).toBe('Welcome. Two steps left.');
    expect(stepOf(container, 'agent').getAttribute('data-cinder-state')).toBe('complete');
    expect(stepOf(container, 'provider').getAttribute('data-cinder-state')).toBe('current');
    // No provider, so no composer.
    expect(container.querySelector('[data-testid="home-start-chat"]')).toBeNull();
  });
});

describe('Home’s Running now (01w, 01x)', () => {
  const SCHEDULED_RUN = taskFixture({
    id: 'run-daily',
    contextId: 'chat-daily',
    agentName: 'assistant',
    actor: 'system:scheduler',
    kind: 'schedule-fire',
    origin: { kind: 'schedule', scheduleId: 'schedule-daily' },
    status: 'working',
    createdAt: '2026-11-02T10:44:00-06:00',
    updatedAt: '2026-11-02T10:45:00-06:00',
  });

  /** The sample world with nothing waiting and `tasks` in the Bureau. */
  function running(tasks: ReturnType<typeof taskFixture>[]): HomeWorld {
    return sampleHomeWorld({
      world: emptyBureauWorld({ reviews: [], tasks }),
      chats: [
        contextFixture('chat-daily', {
          agentName: 'assistant',
          title: 'Summarize yesterday’s chats and open reviews.',
          updatedAt: '2026-11-02T10:44:00-06:00',
        }),
      ],
    });
  }

  test('counts 1 with no dot, and a card under Needs you reads the run: title, line two, View run (01w, 01x)', async () => {
    const { container, getByTestId } = await open(running([SCHEDULED_RUN]));
    const counts = getByTestId('home-counts');
    await waitFor(() =>
      expect(words(counts.querySelectorAll('.cinder-statistic')[0] as Element)).toBe(
        'Running now 1',
      ),
    );
    // A run going is not a problem, so its count has no dot.
    expect(
      counts.querySelectorAll('.cinder-statistic')[0]?.hasAttribute('data-cinder-attention'),
    ).toBe(false);
    const card = await waitFor(() => cardOf(container, 'Running now'));
    const row = await waitFor(() => within(card).getByRole('listitem'));
    expect(words(row)).toBe(
      'Daily summary Running · Schedule · Assistant · started 10:44 AM View run',
    );
    expect(row.querySelector('.cinder-status-dot')?.getAttribute('data-cinder-status')).toBe(
      'info',
    );
    expect(within(row).getByRole('link', { name: 'View run' }).getAttribute('href')).toBe(
      '/runs/run-daily',
    );
    expect(within(card).getByRole('link', { name: 'Open Runs' }).getAttribute('href')).toBe(
      '/runs',
    );
    // It sits under Needs you and above Needs attention.
    const cards = [...container.querySelectorAll('[data-home-card]')].map((element) =>
      element.getAttribute('data-home-card'),
    );
    expect(cards.indexOf('Needs you')).toBeLessThan(cards.indexOf('Running now'));
    expect(cards.indexOf('Running now')).toBeLessThan(cards.indexOf('Needs attention'));
  });

  test('is gone at zero, and a run waiting on a person is neither counted nor listed (01x)', async () => {
    const waiting = taskFixture({ id: 'run-waiting', status: 'input-required' });
    const { container, getByTestId } = await open(running([waiting]));
    const counts = getByTestId('home-counts');
    await waitFor(() =>
      expect(words(counts.querySelectorAll('.cinder-statistic')[0] as Element)).toBe(
        'Running now 0',
      ),
    );
    expect(container.querySelector('[data-home-card="Running now"]')).toBeNull();
  });

  test('titles a chat’s run by the chat and says a person asked for it', async () => {
    const chatRun = taskFixture({
      id: 'run-chat',
      contextId: 'chat-daily',
      origin: { kind: 'chat', contextId: 'chat-daily' },
      createdAt: '2026-11-02T10:45:00-06:00',
    });
    const { container } = await open(running([chatRun]));
    const card = await waitFor(() => cardOf(container, 'Running now'));
    expect(words(within(card).getByRole('listitem'))).toBe(
      'Summarize yesterday’s chats and open reviews. Running · Chat · Assistant · started 10:45 AM View run',
    );
  });

  test('lists five runs and says how many more wait in Runs', async () => {
    const tasks = Array.from({ length: 7 }, (_, index) =>
      taskFixture({
        id: `run-${String(index)}`,
        contextId: 'chat-daily',
        updatedAt: `2026-11-02T10:4${String(index)}:00-06:00`,
        createdAt: `2026-11-02T10:4${String(index)}:00-06:00`,
      }),
    );
    const { container } = await open(running(tasks));
    const card = await waitFor(() => cardOf(container, 'Running now'));
    await waitFor(() => expect(within(card).getAllByRole('listitem')).toHaveLength(5));
    expect(within(card).getByRole('link', { name: '2 more in Runs' }).getAttribute('href')).toBe(
      '/runs',
    );
  });

  test('is not drawn while the first-run checklist shows', async () => {
    const tasks = [SCHEDULED_RUN];
    const { container } = await open(
      freshInstallation({ world: emptyBureauWorld({ reviews: [], tasks }) }),
    );
    expect(container.querySelector('[data-home-card="Running now"]')).toBeNull();
  });
});
