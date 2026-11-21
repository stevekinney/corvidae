/**
 * Home's Agent activity band (COR-2227, AC1 to AC5): the Bureau's events worded through
 * `bureau.events.format` in batches of at most 200 and listed newest first, three rows, each with
 * its glyph, title, tier word, body, time and link; an unclaimed kind and every event of a failed
 * format call in plain words with no error; a link that opens
 * in the router; and a window read when the replay ends and on every resync, never the replayed
 * envelopes one by one, held while a person is on the list.
 */
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { cleanup, fireEvent, render, within } from '@testing-library/svelte';
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

import { envelopeChunk } from '../../lib/live-source/event-stream-hub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import Harness from './home-activity.test-harness.svelte';
import {
  ACTIVITY_NOW,
  bureauEnvelope,
  installActivityWorld,
  OLDER,
  REPLAY_COMPLETE_CHUNK,
  TODAY,
  YESTERDAY,
  type ActivityWorld,
} from './home-activity.test-support.ts';

let world: ActivityWorld | undefined;
const previousZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

beforeAll(() => {
  process.env['TZ'] = 'America/Chicago';
});

afterAll(() => {
  process.env['TZ'] = previousZone;
});

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  setSystemTime(new Date(ACTIVITY_NOW));
});

afterEach(() => {
  cleanup();
  world?.restore();
  world = undefined;
  setSystemTime();
});

function open(prepare: (opened: ActivityWorld) => void = () => {}): {
  world: ActivityWorld;
  container: HTMLElement;
} {
  world = installActivityWorld();
  // The band opens its feed as it mounts, so a refusal is set up first.
  prepare(world);
  world.wordings.set('review.requested', {
    title: 'Refund order 4471 waits on you',
    body: 'Tool runner asks to refund $42.00',
    tier: 'warning',
    icon: 'user-check',
    link: '/reviews',
  });
  world.wordings.set('run.failed', {
    title: 'Release notes digest failed',
    body: 'The model provider refused the request',
    tier: 'critical',
    runId: 'run-7',
  });
  world.wordings.set('chat.started', { title: 'Chat started with Assistant', tier: 'info' });
  const { container } = render(Harness, {
    props: { bureauEvents: world.bureauEvents, fleetEvents: world.fleetEvents },
  });
  return { world, container };
}

function band(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>('[data-home-card="Agent activity"]');
  if (found === null) throw new Error('no Agent activity band');
  return found;
}

const rowsOf = (container: HTMLElement) => [
  ...band(container).querySelectorAll<HTMLElement>('.cinder-grouped-list-item'),
];
const titlesOf = (container: HTMLElement) =>
  rowsOf(container).map(
    (row) => row.querySelector('.cinder-grouped-list-item__title')?.textContent?.trim() ?? '',
  );

/** Opens the band, ends a replay of `chunks`, and waits for its first window. */
async function ready(chunks: readonly string[]) {
  const opened = open();
  await waitUntil(() => opened.world.hub.opened('bureau') === 1);
  opened.world.hub.write('bureau', ...chunks, REPLAY_COMPLETE_CHUNK);
  await waitUntil(() => band(opened.container).querySelector('[role="list"], ul') !== null);
  return opened;
}

const sampleReplay = [
  bureauEnvelope('b:1', 'chat.started', OLDER),
  bureauEnvelope('b:2', 'goal.attempt.started', YESTERDAY, { goalRunId: 'run-goal' }),
  bureauEnvelope('b:3', 'run.failed', YESTERDAY + 60_000, { runId: 'run-7' }),
  bureauEnvelope('b:4', 'review.requested', TODAY, { runId: 'run-refund' }),
];

