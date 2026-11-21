/**
 * The page at `/` (design rows 01a to 01k, 01s to 01v): its heading is Cinder's `visually-hidden`
 * wrapper, so the page shows no heading of its own and a screen reader still finds "Home"; the
 * date line leads; four counts; the reviews waiting on you and the problems that need attention,
 * each in its own card, and the box that starts a chat. The Bureau answers as the sample world does
 * (`home-test-support.test-support.ts`), and each test changes what it is about. A new
 * installation (no chat yet) is the first-run checklist (rows 01y to 02b, 13c to 13j, 14c to 14j),
 * and a run that is going is the Running now card (rows 01w, 01x).
 */
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
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
import { readFileSync } from 'node:fs';

import { FIRST_RUN_SAID_HELLO_KEY } from '../../app/first-run.ts';
import {
  contextFixture,
  taskFixture,
  toolApprovalFixture,
} from '../../lib/bureau-fixtures.test-support.ts';
import { StubFault } from '../../lib/bureau-stub.test-support.ts';
import { emptyBureauWorld } from '../../lib/bureau-world.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
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

// The zone in effect now is the one to give back; `bun test` runs in UTC without naming it in `TZ`.
const previousZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

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
  await drawn(rendered.container);
  return rendered;
}

/** Waits until Home is drawn: the overview's date line, or the first-run checklist, the whole page. */
async function drawn(container: HTMLElement): Promise<void> {
  await waitFor(() => {
    if (container.querySelector('[data-testid="home-date"], [data-testid="home-first-run"]'))
      return;
    throw new Error('Home is not drawn yet');
  });
}

