/**
 * `/goals` (COR-2017, design rows 10s, 10t, 10u, 67c, 68h to 68j, 68n, 68x, 68y and 04m): the
 * caller's goals as status-first rows under their days, newest first, each titled by the goal's
 * name with the agent, the attempts bar and the check on line two; the segments and the Agent chip;
 * and the states that keep the header (nothing yet, filters that match nothing, a read that failed).
 *
 * Driven through the route outlet against a stand-in Bureau that keeps the goals, so the route, the
 * view frame and the page are exercised together. The placeholders and their timings are
 * `goal-list-loading.test.ts`; what a row says is `goal-rows.test.ts`.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { GOALS_COPY, RETRY_LABEL, VIEW_COPY } from '../../app/copy.ts';
import RouteOutletHarness from '../../app/shell/route-outlet.test-harness.svelte';
import { goalFixture } from '../../lib/bureau-fixtures.test-support.ts';
import type { Goal } from '../../lib/bureau-goals.ts';
import {
  installBureauStub,
  StubFault,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import { landAt } from '../chat/pages.test-support.ts';

let stub: BureauStub | undefined;
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

const AGENTS = [
  { name: 'assistant', displayName: 'Assistant' },
  { name: 'tool-runner', displayName: 'Tool runner' },
].map((agent) => ({
  ...agent,
  description: null,
  definitionRevision: 1,
  kind: 'code',
  a2a: false,
}));

const BOUNDS = (maximumAttempts: number) => ({
  maximumAttempts,
  maximumTotalDurationMs: null,
  maximumTotalSteps: null,
  maximumTotalTokens: null,
  maximumTotalCostUsd: null,
});

const USAGE = (attempts: number) => ({
  attempts,
  steps: 0,
  tokens: 0,
  costUsd: null,
  durationMs: 0,
});

/** The sample world's three goals, as the Bureau lists them: oldest first. */
function sampleGoals(): Goal[] {
  return [
    goalFixture('goal-hello', {
      identity: { name: 'Say hello', version: '1' },
      validator: { name: 'reply-says-hello', version: '1' },
      agentName: 'assistant',
      status: 'succeeded',
      createdAt: '2026-10-30T12:48:00.000Z',
      bounds: BOUNDS(1),
      usage: { ...USAGE(1), durationMs: 8_000 },
    }),
    goalFixture('goal-draft', {
      identity: { name: 'Draft release notes', version: '1' },
      validator: { name: 'notes-mention-the-staging-fix', version: '1' },
      agentName: 'assistant',
      status: 'exhausted',
      createdAt: '2026-10-30T13:12:00.000Z',
      bounds: BOUNDS(5),
      usage: USAGE(5),
    }),
    goalFixture('goal-summarize', {
      identity: { name: 'Summarize open refunds', version: '1' },
      validator: { name: 'summary-lists-every-refund-waiting-for-approval', version: '1' },
      agentName: 'tool-runner',
      status: 'canceled',
      createdAt: '2026-10-30T15:05:00.000Z',
      bounds: BOUNDS(5),
      usage: USAGE(2),
    }),
  ];
}

function open(goals: Goal[], path = '/goals') {
  stub = installBureauStub({
    'bureau.agents.list': () => ({ agents: AGENTS }),
    'bureau.goals.list': () => ({ goals, nextOffset: null }),
  });
  landAt(path);
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
}