describe('Agent activity (AC1, AC5)', () => {
  test('reads the replay as one window, worded in one call, and lists the newest three, newest first', async () => {
    const { world, container } = await ready(sampleReplay);
    await waitUntil(() => rowsOf(container).length === 3);
    // The replayed envelopes are worded together, never one at a time.
    expect(world.formatCalls.map((call) => call.map((event) => event.kind))).toEqual([
      ['chat.started', 'goal.attempt.started', 'run.failed', 'review.requested'],
    ]);
    expect(titlesOf(container)).toEqual([
      'Refund order 4471 waits on you',
      'Release notes digest failed',
      'Goal attempt started',
    ]);
    const list = within(band(container)).getByRole('list', { name: 'Recent agent activity' });
    // Not a live region: an arrival is not announced.
    expect(list.getAttribute('aria-live')).toBeNull();
    expect(list.closest('[aria-live]')).toBeNull();
  });

  test('draws a row as glyph, title, tier word and body, time and link', async () => {
    const { container } = await ready(sampleReplay);
    await waitUntil(() => rowsOf(container).length === 3);
    const [warning, critical] = rowsOf(container);
    // The tier is said once, as a StatusDot word leading line two, then a comma and the body.
    const warningLine = warning?.querySelector('.cinder-grouped-list-item__subtitle');
    // (StatusDot's own markup ends in whitespace inside its inline-flex box, which draws nothing.)
    expect(warningLine?.textContent?.replace(/\s+/g, ' ').replace(/ ,/g, ',').trim()).toBe(
      'Warning, Tool runner asks to refund $42.00',
    );
    expect(warningLine?.querySelector('.cinder-badge')?.getAttribute('data-cinder-variant')).toBe(
      'warning',
    );
    expect(critical?.querySelector('.cinder-badge')?.getAttribute('data-cinder-variant')).toBe(
      'danger',
    );
    // The glyph sits in the leading icon slot and says nothing.
    const glyph = warning?.querySelector('.cinder-grouped-list-item__leading svg');
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
    expect(
      warning
        ?.querySelector('.cinder-grouped-list-item__leading')
        ?.getAttribute('data-cinder-leading'),
    ).toBe('icon');
    // The time is a time element worded as Recent chats words its times.
    const time = warning?.querySelector('.cinder-grouped-list-item__trailing time');
    expect(time?.textContent).toBe('10:42 AM');
    expect(time?.getAttribute('datetime')).toBe(new Date(TODAY).toISOString());
    expect(critical?.querySelector('time')?.textContent).toBe('Yesterday, 4:13 PM');
    // The formatter's link, or the run the event names.
    expect(warning?.querySelector('a')?.getAttribute('href')).toBe('/reviews');
    expect(critical?.querySelector('a')?.getAttribute('href')).toBe('/runs/run-7');
    // Two lines at most for the title and the body, and one tooltip on the row.
    expect(
      warning?.querySelector('.cinder-grouped-list-item__title')?.getAttribute('data-cinder-lines'),
    ).toBe('2');
    expect(
      warning
        ?.querySelector('.cinder-grouped-list-item__subtitle')
        ?.getAttribute('data-cinder-lines'),
    ).toBe('2');
    expect(warning?.getAttribute('title')).toBe(
      'Refund order 4471 waits on you\nWarning, Tool runner asks to refund $42.00',
    );
    // No buttons: the link is the row's one action.
    expect(band(container).querySelectorAll('button')).toHaveLength(0);
  });

  test('an info row has no dot and no tier word, and a row with no line two draws none', async () => {
    const { container } = await ready([
      bureauEnvelope('b:1', 'chat.started', TODAY),
      bureauEnvelope('b:2', 'review.requested', TODAY - 60_000),
    ]);
    await waitUntil(() => rowsOf(container).length === 2);
    const [info] = rowsOf(container);
    expect(info?.querySelector('.cinder-badge')).toBeNull();
    expect(info?.querySelector('.cinder-grouped-list-item__subtitle')).toBeNull();
    // A row with no link keeps the chevron's column and is not focusable.
    expect(info?.classList.contains('cinder-grouped-list-item--chevron-column')).toBe(true);
    expect(info?.querySelector('a, [tabindex]')).toBeNull();
    expect(info?.getAttribute('title')).toBe('Chat started with Assistant');
  });

  test('reads a window of more than one batch in one call of at most 200', async () => {
    const chunks = Array.from({ length: 250 }, (_, index) =>
      bureauEnvelope(`b:${String(index + 1)}`, 'chat.started', TODAY - (250 - index) * 1_000),
    );
    const { world, container } = await ready(chunks);
    await waitUntil(() => rowsOf(container).length === 3);
    expect(world.formatCalls.map((call) => call.length)).toEqual([200]);
  });

  test('a live event enters at the top, fading in, and the oldest shown row leaves', async () => {
    const { world, container } = await ready(sampleReplay);
    await waitUntil(() => rowsOf(container).length === 3);
    world.hub.write('bureau', bureauEnvelope('b:5', 'chat.started', ACTIVITY_NOW - 30_000));
    await waitUntil(() => titlesOf(container)[0] === 'Chat started with Assistant');
    expect(titlesOf(container)).toEqual([
      'Chat started with Assistant',
      'Refund order 4471 waits on you',
      'Release notes digest failed',
    ]);
    expect(world.formatCalls.at(-1)?.map((event) => event.kind)).toEqual(['chat.started']);
    const [arrived, kept] = rowsOf(container);
    expect(arrived?.classList.contains('cinder-grouped-list-item--arriving')).toBe(true);
    expect(kept?.classList.contains('cinder-grouped-list-item--arriving')).toBe(false);
  });

  test('on a resync the rows are replaced in one step by the window’s newest, keeping a row still in it', async () => {
    const { world, container } = await ready(sampleReplay);
    await waitUntil(() => rowsOf(container).length === 3);
    const refund = rowsOf(container)[0];
    // The connection drops; the reconnect replays what was missed, which the source holds back.
    world.hub.end('bureau');
    await waitUntil(() => world.bureauEvents.reconnectAttempt === 1);
    world.bureauEvents.retryNow();
    await waitUntil(() => world.hub.opened('bureau') === 2);
    world.hub.write(
      'bureau',
      bureauEnvelope('b:5', 'chat.started', TODAY + 1_000),
      bureauEnvelope('b:6', 'run.failed', TODAY + 2_000, { runId: 'run-8' }),
    );
    // Held back until the replay ends: the rows on screen stay as they are.
    await quietFor(20);
    expect(titlesOf(container)[0]).toBe('Refund order 4471 waits on you');
    world.hub.write('bureau', REPLAY_COMPLETE_CHUNK);
    await waitUntil(() => titlesOf(container)[0] === 'Release notes digest failed');
    expect(titlesOf(container)).toEqual([
      'Release notes digest failed',
      'Chat started with Assistant',
      'Refund order 4471 waits on you',
    ]);
    // One window read for the resync, every retained envelope at once.
    expect(world.formatCalls.at(-1)).toHaveLength(6);
    // The row still in the window kept its node; the replacement does not animate.
    expect(rowsOf(container)[2]).toBe(refund);
    for (const row of rowsOf(container)) {
      expect(row.classList.contains('cinder-grouped-list-item--arriving')).toBe(false);
    }
  });

  test('holds arrivals while focus is in the list, and applies them in one step when it leaves', async () => {
    const { world, container } = await ready(sampleReplay);
    await waitUntil(() => rowsOf(container).length === 3);
    const link = rowsOf(container)[0]?.querySelector('a');
    if (link === null || link === undefined) throw new Error('no link');
    link.focus();
    await fireEvent.focusIn(link);
    world.hub.write('bureau', bureauEnvelope('b:5', 'chat.started', ACTIVITY_NOW - 30_000));
    await waitUntil(() => world.formatCalls.length === 2);
    await quietFor(20);
    expect(titlesOf(container)[0]).toBe('Refund order 4471 waits on you');
    expect(document.activeElement).toBe(link);
    await fireEvent.focusOut(link, { relatedTarget: document.body });
    await waitUntil(() => titlesOf(container)[0] === 'Chat started with Assistant');
    expect(rowsOf(container)).toHaveLength(3);
  });

  test('holds arrivals while a mouse rests on the list, with no time limit', async () => {
    const { world, container } = await ready(sampleReplay);
    await waitUntil(() => rowsOf(container).length === 3);
    const list = band(container).querySelector('ul')?.parentElement?.parentElement;
    if (list === null || list === undefined) throw new Error('no list');
    await fireEvent.pointerEnter(list, { pointerType: 'mouse' });
    world.hub.write('bureau', bureauEnvelope('b:5', 'chat.started', ACTIVITY_NOW - 30_000));
    await waitUntil(() => world.formatCalls.length === 2);
    await quietFor(20);
    expect(titlesOf(container)[0]).toBe('Refund order 4471 waits on you');
    await fireEvent.pointerLeave(list, { pointerType: 'mouse' });
    await waitUntil(() => titlesOf(container)[0] === 'Chat started with Assistant');
  });
});

