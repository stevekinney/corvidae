/**
 * Home while it loads and when a read fails (design rows 01n, 01o, 02c to 02f, 02h to 02j): nothing
 * is drawn for the first 300 ms and then placeholders in the page's own layout, with real text
 * where the design says real; after ten seconds Cinder `skeleton`'s own status line and a Cancel,
 * and "Loading canceled" with Try again once it is pressed; one card that cannot be read says so
 * in its own place with Try again while every other card (the counts included) stays live; and a
 * server that does not answer with nothing loaded is the full error state. The Bureau answers as
 * the sample world does (`home-test-support.test-support.ts`), and each test holds or breaks the
 * one read it is about.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  setSystemTime,
  test,
} from 'bun:test';
import { Window } from 'happy-dom';
import { flushSync } from 'svelte';

import { CONNECTION_COPY } from '../../app/copy/views.ts';
import { StubFault } from '../../lib/bureau-stub.test-support.ts';
import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import HomeHarness from './home-test-harness.test-harness.svelte';
import {
  HOME_NOW,
  installHome,
  SAMPLE_ATTENTION,
  SAMPLE_CHATS,
  sampleHomeWorld,
  type InstalledHome,
} from './home-test-support.test-support.ts';

let installed: InstalledHome | undefined;
let restoreFetch: (() => void) | undefined;

// The zone in effect now is the one to give back; `bun test` runs in UTC without naming it in `TZ`.
const previousZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

beforeAll(() => {
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
  jest.useRealTimers();
  restoreFetch?.();
  restoreFetch = undefined;
  installed?.restore();
  installed = undefined;
  setSystemTime();
});

/** A promise that settles when `release` is called, to hold a read open for as long as a test needs. */
function holdOpen(): { readonly released: Promise<void>; release(): void } {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { released, release };
}

function cardOf(container: HTMLElement, title: string): HTMLElement {
  const card = container.querySelector<HTMLElement>(`[data-home-card="${title}"]`);
  if (card === null) throw new Error(`no ${title} card`);
  return card;
}

const words = (element: Element): string =>
  element.textContent?.replaceAll(/\s+/g, ' ').trim() ?? '';

describe('Home while it loads (02c, 02d)', () => {
  test('draws nothing for 300 ms, then placeholders in the real layout, with real labels and headings', async () => {
    installed = installHome(sampleHomeWorld());
    const hold = holdOpen();
    installed.stub.on('bureau.contexts.list', async () => {
      await hold.released;
      return { contexts: SAMPLE_CHATS, nextOffset: null };
    });
    const { container, getByTestId, queryByTestId } = render(HomeHarness, {
      props: { client: installed.client },
    } as never);
    // The first 300 ms: nothing is drawn in the page body, not even the date line.
    expect(container.querySelector('[data-page="home"]')).toBeNull();
    expect(queryByTestId('home-date')).toBeNull();

    await waitFor(() => expect(container.querySelector('[data-page="home"]')).not.toBeNull());
    const page = container.querySelector('[data-page="home"]');
    expect(page?.getAttribute('data-mode')).toBe('loading');
    // The page region is marked busy.
    expect(page?.getAttribute('aria-busy')).toBe('true');
    // The date line, the count's label and the four headings are real text.
    expect(words(getByTestId('home-date'))).toBe(
      'Monday, Nov 2. Times show in Central time (CST).',
    );
    // The Spotlight is a placeholder block, and the count under it a label over a placeholder.
    const focus = getByTestId('home-loading-focus');
    expect(focus.firstElementChild?.classList.contains('cinder-skeleton')).toBe(true);
    const stats = [...getByTestId('home-loading-counts').querySelectorAll('.cinder-statistic')];
    expect(
      stats.map((stat) => words(stat.querySelector('.cinder-statistic__label') as Element)),
    ).toEqual(['Failed in 24 hours']);
    // The value is a placeholder, and no number is read before it is.
    expect(stats.every((stat) => stat.querySelector('.cinder-skeleton') !== null)).toBe(true);
    expect(
      stats.every(
        (stat) => words(stat.querySelector('.cinder-statistic__value') as Element) === '',
      ),
    ).toBe(true);
    expect(
      [...container.querySelectorAll('h2')].map((heading) => heading.textContent?.trim()),
    ).toEqual(['Needs attention', 'Start a chat', 'Recent chats']);
    // The Needs you rows have no heading, as the loaded ones do: the Spotlight is their title.
    expect(cardOf(container, 'Needs you').querySelector('h2')).toBeNull();
    // Rows are Cinder's grouped placeholders, with a button block where a row has a button.
    const placeholders = [
      ...container.querySelectorAll('.cinder-skeleton-group[data-cinder-variant="grouped"]'),
    ];
    expect(placeholders).toHaveLength(3);
    expect(
      placeholders.map((group) => group.querySelectorAll('.cinder-skeleton-action-bar').length),
    ).toEqual([2, 3, 0]);
    // The composer is a placeholder too: no list, no link, no message box.
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('[role="listitem"], [role="list"]')).toBeNull();
    // The links to the pages that hold the rest wait for the rows.
    expect(container.querySelector('a')).toBeNull();
    // The h1 is there for screen readers all the while.
    expect(container.querySelector('h1.cinder-sr-only')?.textContent).toBe('Home');

    hold.release();
    await waitFor(() => expect(container.querySelector('[data-mode="overview"]')).not.toBeNull());
    expect(container.querySelector('[data-page="home"]')?.hasAttribute('aria-busy')).toBe(false);
    expect(container.querySelector('[data-testid="home-loading-counts"]')).toBeNull();
  });

  test('the placeholders have the layout of the page they stand for', async () => {
    // The loading page and the page share one layout component, so the same four cards sit in the
    // same two columns and the placeholders keep a card's own title row.
    installed = installHome(sampleHomeWorld());
    const hold = holdOpen();
    installed.stub.on('bureau.contexts.list', async () => {
      await hold.released;
      return { contexts: SAMPLE_CHATS, nextOffset: null };
    });
    const { container } = render(HomeHarness, { props: { client: installed.client } } as never);
    await waitFor(() => expect(container.querySelector('[data-mode="loading"]')).not.toBeNull());
    expect(container.querySelector('.ib-home__columns .ib-home__main')).not.toBeNull();
    expect(container.querySelector('.ib-home__columns > .ib-home__start-chat')).not.toBeNull();
    expect(container.querySelector('.ib-home__needs-attention')).not.toBeNull();
    hold.release();
    await waitFor(() => expect(container.querySelector('[data-mode="overview"]')).not.toBeNull());
    expect(container.querySelector('.ib-home__columns > .ib-home__start-chat')).not.toBeNull();
  });
});