const rows = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>('[data-goal]'),
];
const rowIds = (container: HTMLElement) => rows(container).map((row) => row.dataset['goal']);
const row = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-goal="${id}"]`);
const frameState = (container: HTMLElement) =>
  container.querySelector('[data-view="goals"]')?.getAttribute('data-state');

/** A filter segment by its word and its count, whose accessible name is "All, 3". */
function segment(view: ReturnType<typeof within>, word: string, count: number): HTMLElement {
  return view.getByRole('radio', { name: new RegExp(`^${word}\\s*,\\s*${String(count)}$`) });
}

describe('the goals', () => {
  test('are rows newest first, each titled by its name, with its status word and a link to its page', async () => {
    const view = open(sampleGoals());

    await waitFor(() => expect(rows(view.container)).toHaveLength(3));
    expect(rowIds(view.container)).toEqual(['goal-summarize', 'goal-draft', 'goal-hello']);
    expect(rows(view.container).map((goal) => goal.dataset['statusWord'])).toEqual([
      'Stopped',
      'Gave up',
      'Done',
    ]);
    const first = within(row(view.container, 'goal-summarize') as HTMLElement);
    const title = first.getByRole('link', { name: 'Summarize open refunds' });
    expect(title.getAttribute('href')).toBe('/goals/goal-summarize');
    expect(first.getByText('Stopped')).not.toBeNull();
    expect(frameState(view.container)).toBe('ready');
  });

  test('say the agent, the attempts bar with its count, and the check on line two', async () => {
    const view = open(sampleGoals());
    await waitFor(() => expect(rows(view.container)).toHaveLength(3));

    const first = row(view.container, 'goal-summarize') as HTMLElement;
    expect(first.textContent).toContain('Tool runner');
    expect(first.textContent).toContain('2 of 5');
    expect(first.textContent).toContain('Check: Summary lists every refund waiting for approval');
    expect(within(first).getByRole('img', { name: '2 of 5 attempts' })).not.toBeNull();
    const second = row(view.container, 'goal-draft') as HTMLElement;
    expect(second.textContent).toContain('5 of 5');
    expect(second.textContent).toContain('Check: Notes mention the staging fix');
    expect(within(second).getByRole('img', { name: '5 of 5 attempts' })).not.toBeNull();
    const third = row(view.container, 'goal-hello') as HTMLElement;
    expect(within(third).getByRole('img', { name: '1 of 1 attempts' })).not.toBeNull();
  });

  test('open the goal’s page from the title, and leave a modified click to the browser', async () => {
    const view = open(sampleGoals());
    const link = await view.findByRole('link', { name: 'Say hello' });

    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    expect(router.pathname).toBe('/goals');
    link.click();

    expect(router.pathname).toBe('/goals/goal-hello');
  });

  test('are every goal the Bureau holds, whatever page it lists them on, so the counts are of all of them', async () => {
    const all = sampleGoals();
    stub = installBureauStub({
      'bureau.agents.list': () => ({ agents: AGENTS }),
      // The Bureau never answers more than two goals at a time, however many are asked for.
      'bureau.goals.list': (params) => {
        const offset = typeof params['offset'] === 'number' ? params['offset'] : 0;
        return {
          goals: all.slice(offset, offset + 2),
          nextOffset: all.length > offset + 2 ? offset + 2 : null,
        };
      },
    });
    landAt('/goals');
    const view = render(RouteOutletHarness, {
      props: {
        client: new HttpClient({ baseUrl: 'http://localhost/api' }),
        scopes: AUTHORIZATION_SCOPES,
      },
    } as never);

    await waitFor(() => expect(rows(view.container)).toHaveLength(3));
    expect(segment(view, 'All', 3)).not.toBeNull();
  });

  test('count a running goal under Running, whatever its attempt waits for, in a day of its own', async () => {
    const today = new Date().toISOString();
    const view = open([
      ...sampleGoals(),
      goalFixture('goal-refund', {
        identity: { name: 'Refund damaged orders', version: '1' },
        validator: { name: 'every-damaged-order-from-today-is-refunded', version: '1' },
        agentName: 'tool-runner',
        status: 'running',
        createdAt: today,
        bounds: BOUNDS(5),
        usage: USAGE(1),
      }),
    ]);

    await waitFor(() => expect(rows(view.container)).toHaveLength(4));
    // It is the newest, so it is first, and its day is Today.
    expect(rowIds(view.container)[0]).toBe('goal-refund');
    expect(row(view.container, 'goal-refund')?.dataset['statusWord']).toBe('Running');
    expect(view.container.textContent).toContain(`${GOALS_COPY.band.today},`);
    const bar = within(view.container);
    expect(segment(bar, 'All', 4)).not.toBeNull();
    expect(segment(bar, 'Running', 1)).not.toBeNull();
  });

  test('say a goal asked to stop is still running, with a qualifier and not a new word', async () => {
    const view = open([
      goalFixture('goal-stopping', {
        status: 'evaluating',
        cancellation: { requestedAt: '2026-10-19T08:06:00.000Z', reason: null },
      }),
    ]);

    await waitFor(() => expect(rows(view.container)).toHaveLength(1));
    expect(row(view.container, 'goal-stopping')?.dataset['statusWord']).toBe('Running, stopping');
    expect(row(view.container, 'goal-stopping')?.textContent).toContain(GOALS_COPY.stopping);
  });
});

describe('the header and the filters', () => {
  test('keep the heading, its line and a secondary "+" that makes a goal', async () => {
    const view = open(sampleGoals());
    await waitFor(() => expect(rows(view.container)).toHaveLength(3));

    expect(view.getByRole('heading', { level: 1, name: VIEW_COPY.goals.label })).not.toBeNull();
    expect(view.container.textContent).toContain(GOALS_COPY.subtitle);
    const create = view.getByRole('button', { name: GOALS_COPY.newAction });
    await fireEvent.click(create);
    expect(router.pathname).toBe('/goals/new');
  });

  test('have a segment for each ending with its count, and the Agent chip beside them', async () => {
    const view = open(sampleGoals());
    await waitFor(() => expect(rows(view.container)).toHaveLength(3));

    expect(segment(view, 'All', 3)).not.toBeNull();
    expect(segment(view, 'Running', 0)).not.toBeNull();
    expect(segment(view, 'Done', 1)).not.toBeNull();
    expect(segment(view, 'Gave up', 1)).not.toBeNull();
    expect(segment(view, 'Stopped', 1)).not.toBeNull();
    expect(view.getByRole('button', { name: /Agent/ })).not.toBeNull();
  });

  test('narrow the list by a segment, and put it in the address', async () => {
    const view = open(sampleGoals());
    await waitFor(() => expect(rows(view.container)).toHaveLength(3));

    await fireEvent.click(segment(view, 'Gave up', 1));

    await waitFor(() => expect(router.search.get('status')).toBe('gave-up'));
    await waitFor(() => expect(rowIds(view.container)).toEqual(['goal-draft']));
  });

  test('read the address, so a filtered list can be shared', async () => {
    const view = open(sampleGoals(), '/goals?status=done');

    await waitFor(() => expect(rowIds(view.container)).toEqual(['goal-hello']));
    expect(segment(view, 'Done', 1).getAttribute('aria-checked')).toBe('true');
  });
});

describe('filters that match nothing', () => {
  test('keep the filter bar over a state that names the agent and offers Clear filters', async () => {
    const view = open(sampleGoals(), '/goals?status=gave-up&agent=tool-runner');

    await view.findByRole('heading', { level: 2, name: GOALS_COPY.noMatch.title });
    // The agent’s display name is read from the catalog, so the sentence settles once it arrives.
    await view.findByText('Tool runner hasn’t given up on any goal. Try another status or agent.');
    expect(frameState(view.container)).toBe('ready');
    // The counts are those of the goals the agent chip leaves: one goal is Tool runner’s.
    expect(segment(view, 'All', 1)).not.toBeNull();
    expect(segment(view, 'Gave up', 0)).not.toBeNull();
    expect(view.getByRole('heading', { level: 1, name: VIEW_COPY.goals.label })).not.toBeNull();

    const clear = view.container.querySelector<HTMLButtonElement>(
      '[data-cinder-kind="filtered"] button',
    );
    if (clear === null) throw new Error('The empty state did not offer Clear filters.');
    expect(clear.textContent).toContain(GOALS_COPY.clearAction);
    await fireEvent.click(clear);

    await waitFor(() => expect(router.search.get('status')).toBeNull());
    await waitFor(() => expect(rows(view.container)).toHaveLength(3));
  });
});

describe('nothing yet', () => {
  test('is an empty state that is the page: the header and its "+" stay, with no filter bar and one primary button', async () => {
    const view = open([]);

    await view.findByRole('heading', { level: 2, name: GOALS_COPY.empty.title });
    expect(view.container.textContent).toContain(GOALS_COPY.empty.description);
    expect(view.getByRole('heading', { level: 1, name: VIEW_COPY.goals.label })).not.toBeNull();
    expect(view.container.textContent).toContain(GOALS_COPY.subtitle);
    expect(view.queryByRole('search')).toBeNull();
    expect(frameState(view.container)).toBe('empty');

    // The header's "+" and the state's primary button both make a goal; only the state's is primary.
    const makers = view.getAllByRole('button', { name: GOALS_COPY.newAction });
    expect(makers).toHaveLength(2);
    const stateButton = view.container.querySelector<HTMLElement>(
      '[data-cinder-kind="first-use"] button',
    );
    expect(stateButton).not.toBeNull();
    await fireEvent.click(stateButton as HTMLElement);
    expect(router.pathname).toBe('/goals/new');
  });
});

describe('a read that failed with nothing to show', () => {
  function openFailing() {
    let failing = true;
    stub = installBureauStub({
      'bureau.agents.list': () => ({ agents: AGENTS }),
      'bureau.goals.list': () => {
        if (failing) throw new StubFault('Unavailable', 503, 'The Bureau is down.');
        return { goals: sampleGoals(), nextOffset: null };
      },
    });
    landAt('/goals');
    const view = render(RouteOutletHarness, {
      props: {
        client: new HttpClient({ baseUrl: 'http://localhost/api' }),
        scopes: AUTHORIZATION_SCOPES,
      },
    } as never);
    return {
      view,
      recover: () => {
        failing = false;
      },
    };
  }

  test('is the full error state under the header, with Try again, Check Health and no banner beside it', async () => {
    const { view } = openFailing();

    await view.findByRole('heading', { level: 2, name: GOALS_COPY.failed.title });
    expect(view.getByRole('heading', { level: 1, name: VIEW_COPY.goals.label })).not.toBeNull();
    expect(view.getByRole('button', { name: RETRY_LABEL })).not.toBeNull();
    expect(
      view.getByRole('link', { name: GOALS_COPY.failed.openHealth }).getAttribute('href'),
    ).toBe(GOALS_COPY.failed.openHealthPath);
    // The header’s "+" is inert, and says why, until the goals load.
    expect(
      view.getByRole('button', { name: GOALS_COPY.newAction }).getAttribute('aria-disabled'),
    ).toBe('true');
    expect(view.queryByRole('search')).toBeNull();
    expect(rows(view.container)).toHaveLength(0);
  });

  test('reads the goals again when Try again is chosen', async () => {
    const { view, recover } = openFailing();
    await view.findByRole('heading', { level: 2, name: GOALS_COPY.failed.title });

    recover();
    await fireEvent.click(view.getByRole('button', { name: RETRY_LABEL }));

    await waitFor(() => expect(rows(view.container)).toHaveLength(3));
    expect(view.queryByRole('heading', { level: 2, name: GOALS_COPY.failed.title })).toBeNull();
  });
});

describe('who may see the goals', () => {
  test('a principal holding no console scope sees its goals, not a forbidden view', async () => {
    stub = installBureauStub({
      'bureau.agents.list': () => ({ agents: AGENTS }),
      'bureau.goals.list': () => ({ goals: sampleGoals(), nextOffset: null }),
    });
    landAt('/goals');
    const view = render(RouteOutletHarness, {
      props: { client: new HttpClient({ baseUrl: 'http://localhost/api' }), scopes: [] },
    } as never);

    await waitFor(() => expect(rows(view.container)).toHaveLength(3));
    expect(frameState(view.container)).toBe('ready');
  });

  test('a refusal from the Bureau is the forbidden state', async () => {
    stub = installBureauStub({
      'bureau.goals.list': () => {
        throw new StubFault('Forbidden', 403, 'Not yours.');
      },
    });
    landAt('/goals');
    const view = render(RouteOutletHarness, {
      props: {
        client: new HttpClient({ baseUrl: 'http://localhost/api' }),
        scopes: AUTHORIZATION_SCOPES,
      },
    } as never);

    await view.findByRole('heading', { level: 1, name: VIEW_COPY.goals.forbidden.title });
    expect(frameState(view.container)).toBe('forbidden');
  });
});