describe('Agent activity words what it cannot word (AC2, AC3)', () => {
  test('an unclaimed kind is titled in plain words without exposing the kind code', async () => {
    const { container } = await ready([
      bureauEnvelope('b:1', 'goal.attempt.started', TODAY, { goalRunId: 'run-goal' }),
    ]);
    await waitUntil(() => rowsOf(container).length === 1);
    const [row] = rowsOf(container);
    expect(titlesOf(container)).toEqual(['Goal attempt started']);
    expect(row?.textContent).not.toContain('goal.attempt.started');
    expect(row?.querySelector('.cinder-grouped-list-item__subtitle')).toBeNull();
    expect(row?.querySelector('.cinder-badge')).toBeNull();
    expect(row?.querySelector('a')?.getAttribute('href')).toBe('/runs/run-goal');
  });

  test('a failed format call lists its events in the same form, newest first, with no error anywhere', async () => {
    const opened = open();
    opened.world.failFormat = true;
    await waitUntil(() => opened.world.hub.opened('bureau') === 1);
    opened.world.hub.write('bureau', ...sampleReplay, REPLAY_COMPLETE_CHUNK);
    await waitUntil(() => rowsOf(opened.container).length === 3);
    expect(titlesOf(opened.container)).toEqual([
      'Review requested',
      'Run failed',
      'Goal attempt started',
    ]);
    const card = band(opened.container);
    expect(card.querySelector('code')).toBeNull();
    expect(rowsOf(opened.container)[1]?.querySelector('a')?.getAttribute('href')).toBe(
      '/runs/run-7',
    );
    expect(card.querySelector('.cinder-badge')).toBeNull();
    expect(
      card.querySelector('[role="alert"], [data-testid="home-card-error"], button'),
    ).toBeNull();
    expect(card.textContent).not.toMatch(/couldn|error|stopped|try again/i);
  });
});