/** A Cinder button's form: its variant and its size. */
const buttonForm = (button: Element) =>
  [...button.classList].filter((name) => /^button-(variant|size)-/.test(name));

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
      'Monday, Nov 2. Times show in Central time (CST).',
    );
    expect(getByRole('heading', { level: 1 })).toBe(heading);
  });

  // COR-2329: the content-first Home leads with one Spotlight and one quiet count, not four tiles.
  // Owner, 2026-11-19: a count is shown only when it is not zero.
  test('leads with a Spotlight that says how many reviews wait on you, and no count at zero', async () => {
    const { container, getByTestId } = await open();
    await waitFor(() =>
      expect(
        getByTestId('home-spotlight')
          .querySelector('.cinder-spotlight__value')
          ?.textContent?.trim(),
      ).toBe('2 need you'),
    );
    await waitFor(() => expect(cardOf(container, 'Needs you')).toBeDefined());
    await quietFor(50);
    expect(container.querySelector('[data-testid="home-counts"]')).toBeNull();
    // The Spotlight comes before the Needs you list, the first thing the page says.
    const needsYou = getByTestId('home-spotlight').compareDocumentPosition(
      cardOf(document.body, 'Needs you'),
    );
    expect(needsYou & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // COR-2489 (owner decision 2026-11-16): the count sat between the Spotlight and the list it
  // titles. It renders after the list, in the markup and in the order the layout shows it.
  test('renders "Failed in 24 hours" after the Needs you list the Spotlight titles', async () => {
    const { container, findByTestId, getByTestId } = await open(sampleHomeWorld({ failedRuns: 3 }));
    const list = cardOf(container, 'Needs you');
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
    const counts = await findByTestId('home-counts');
    expect(counts.getAttribute('data-cinder-variant')).toBe('plain');
    expect(getByTestId('home-focus').contains(counts)).toBe(false);
    expect(
      list.compareDocumentPosition(counts) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the count follows the list',
    ).toBeTruthy();
    expect(
      getByTestId('home-spotlight').compareDocumentPosition(list) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // On screen too: the count's slot is placed right after the list's, before Running now, in the
    // one-column order a phone uses, and follows it in the wide column's markup.
    const slot = counts.closest('.ib-home__counts');
    const listSlot = list.closest('.ib-home__needs-you');
    expect(slot).not.toBeNull();
    expect(listSlot?.nextElementSibling).toBe(slot);
    const layout = readFileSync(new URL('./home-layout.svelte', import.meta.url), 'utf8');
    const orderOf = (name: string) =>
      new RegExp(`\\.ib-home__${name} \\{\\s*order: (\\d+);`).exec(layout)?.[1];
    expect(orderOf('counts')).toBe(orderOf('needs-you'));
    expect(Number(orderOf('counts'))).toBeLessThan(Number(orderOf('running')));
  });

  test('reads the recent chats without the archived ones, which are put away (COR-2285 V5)', async () => {
    const asked: Record<string, unknown>[] = [];
    installed = installHome(sampleHomeWorld());
    const world = sampleHomeWorld();
    installed.stub.on('bureau.contexts.list', (params) => {
      asked.push(params);
      return { contexts: world.chats, nextOffset: null };
    });
    const { findByTestId } = render(HomeHarness, { props: { client: installed.client } } as never);
    await findByTestId('home-date');

    // Recent chats leaves archived chats out; whether a chat happened (the first-run checklist)
    // counts them, reading one chat.
    expect(asked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ origin: 'chat', archived: 'exclude' }),
        { origin: 'chat', archived: 'include', limit: 1 },
      ]),
    );
    expect(asked.every((params) => params['archived'] === 'exclude' || params['limit'] === 1)).toBe(
      true,
    );
  });

  test('puts a dot before the count when runs failed in the last day', async () => {
    const { findByTestId } = await open(sampleHomeWorld({ failedRuns: 3 }));
    const counts = await findByTestId('home-counts');
    await waitFor(() =>
      expect(counts.textContent?.replaceAll(/\s+/g, ' ').trim()).toBe('Failed in 24 hours 3'),
    );
    expect(counts.querySelector('.cinder-statistic')?.hasAttribute('data-cinder-attention')).toBe(
      true,
    );
  });

  test('shows no count to a caller who may not read runs', async () => {
    installed = installHome(sampleHomeWorld({ failedRuns: 3 }));
    const { container } = render(HomeHarness, {
      props: {
        client: installed.client,
        scopes: AUTHORIZATION_SCOPES.filter((scope) => scope !== 'workflows:read'),
      },
    } as never);
    await drawn(container);
    await waitFor(() => expect(cardOf(container, 'Needs you')).toBeDefined());
    await quietFor(50);
    expect(container.querySelector('[data-testid="home-counts"]')).toBeNull();
  });

  test('keeps the Spotlight and the count when the problems cannot be read, and never claims all is well', async () => {
    const { container, getByTestId, findByTestId } = await open(
      sampleHomeWorld({ attentionRefused: true, failedRuns: 2 }),
    );
    await waitFor(() =>
      expect(
        getByTestId('home-spotlight')
          .querySelector('.cinder-spotlight__value')
          ?.textContent?.trim(),
      ).toBe('2 need you'),
    );
    const counts = await findByTestId('home-counts');
    await waitFor(() =>
      expect(counts.textContent?.replaceAll(/\s+/g, ' ').trim()).toBe('Failed in 24 hours 2'),
    );
    // Needs attention could not be read, so it says so in its own place and never that all is well.
    const attention = await waitFor(() => cardOf(container, 'Needs attention'));
    await waitFor(() => expect(attention.textContent).toContain('Couldn’t load system problems.'));
  });

  test('lists the reviews waiting on you, oldest first, with the button that opens each (01f, 01g)', async () => {
    const { container } = await open();
    const card = cardOf(container, 'Needs you');
    await waitFor(() => expect(within(card).getAllByRole('listitem')).toHaveLength(2));
    const rows = within(card).getAllByRole('listitem');
    const text = (row: HTMLElement) => row.textContent?.replaceAll(/\s+/g, ' ').trim();
    expect(text(rows[0]!)).toContain('Which environment should the release go to?');
    expect(text(rows[0]!)).toContain('Question, Request human input, 1 h ago');
    expect(within(rows[0]!).getByRole('link', { name: 'Answer' }).getAttribute('href')).toBe(
      '/reviews?review=bureau%3Ahuman-wait%3Arelease',
    );
    expect(text(rows[1]!)).toContain('Refund order 4471 for $42.00?');
    expect(text(rows[1]!)).toContain('Approval, Tool runner, Can’t be undone, 4 min ago');
    expect(within(rows[1]!).getByRole('link', { name: 'Review' })).not.toBeNull();
  });

  // COR-2329: the page said "needs you" three times, the Spotlight over a section titled "Needs you".
  test('titles the list with the Spotlight: the link to Reviews sits beside it and the list draws no heading', async () => {
    const { container, getByTestId } = await open();
    const card = cardOf(container, 'Needs you');
    await waitFor(() => expect(within(card).getAllByRole('listitem')).toHaveLength(2));
    expect(card.querySelector('h2, h3')).toBeNull();
    expect(within(card).getByRole('list', { name: 'Reviews waiting on you' })).toBeDefined();
    const focus = getByTestId('home-focus');
    const link = within(focus).getByRole('link', { name: 'Open Reviews' });
    expect(link.getAttribute('href')).toBe('/reviews');
    expect(link.getAttribute('data-variant')).toBe('more');
    // It is the Spotlight's own action (COR-2329 round two: the page copied Section's header).
    expect(link.closest('.cinder-spotlight__action')).not.toBeNull();
    expect(getByTestId('home-spotlight').contains(link)).toBe(true);
    expect(container.querySelector('.ib-home-focus__lead')).toBeNull();
    expect(within(container).getAllByRole('link', { name: 'Open Reviews' })).toHaveLength(1);
    expect(within(container).queryByRole('heading', { name: 'Needs you' })).toBeNull();
    await fireEvent.click(link);
    expect(router.current.route?.pattern).toBe('/reviews');
  });

  test('lists five reviews and ends the list in one row that opens the rest in Reviews', async () => {
    const reviews = Array.from({ length: 7 }, (_, index) =>
      toolApprovalFixture({
        id: `approval:${String(index)}`,
        runId: `run-${String(index)}`,
        sessionId: `chat-${String(index)}`,
        requestedAt: HOME_NOW - (index + 1) * 60_000,
      }),
    );
    const { container, getByTestId } = await open(
      sampleHomeWorld({ world: emptyBureauWorld({ reviews }) }),
    );
    await waitFor(() =>
      expect(
        getByTestId('home-spotlight')
          .querySelector('.cinder-spotlight__value')
          ?.textContent?.trim(),
      ).toBe('7 need you'),
    );
    const card = cardOf(container, 'Needs you');
    await waitFor(() => expect(card.querySelectorAll('li[data-review]')).toHaveLength(5));
    // The last row is Cinder's own linked row, not a line the page draws.
    const more = card.querySelector('li[data-more]');
    expect(more?.classList.contains('cinder-grouped-list-item')).toBe(true);
    expect(
      within(more as HTMLElement)
        .getByRole('link', { name: '2 more in Reviews' })
        .getAttribute('href'),
    ).toBe('/reviews');
    await fireEvent.click(
      within(more as HTMLElement).getByRole('link', { name: '2 more in Reviews' }),
    );
    expect(router.current.route?.pattern).toBe('/reviews');
  });

  test('the way out to Health is Cinder’s more link, the page restyles nothing, and it opens in place', async () => {
    const { container } = await open();
    const card = cardOf(container, 'Needs attention');
    const link = await within(card).findByRole('link', { name: 'Open Health' });
    expect(link.classList.contains('cinder-link')).toBe(true);
    expect(link.getAttribute('data-variant')).toBe('more');
    expect(link.querySelector('.cinder-link__chevron')).not.toBeNull();
    expect(container.querySelector('.ib-home-link')).toBeNull();
    await fireEvent.click(link);
    expect(router.current.route?.pattern).toBe('/health');
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
      ).toContain('Schedule, Assistant, Every day at 3:00 AM (9:00 AM UTC)'),
    );
    expect(titles[2]).toContain('No model provider connected');
    expect(within(card).getByRole('link', { name: 'Open Health' }).getAttribute('href')).toBe(
      '/health',
    );
    // The link is the section's action, beside its heading, as it is with nothing listed (COR-2489).
    expect(
      within(card.querySelector('.cinder-section__actions') as HTMLElement).getByRole('link', {
        name: 'Open Health',
      }),
    ).toBeDefined();
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

  // Owner, 2026-11-19: no card says nothing, and no tile reads zero. With nothing waiting the page
  // says so in one quiet line, and the space goes to what has content.
  test('says nothing needs you in one quiet line, with no Spotlight, no count and no card (01s, 01t)', async () => {
    const { container, findByTestId } = await open(calm());
    const line = await findByTestId('home-nothing-needs-you');
    expect(line.textContent?.trim()).toBe('Nothing needs you.');
    expect(line.getAttribute('role')).toBe('status');
    expect(container.querySelector('[data-testid="home-spotlight"]')).toBeNull();
    await waitFor(() => expect(cardOf(container, 'Recent chats')).toBeDefined());
    await quietFor(50);
    expect(container.querySelector('[data-testid="home-counts"]')).toBeNull();
    expect(container.querySelector('[data-home-card="Needs you"]')).toBeNull();
    expect(container.textContent).not.toContain('Nothing is waiting on you');
  });

  test('draws no Needs attention section when nothing needs attention (01u)', async () => {
    const { container } = await open(calm());
    await waitFor(() => expect(cardOf(container, 'Recent chats')).toBeDefined());
    await quietFor(50);
    expect(container.querySelector('[data-home-card="Needs attention"]')).toBeNull();
    expect(container.textContent).not.toContain('Nothing needs attention');
    // Only the one quiet line says nothing needs the person.
    expect(container.querySelectorAll('[data-quiet-line]')).toHaveLength(1);
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
    expect(card.querySelector('.cinder-select.select-variant-ghost')).not.toBeNull();
    const send = within(card).getByRole('button', { name: 'Send' });
    expect(send.classList.contains('button-variant-primary')).toBe(true);
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

  // COR-2489: "Connect a provider" is drawn in one button form per context: a secondary small
  // button in a Needs attention row and in the blocked composer, and the checklist's primary small
  // button while its step is current.
  test('draws Connect a provider in one button form per context', async () => {
    const { container, getByTestId } = await open();
    const card = getByTestId('home-start-chat');
    await waitFor(() => expect(shownLabel(card)).toContain('Assistant'));
    await chooseOption(card, 'Tool runner', 'home-start-chat-agent');
    const composer = await waitFor(() =>
      within(card).getByRole('link', { name: 'Connect a provider' }),
    );
    const attention = cardOf(container, 'Needs attention');
    const row = await waitFor(() =>
      within(attention).getByRole('link', { name: 'Connect a provider' }),
    );
    expect(buttonForm(row)).toEqual(['button-variant-secondary', 'button-size-small']);
    expect(buttonForm(composer)).toEqual(['button-variant-secondary', 'button-size-small']);
  });

  test('draws the checklist’s Connect a provider as its one primary small button', async () => {
    const { container } = await open(freshInstallation());
    const step = within(stepOf(container, 'provider')).getByRole('link', {
      name: 'Connect a provider',
    });
    expect(buttonForm(step)).toEqual(['button-variant-primary', 'button-size-small']);
    // The checklist stands in for the notice, so the step is the only Connect a provider there.
    expect(within(container).getAllByRole('link', { name: 'Connect a provider' })).toHaveLength(1);
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
  // Owner, 2026-11-19: "Welcome. Three steps to your first chat." over a box titled "Get started"
  // said it twice. One real heading at the page title's size leads, with one sentence under it.
  test('leads with one visible heading and one sentence, and no date line, welcome line or second heading', async () => {
    const { container, getAllByRole, getByRole, getByTestId, queryByText } =
      await open(freshInstallation());
    const firstRun = getByTestId('home-first-run');
    const heading = getByRole('heading', { level: 1, name: 'Set up Interborough' });
    expect(heading.classList.contains('cinder-sr-only')).toBe(false);
    expect(firstRun.contains(heading)).toBe(true);
    expect(getAllByRole('heading')).toEqual([heading]);
    expect(firstRun.querySelector('.ib-home-first-run__lead')?.textContent?.trim()).toBe(
      'Connect a model, choose an agent, then say hello.',
    );
    expect(container.querySelector('[data-testid="home-date"]')).toBeNull();
    expect(queryByText(/Times show in/)).toBeNull();
    expect(queryByText(/Welcome\./)).toBeNull();
    expect(queryByText('Get started')).toBeNull();
    // The checklist is named by the page's heading; no "0 of 3 done" counter.
    expect(firstRun.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(container.querySelector('.cinder-steps__header')).toBeNull();
    expect(container.textContent).not.toMatch(/of 3 done/);
  });

  // Owner, 2026-11-19: the steps sat in a box two thirds of the width with the rest empty.
  test('lays the first run out at the page’s reading width, centred, with no box around it', () => {
    const source = readFileSync(new URL('./home-first-run.svelte', import.meta.url), 'utf8');
    const rule = /\.ib-home-first-run \{([^}]*)\}/.exec(source)?.[1] ?? '';
    expect(rule).toContain('max-inline-size: var(--cinder-content-width-reading);');
    expect(rule).toContain('margin-inline: auto;');
    expect(rule).not.toMatch(/border|background|box-shadow/);
    expect(source).toMatch(/\.ib-home-first-run__intro \{[^}]*text-align: center;/);
    expect(source).toMatch(
      /\.ib-home-first-run__title \{[^}]*font-size: var\(--cinder-text-page-title\);/,
    );
  });

  test('shows the three steps in order, as numbered circles (01y, 13f)', async () => {
    const { container } = await open(freshInstallation());
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
      (button) => button.classList.contains('button-variant-primary'),
    );
    expect(primaries.map(words)).toEqual(['Connect a provider']);
    const agent = stepOf(container, 'agent');
    expect(
      within(agent)
        .getByRole('button', { name: 'Use Assistant' })
        .classList.contains('button-variant-ghost-accent'),
    ).toBe(true);
    expect(
      within(agent)
        .getByRole('link', { name: 'Create an agent' })
        .classList.contains('button-variant-secondary'),
    ).toBe(true);
    expect(
      within(stepOf(container, 'chat'))
        .getByRole('link', { name: 'Start a chat' })
        .classList.contains('button-variant-secondary'),
    ).toBe(true);
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

  // Owner, 2026-11-19: a first run shows only the getting-started steps.
  test('shows only the steps: no counts, Needs you, composer, Needs attention, Recent chats or activity (01z, 13d, 13j, 14e)', async () => {
    const { container, queryByRole, queryByText } = await open(freshInstallation());
    await quietFor(50);
    expect(container.querySelector('[data-testid="home-counts"]')).toBeNull();
    expect(container.querySelector('[data-testid="home-focus"]')).toBeNull();
    expect(container.querySelector('[data-home-card]')).toBeNull();
    expect(container.querySelector('[data-testid="home-start-chat"]')).toBeNull();
    expect(container.querySelector('[data-testid="home-activity"]')).toBeNull();
    expect(container.querySelector('.cinder-empty-state')).toBeNull();
    expect(container.querySelector('.cinder-statistic')).toBeNull();
    expect(queryByText('No model provider connected')).toBeNull();
    // No banner: nothing in the page is an alert.
    expect(queryByRole('alert')).toBeNull();
    expect(queryByText(/Connect a model provider/)).toBeNull();
    const page = container.querySelector('[data-page="home"]');
    expect(page?.getAttribute('data-mode')).toBe('checklist');
    expect(page?.children).toHaveLength(1);
    expect(page?.firstElementChild?.getAttribute('data-testid')).toBe('home-first-run');
  });

  test('shows only the steps even while another problem is listed (13d)', async () => {
    const { container } = await open(
      freshInstallation({ attention: SAMPLE_ATTENTION, schedules: [DAILY_SUMMARY] }),
    );
    await quietFor(50);
    expect(container.querySelector('[data-home-card="Needs attention"]')).toBeNull();
  });

  test('keys off whether a chat happened, not off the providers: a chat ends the checklist with no provider (14c)', async () => {
    const { container, getByTestId } = await open(sampleHomeWorld());
    expect(container.querySelector('[data-testid="home-first-run"]')).toBeNull();
    expect(getByTestId('home-date')).toBeDefined();
    // The provider notice is back in Needs attention, where it blocks something.
    await waitFor(() =>
      expect(cardOf(container, 'Needs attention').textContent).toContain(
        'No model provider connected',
      ),
    );
  });

  test('counts an archived chat as a chat that happened: no checklist, and Recent chats, which leaves it out, draws nothing (COR-2285 V5)', async () => {
    const world = freshInstallation();
    installed = installHome(world);
    const archivedChat = {
      ...sampleHomeWorld().chats[0],
      archivedAt: '2026-11-01T12:00:00.000Z',
    };
    // The Bureau filters as it does: the only chat is archived.
    installed.stub.on('bureau.contexts.list', (params) => ({
      contexts: params['archived'] === 'exclude' ? [] : [archivedChat],
      nextOffset: null,
    }));
    const { findByTestId, container } = render(HomeHarness, {
      props: { client: installed.client },
    } as never);
    await findByTestId('home-date');

    expect(container.querySelector('[data-testid="home-first-run"]')).toBeNull();
    // Recent chats appears once a chat it lists exists; it never says there are none.
    await waitFor(() => expect(container.querySelector('[data-home-card]')).not.toBeNull());
    await quietFor(50);
    expect(container.querySelector('[data-home-card="Recent chats"]')).toBeNull();
    expect(container.textContent).not.toContain('No chats yet');
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
    await findByTestId('home-date');
    expect(container.querySelector('[data-testid="home-first-run"]')).toBeNull();
  });

  test('never returns once a chat happened, even after every chat is deleted', async () => {
    const identity = { workspaceId: 'workspace-home', actorId: 'actor-home' };
    const key = `interborough:identity:${JSON.stringify([identity.workspaceId, identity.actorId])}:${FIRST_RUN_SAID_HELLO_KEY}`;
    window.localStorage.removeItem(key);
    try {
      const first = await open(sampleHomeWorld(), identity);
      await first.findByTestId('home-date');
      await waitUntil(() => window.localStorage.getItem(key) === 'true');
      cleanup();
      installed?.restore();
      const second = await open(freshInstallation(), identity);
      await second.findByTestId('home-date');
      expect(second.container.querySelector('[data-testid="home-first-run"]')).toBeNull();
    } finally {
      window.localStorage.removeItem(key);
    }
  });
});

describe('Home’s checklist on a host with no Assistant', () => {
  /** A host whose only agents are ones that need a model: Assistant comes from a plugin or the host. */
  async function withoutAssistant(
    overrides: Partial<HomeWorld> = {},
    agents: readonly string[] = ['tool-runner'],
    hidden: readonly string[] = [],
  ) {
    const world = freshInstallation(overrides);
    installed = installHome(world);
    installed.stub.on('bureau.agents.list', () => ({
      agents: agents.map((name) => ({
        name,
        displayName: name,
        description: null,
        definitionRevision: 1,
        kind: 'code',
        a2a: false,
        ...(hidden.includes(name) ? { visibility: 'hidden' } : {}),
        media: { modalities: {}, mimeFamilies: [], mediaLimits: [] },
      })),
    }));
    const rendered = render(HomeHarness, { props: { client: installed.client } } as never);
    await drawn(rendered.container);
    return rendered;
  }

  /** Step 3's button, live or held. */
  const startChat = (container: HTMLElement) =>
    within(stepOf(container, 'chat')).getByRole(
      stepOf(container, 'chat').querySelector('a') === null ? 'button' : 'link',
      { name: 'Start a chat' },
    );

  test('does not offer a hidden Assistant in the checklist', async () => {
    const { container } = await withoutAssistant(
      { providerConnected: true },
      ['assistant'],
      ['assistant'],
    );
    const step = stepOf(container, 'agent');
    expect(within(step).queryByRole('button', { name: 'Use Assistant' })).toBeNull();
    expect(words(step)).not.toContain('Assistant');
    expect(within(step).getByRole('link', { name: 'Create an agent' })).toBeDefined();
    expect(words(stepOf(container, 'chat'))).toContain('Waits for step 2: create an agent first.');
  });

  // Owner, 2026-11-19: a step that cannot be done yet is shown as waiting on the earlier step, not
  // as an active button, by the readiness rule every New chat entry point reads.
  test('offers no Use Assistant, and Start a chat waits on step 1 while no agent can answer', async () => {
    const { container, getByTestId } = await withoutAssistant();
    const agent = stepOf(container, 'agent');
    expect(within(agent).queryByRole('button', { name: 'Use Assistant' })).toBeNull();
    expect(within(agent).getByRole('link', { name: 'Create an agent' })).toBeDefined();
    await waitFor(() =>
      expect(getByTestId('home-first-run').getAttribute('data-chat-waits-on')).toBe(
        'needs-provider',
      ),
    );
    const held = startChat(container);
    expect(held.tagName).toBe('BUTTON');
    expect((held as HTMLButtonElement).disabled).toBe(true);
    expect(held.classList.contains('button-variant-secondary')).toBe(true);
    expect(words(stepOf(container, 'chat'))).toContain(
      'Waits for step 1: connect a provider first.',
    );
  });

  test('Start a chat waits on step 2 while a provider is connected and no agent is offered', async () => {
    const { container, getByTestId } = await withoutAssistant({ providerConnected: true }, []);
    await waitFor(() =>
      expect(getByTestId('home-first-run').getAttribute('data-chat-waits-on')).toBe('needs-agent'),
    );
    expect((startChat(container) as HTMLButtonElement).disabled).toBe(true);
    expect(words(stepOf(container, 'chat'))).toContain('Waits for step 2: create an agent first.');
  });

  test('Start a chat comes alive once its prerequisite is done, and opens New chat to pick an agent', async () => {
    const { container, getByTestId } = await withoutAssistant({ providerConnected: true });
    await waitFor(() =>
      expect(getByTestId('home-first-run').hasAttribute('data-chat-waits-on')).toBe(false),
    );
    expect(startChat(container).getAttribute('href')).toBe('/chats/new');
  });
});

describe('Home with only a keyless provider (COR-2414)', () => {
  test('completes the first step and shows no connect-a-provider notice, with a model agent able to start', async () => {
    const { container, getByTestId } = await open(freshInstallation({ providerKeyless: true }));

    const provider = stepOf(container, 'provider');
    expect(provider.getAttribute('data-cinder-state')).toBe('complete');
    expect(words(provider)).toContain('ollama is connected.');
    expect(within(provider).queryByRole('link')).toBeNull();
    expect(container.textContent).not.toContain('No model provider connected');
    expect(container.textContent).not.toContain('Connect a model provider');
    // The providers are read in a later turn than the agents: a reader that took the keyless
    // provider for none would hold Start a chat by now.
    await quietFor(100);
    expect(getByTestId('home-first-run').hasAttribute('data-chat-waits-on')).toBe(false);
    expect(
      within(stepOf(container, 'chat')).getByRole('link', { name: 'Start a chat' }),
    ).toBeDefined();
  });
});

describe('Home’s checklist as steps are done (14e, 14j)', () => {
  test('with a provider connected the checklist skips to step 2, and the steps stay the whole page (14e, 14j)', async () => {
    const { container } = await open(freshInstallation({ providerConnected: true }));
    const provider = stepOf(container, 'provider');
    expect(words(provider)).toContain('Anthropic is connected.');
    expect(provider.getAttribute('data-cinder-state')).toBe('complete');
    expect(within(provider).queryByRole('link')).toBeNull();
    // The current step is now the second, and its main button is the primary one.
    expect(stepOf(container, 'agent').getAttribute('data-cinder-state')).toBe('current');
    expect(
      within(stepOf(container, 'agent'))
        .getByRole('link', { name: 'Create an agent' })
        .classList.contains('button-variant-primary'),
    ).toBe(true);
    // Only the current step's action is primary.
    const primaries = [...container.querySelectorAll('.cinder-steps .cinder-button')].filter(
      (button) => button.classList.contains('button-variant-primary'),
    );
    expect(primaries.map(words)).toEqual(['Create an agent']);
    expect(container.querySelector('[data-testid="home-start-chat"]')).toBeNull();
  });

  test('after steps 1 and 2 Start a chat is primary (14j)', async () => {
    const { container } = await open(
      freshInstallation({ providerConnected: true, fileAgent: true }),
    );
    expect(words(stepOf(container, 'agent'))).toBe(
      'Completed Create an agent, or start from Assistant Researcher is ready to use.',
    );
    expect(
      within(stepOf(container, 'chat'))
        .getByRole('link', { name: 'Start a chat' })
        .classList.contains('button-variant-primary'),
    ).toBe(true);
    expect(container.querySelector('[data-testid="home-counts"]')).toBeNull();
  });

  test('Use Assistant does step 2, which then says Assistant is ready to use', async () => {
    const { container } = await open(freshInstallation({ providerConnected: true }));
    await fireEvent.click(
      within(stepOf(container, 'agent')).getByRole('button', { name: 'Use Assistant' }),
    );
    await waitFor(() =>
      expect(words(stepOf(container, 'agent'))).toBe(
        'Completed Create an agent, or start from Assistant Assistant is ready to use.',
      ),
    );
    expect(stepOf(container, 'agent').getAttribute('data-cinder-state')).toBe('complete');
    // Step 3 is next, so its button is the primary.
    expect(
      within(stepOf(container, 'chat'))
        .getByRole('link', { name: 'Start a chat' })
        .classList.contains('button-variant-primary'),
    ).toBe(true);
  });

  test('steps are done in any order: step 2 first leaves step 1 current', async () => {
    const { container } = await open(freshInstallation({ fileAgent: true }));
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

  /**
   * A row's words as they read. The status dot's word ends in the whitespace of its own markup,
   * which its inline flex box never draws, so a comma after it reads straight after the word.
   */
  const rowWords = (element: Element) => words(element)?.replaceAll(' ,', ',');

  test('lists the run in a section under Needs you: title, line two, View run (01w, 01x)', async () => {
    const { container } = await open(running([SCHEDULED_RUN]));
    const card = await waitFor(() => cardOf(container, 'Running now'));
    const row = await waitFor(() => within(card).getByRole('listitem'));
    expect(rowWords(row)).toBe(
      'Daily summary Running, Schedule, Assistant, started 10:44 AM View run',
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

  test('is gone at zero, and a run waiting on a person is not listed (01x)', async () => {
    const waiting = taskFixture({ id: 'run-waiting', status: 'input-required' });
    const { container, findByTestId } = await open(running([waiting]));
    await findByTestId('home-nothing-needs-you');
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
    expect(rowWords(within(card).getByRole('listitem'))).toBe(
      'Summarize yesterday’s chats and open reviews. Running, Chat, Assistant, started 10:45 AM View run',
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
    // Five runs, then one more row: a link to Runs that says how many more.
    await waitFor(() => expect(card.querySelectorAll('li[data-run]')).toHaveLength(5));
    const more = card.querySelector('li[data-more]');
    expect(more).not.toBeNull();
    expect(
      within(more as HTMLElement)
        .getByRole('link', { name: '2 more in Runs' })
        .getAttribute('href'),
    ).toBe('/runs');
  });

  test('is not drawn while the first-run checklist shows', async () => {
    const tasks = [SCHEDULED_RUN];
    const { container } = await open(
      freshInstallation({ world: emptyBureauWorld({ reviews: [], tasks }) }),
    );
    expect(container.querySelector('[data-home-card="Running now"]')).toBeNull();
  });
});