describe('Home while it loads slowly (02e, 02f)', () => {
  test('after 10 s shows the skeleton’s own status line with a ghost Cancel, and Cancel says Loading canceled with Try again', async () => {
    installed = installHome(sampleHomeWorld());
    const hold = holdOpen();
    installed.stub.on('bureau.contexts.list', async () => {
      await hold.released;
      return { contexts: SAMPLE_CHATS, nextOffset: null };
    });
    jest.useFakeTimers();
    jest.setSystemTime(new Date(HOME_NOW));
    const { container, getByRole, getByTestId, queryByTestId } = render(HomeHarness, {
      props: { client: installed.client },
    } as never);
    flushSync();
    jest.advanceTimersByTime(299);
    flushSync();
    expect(container.querySelector('[data-page="home"]')).toBeNull();
    jest.advanceTimersByTime(1);
    flushSync();
    expect(container.querySelector('[data-mode="loading"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Still loading Home.');
    jest.advanceTimersByTime(9_699);
    flushSync();
    expect(container.textContent).not.toContain('Still loading Home.');
    jest.advanceTimersByTime(1);
    flushSync();

    // The status line is Cinder skeleton's own, above the placeholders (COR-2329: below them it was
    // drawn under the fold), and not a banner.
    const status = [...container.querySelectorAll('[role="status"]')].find((element) =>
      element.textContent?.includes('Still loading Home.'),
    );
    expect(words(status as Element)).toContain(
      'Still loading Home. This is taking longer than usual.',
    );
    expect(container.querySelector('.cinder-banner')).toBeNull();
    const page = container.querySelector('[data-mode="loading"]');
    expect(
      (status as Element).compareDocumentPosition(page as Element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const cancel = within(status as HTMLElement).getByRole('button', { name: 'Cancel' });
    expect(cancel.getAttribute('data-cinder-variant')).toBe('ghost');

    await fireEvent.click(cancel);
    flushSync();
    // The page keeps its date line, and says the load was canceled in place of the cards.
    expect(container.querySelector('[data-mode="canceled"]')).not.toBeNull();
    expect(words(getByTestId('home-date'))).toBe(
      'Monday, Nov 2. Times show in Central time (CST).',
    );
    expect(container.querySelector('h1.cinder-sr-only')?.textContent).toBe('Home');
    const stopped = getByTestId('home-canceled');
    expect(words(stopped)).toContain('Loading canceled');
    expect(container.querySelector('[data-home-card]')).toBeNull();
    expect(queryByTestId('home-loading-counts')).toBeNull();

    // Try again asks the reads again, and the page is drawn from what they answer.
    hold.release();
    jest.useRealTimers();
    await fireEvent.click(getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(container.querySelector('[data-mode="overview"]')).not.toBeNull());
    expect(container.querySelector('[data-testid="home-canceled"]')).toBeNull();
  });
});

describe('One card that cannot be read (01n, 01o)', () => {
  /** The sample world with the first read of the problems failing, then answering. */
  function attentionFailsOnce(): { calls(): number; heal(): void } {
    let calls = 0;
    let healed = false;
    installed?.stub.on('bureau.health.attention', () => {
      calls += 1;
      // The first call is Home's: it fails once, and the section's Try again heals it.
      if (!healed && calls === 1) throw new StubFault('Unavailable', 503, 'Unavailable');
      return { items: SAMPLE_ATTENTION, count: SAMPLE_ATTENTION.length, checks: [] };
    });
    return { calls: () => calls, heal: () => (healed = true) };
  }

  test('Needs attention says what it could not load, with Try again, while every other card stays live', async () => {
    installed = installHome(sampleHomeWorld());
    attentionFailsOnce();
    const { container, getByTestId } = render(HomeHarness, {
      props: { client: installed.client },
    } as never);
    await waitFor(() => expect(container.querySelector('[data-mode="overview"]')).not.toBeNull());
    const card = cardOf(container, 'Needs attention');
    const failure = await within(card).findByTestId('home-card-error');
    expect(words(failure)).toBe(
      'Couldn’t load system problems. The rest of Home is live. Try again',
    );
    expect(within(card).getByRole('button', { name: 'Try again' })).not.toBeNull();
    // The failed card draws no link to Health and no row, and never claims all is well.
    expect(within(card).queryByRole('link')).toBeNull();
    expect(container.querySelector('[data-testid="attention-clear"]')).toBeNull();
    // The Spotlight and the count have reads of their own: they are unchanged.
    await waitFor(() => expect(words(getByTestId('home-spotlight'))).toBe('2 need you'));
    await waitFor(() =>
      expect(
        [...getByTestId('home-counts').querySelectorAll('.cinder-statistic')].map(words),
      ).toEqual(['Failed in 24 hours 0']),
    );
    // Needs you, Start a chat and Recent chats render normally.
    expect(within(cardOf(container, 'Needs you')).getAllByRole('listitem')).toHaveLength(2);
    expect(container.querySelector('textarea')).not.toBeNull();
    expect(within(cardOf(container, 'Recent chats')).getAllByRole('listitem')).toHaveLength(3);
  });

  test('Try again asks that card’s read again, and the rows replace the failure', async () => {
    installed = installHome(sampleHomeWorld());
    const control = attentionFailsOnce();
    const { container } = render(HomeHarness, { props: { client: installed.client } } as never);
    await waitFor(() => expect(container.querySelector('[data-mode="overview"]')).not.toBeNull());
    const card = cardOf(container, 'Needs attention');
    await within(card).findByTestId('home-card-error');
    control.heal();
    await fireEvent.click(within(card).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(within(card).getAllByRole('listitem')).toHaveLength(3));
    expect(within(card).queryByTestId('home-card-error')).toBeNull();
    expect(within(card).getByRole('link', { name: 'Open Health' })).not.toBeNull();
  });

  test('Needs you and Recent chats each say what they could not load in their own card', async () => {
    installed = installHome(sampleHomeWorld());
    installed.stub.on('bureau.reviews.list', () => {
      throw new StubFault('Unavailable', 503, 'Unavailable');
    });
    installed.stub.on('bureau.contexts.list', () => {
      throw new StubFault('Unavailable', 503, 'Unavailable');
    });
    const { container } = render(HomeHarness, { props: { client: installed.client } } as never);
    await waitFor(() => expect(container.querySelector('[data-mode="overview"]')).not.toBeNull());
    // The section is a new element once it fails (it takes its heading back), so it is looked up
    // again on every try.
    const needsYouFailure = await waitFor(() =>
      within(cardOf(container, 'Needs you')).getByTestId('home-card-error'),
    );
    expect(words(needsYouFailure)).toBe(
      'Couldn’t load what needs you. The rest of Home is live. Try again',
    );
    // No Spotlight stands over the failure, so the section takes its own heading back.
    expect(container.querySelector('[data-testid="home-spotlight"]')).toBeNull();
    expect(
      within(cardOf(container, 'Needs you')).getByRole('heading', { level: 2, name: 'Needs you' }),
    ).toBeDefined();
    expect(
      words(await within(cardOf(container, 'Recent chats')).findByTestId('home-card-error')),
    ).toBe('Couldn’t load recent chats. The rest of Home is live. Try again');
    // Needs attention is live.
    expect(within(cardOf(container, 'Needs attention')).getAllByRole('listitem')).toHaveLength(3);
  });

  test('Start a chat says it could not load the agents, with Try again', async () => {
    installed = installHome(sampleHomeWorld());
    installed.stub.on('bureau.agents.list', () => {
      throw new StubFault('Unavailable', 503, 'Unavailable');
    });
    const { getByTestId } = render(HomeHarness, { props: { client: installed.client } } as never);
    const card = await waitFor(() => getByTestId('home-start-chat'));
    await waitFor(() => expect(words(card)).toContain('Couldn’t load agents.'));
    expect(card.querySelector('textarea')).toBeNull();
  });
});

describe('Home when the server does not answer (02g to 02j)', () => {
  test('with nothing loaded the full error state shows, with Try again, and no cards', async () => {
    installed = installHome(sampleHomeWorld());
    restoreFetch = installFetchImplementation(() =>
      Promise.reject(new TypeError('Failed to fetch')),
    );
    const { container, getByTestId, getByRole } = render(HomeHarness, {
      props: { client: installed.client },
    } as never);
    const state = await waitFor(() => getByTestId('home-unreachable'));
    expect(container.querySelector('[data-mode="unreachable"]')).not.toBeNull();
    expect(words(state)).toContain(CONNECTION_COPY.page.title);
    expect(words(state)).toContain(CONNECTION_COPY.page.description);
    // In place, the button says Try again (a banner says Retry now).
    expect(getByRole('button', { name: 'Try again' })).not.toBeNull();
    expect(container.querySelector('[data-home-card]')).toBeNull();
    expect(container.querySelector('[data-testid="home-counts"]')).toBeNull();
    expect(container.querySelector('h1.cinder-sr-only')?.textContent).toBe('Home');
  });

  test('Try again reads again, and the page is drawn when the server answers', async () => {
    installed = installHome(sampleHomeWorld());
    const restore = installFetchImplementation(() =>
      Promise.reject(new TypeError('Failed to fetch')),
    );
    const { container, getByRole, getByTestId } = render(HomeHarness, {
      props: { client: installed.client },
    } as never);
    await waitFor(() => getByTestId('home-unreachable'));
    restore();
    await fireEvent.click(getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(container.querySelector('[data-mode="overview"]')).not.toBeNull());
    expect(container.querySelector('[data-testid="home-unreachable"]')).toBeNull();
  });

  test('old data keeps its place: the row buttons only open a page, so none carries the mark the shell holds, and links to read stay plain', async () => {
    installed = installHome(sampleHomeWorld());
    const { container, getByTestId } = render(HomeHarness, {
      props: { client: installed.client },
    } as never);
    await waitFor(() => expect(container.querySelector('[data-mode="overview"]')).not.toBeNull());
    await waitFor(() =>
      expect(within(cardOf(container, 'Needs attention')).getAllByRole('listitem')).toHaveLength(3),
    );
    await waitFor(() =>
      expect(within(cardOf(container, 'Needs you')).getAllByRole('listitem')).toHaveLength(2),
    );
    // COR-2329: each opens a page, as "Open Reviews" does, so none is held while the server does
    // not answer; holding them drew grey chips beside a live link to the same page.
    for (const name of [
      'Answer',
      'Review',
      'Review storage',
      'View schedule',
      'Connect a provider',
    ]) {
      const button = within(container).getByRole('link', { name });
      expect(button.hasAttribute('data-changes'), `${name} only opens a page`).toBe(false);
    }
    // Reading is not changing: the links to Reviews, Health and the chats are not marked.
    for (const link of [
      ...within(getByTestId('home-focus')).getAllByRole('link', { name: 'Open Reviews' }),
      ...within(cardOf(container, 'Needs attention')).getAllByRole('link', { name: 'Open Health' }),
    ]) {
      expect(link.hasAttribute('data-changes')).toBe(false);
    }
    expect(container.querySelector('[data-home-card="Recent chats"] [data-changes]')).toBeNull();
    // The composer's Send changes something (it is a submit button), and the agent can still be chosen.
    const card = getByTestId('home-start-chat');
    expect(within(card).getByRole('button', { name: 'Send' }).getAttribute('type')).toBe('submit');
  });
});