describe('Agent activity when its feed cannot be read', () => {
  test('after Try again, a connection that answers and then drops says so at once', async () => {
    const opened = open((prepared) => {
      prepared.hub.refusals.bureau = 503;
    });
    const { container } = opened;
    const failure = () => band(container).querySelector('[data-testid="home-card-error"]');
    await waitUntil(() => failure() !== null);
    const retry = within(band(container)).getByRole('button', { name: 'Try again' });
    await fireEvent.click(retry);
    await waitUntil(() => opened.world.hub.opened('bureau') === 1);
    expect(failure()).toBeNull();
    // The feed delivers an event, which starts the source's attempt count again at 0 (a
    // heartbeat or an error frame does not), and then drops before its replay ends: the attempt is
    // 1 again, as it was when Try again was pressed.
    opened.world.hub.write('bureau', envelopeChunk({ kind: 'run.settled', cursor: 'a:1' }));
    await waitUntil(() => opened.world.bureauEvents.reconnectAttempt === 0);
    opened.world.hub.end('bureau');
    await waitUntil(() => opened.world.bureauEvents.reconnectAttempt === 1);
    await waitUntil(() => failure() !== null);
    expect(band(container).querySelector('.cinder-skeleton-grouped-row')).toBeNull();
  });
});

describe('Agent activity links (AC4)', () => {
  test('a row opens its link inside the application', async () => {
    const { container } = await ready(sampleReplay);
    await waitUntil(() => rowsOf(container).length === 3);
    const link = rowsOf(container)[1]?.querySelector('a');
    if (link === null || link === undefined) throw new Error('no link');
    await fireEvent.click(link);
    expect(router.current.route?.pattern).toBe('/runs/:run');
  });
});
