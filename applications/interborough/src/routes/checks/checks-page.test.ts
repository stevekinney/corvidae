/**
 * `/checks` as a person works it (COR-2114): the results of every check, newest first, each a link
 * to its goal or its run; the Kind segments and the Check, Outcome, Agent and Time chips each change
 * the request the page sends and the rows it shows; a scorer's row carries its score and no message;
 * and the page says each state it can be in (rows C2-02, C2-03, C2-05 to C2-14, C2-17 to C2-24).
 * The Bureau is a table (`bureau-world.test-support.ts`) whose `bureau.checks.list` filters and
 * pages the way the operation does, so the page's requests are what is asserted.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { flushSync } from 'svelte';

import { CHECKS_COPY } from '../../app/copy/checks.ts';
import { TASK_COPY } from '../../app/copy/tasks.ts';
import { VIEW_COPY } from '../../app/copy/view-pages.ts';
import { RETRY_LABEL } from '../../app/copy/views.ts';
import RouteOutletHarness from '../../app/shell/route-outlet.test-harness.svelte';
import type { CheckRow } from '../../lib/bureau-checks.ts';
import { checkFixture } from '../../lib/bureau-fixtures.test-support.ts';
import { StubFault } from '../../lib/bureau-stub.test-support.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorldStub,
} from '../../lib/bureau-world.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import { landAt } from '../chat/pages.test-support.ts';

let stub: BureauWorldStub | undefined;
/** A read a test holds in progress, and lets go of when it is done with the page. */
let held = Promise.withResolvers<{ checks: CheckRow[]; nextCursor: null }>();
afterEach(() => {
  held.resolve({ checks: [], nextCursor: null });
  held = Promise.withResolvers();
  cleanup();
  stub?.restore();
  stub = undefined;
});

/** Newest first, one of each kind, a day apart from the next where the day band matters. */
const ROWS: readonly CheckRow[] = [
  checkFixture('a', {
    checkId: 'summary-lists-every-refund@3',
    agentName: 'tool-runner',
    outcome: 'fail',
    timestamp: '2026-10-19T10:05:00.000Z',
  }),
  checkFixture('b', {
    kind: 'scorer.recorded',
    checkId: 'politeness@2',
    agentName: 'assistant',
    outcome: 'pass',
    score: 0.82,
    goalRunId: null,
    attemptId: null,
    runId: 'run-scored',
    timestamp: '2026-10-19T09:12:00.000Z',
  }),
  checkFixture('c', {
    kind: 'run.tripwire',
    checkId: 'spend-limit',
    agentName: 'tool-runner',
    outcome: 'tripwire',
    goalRunId: null,
    attemptId: null,
    runId: 'run-tripped',
    timestamp: '2026-10-19T08:40:00.000Z',
  }),
  checkFixture('d', {
    kind: 'session.tainted',
    checkId: 'prompt-injection',
    agentName: 'tool-runner',
    outcome: 'tainted',
    goalRunId: null,
    attemptId: null,
    runId: 'run-flagged',
    timestamp: '2026-10-18T08:02:00.000Z',
  }),
  checkFixture('e', {
    kind: 'run.guardrail',
    checkId: 'pii-input',
    agentName: null,
    outcome: 'block',
    goalRunId: null,
    attemptId: null,
    runId: 'run-blocked',
    timestamp: '2026-10-18T07:00:00.000Z',
  }),
];

type Options = {
  readonly rows?: readonly CheckRow[];
  /** How many rows the Bureau puts on a page, however many are asked for. */
  readonly pageSize?: number;
  /** Fails the read of this page (0 is the first), with the status the Bureau would answer. */
  readonly failPage?: (
    index: number,
    params: Readonly<Record<string, unknown>>,
  ) => number | undefined;
  /** Never answers, so the read stays in progress. */
  readonly hold?: boolean;
};

function open(path: string, options: Options = {}) {
  const rows = options.rows ?? ROWS;
  const pageSize = options.pageSize ?? 50;
  stub = installBureauWorld(emptyBureauWorld());
  stub.on('bureau.agents.list', () => ({ agents: [] }));
  stub.on('bureau.checks.list', (params) => {
    if (options.hold === true) return held.promise;
    const offset = typeof params['cursor'] === 'string' ? Number(params['cursor']) : 0;
    const status = options.failPage?.(offset / pageSize, params);
    if (status !== undefined) throw new StubFault('EngineFailure', status, 'The Bureau broke.');
    const matching = rows.filter(
      (row) =>
        (params['kind'] === undefined || row.kind === params['kind']) &&
        (params['checkId'] === undefined || row.checkId === params['checkId']) &&
        (params['agentName'] === undefined || row.agentName === params['agentName']) &&
        (params['outcome'] === undefined || row.outcome === params['outcome']) &&
        (typeof params['since'] !== 'number' || Date.parse(row.timestamp) >= params['since']),
    );
    const page = matching.slice(offset, offset + pageSize);
    return {
      checks: page,
      nextCursor: offset + page.length < matching.length ? String(offset + page.length) : null,
    };
  });
  landAt(path);
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
}

const rowKinds = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-check-kind]')].map((row) =>
    row.getAttribute('data-check-kind'),
  );
const rowTitles = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-check-kind] .cinder-stacked-list-item__title')].map(
    (title) => title.textContent?.trim(),
  );
/** What the page asked for, leaving out the frame's own one-row probe. */
const sentList = () =>
  (stub?.callsTo('bureau.checks.list').map((call) => call.params) ?? []).filter(
    (params) => params['limit'] !== 1,
  );
const lastSent = () => sentList().at(-1) ?? {};

/** A chip's popover options, opened by the chip's own name. */
async function openChip(view: ReturnType<typeof open>, name: string): Promise<HTMLInputElement[]> {
  await fireEvent.click(view.getByRole('button', { name }));
  flushSync();
  await waitFor(() => expect(document.querySelector('.cinder-filter-bar__options')).not.toBeNull());
  return [
    ...document.querySelectorAll<HTMLInputElement>(
      '.cinder-filter-bar__options input[type="radio"]',
    ),
  ];
}

describe('the page', () => {
  test('is one Checks page with its description, no action beside the heading and one filter bar (C2-02, C2-03)', async () => {
    const view = open('/checks');
    await view.findByRole('heading', { level: 1, name: CHECKS_COPY.title });
    await waitFor(() => expect(rowKinds(view.container)).toHaveLength(5));
    expect(view.getByText(CHECKS_COPY.description)).not.toBeNull();
    const header = view.container.querySelector('.cinder-page-header');
    expect(header?.querySelectorAll('a, button')).toHaveLength(0);
    const bar = view.getByRole('search', { name: CHECKS_COPY.filtersLabel });
    expect(bar).not.toBeNull();
    // The Kind segments in order, with no counts (a count would join the name), then the four chips,
    // and no search.
    expect(view.getAllByRole('radio').map((radio) => radio.textContent?.trim())).toEqual([
      'All',
      'Goal checks',
      'Scorers',
      'Guardrails',
      'Tripwires',
      'Flagged sessions',
    ]);
    for (const label of Object.values(CHECKS_COPY.facets)) {
      expect(view.getByRole('button', { name: label })).not.toBeNull();
    }
    expect(view.queryByRole('searchbox')).toBeNull();
  });

  test('lists the results, each row a link to its goal or its run, never both and never a raw id (C2-08, C2-12, C2-14)', async () => {
    const view = open('/checks');
    await waitFor(() => expect(rowKinds(view.container)).toHaveLength(5));

    const hrefs = [...view.container.querySelectorAll('[data-check-kind]')].map((row) => {
      const links = row.querySelectorAll('a[href]');
      expect(links, row.textContent ?? '').toHaveLength(1);
      expect(row.querySelectorAll('button')).toHaveLength(0);
      return links[0]?.getAttribute('href');
    });
    // A goal's verdict opens its goal; every other row opens its run, a flagged session included.
    expect(hrefs).toEqual([
      '/goals/goal-a',
      '/runs/run-scored',
      '/runs/run-tripped',
      '/runs/run-flagged',
      '/runs/run-blocked',
    ]);
    expect(rowTitles(view.container)).toEqual([
      'Summary lists every refund',
      'Politeness',
      'Spend limit',
      'Prompt injection',
      'Pii input',
    ]);
    const text = view.container.textContent ?? '';
    for (const raw of [
      'goal.attempt.validated',
      'run.guardrail',
      'run.tripwire',
      'scorer.recorded',
      'session.tainted',
      '@3',
      'tripwire',
      'tainted',
      'run-scored',
      'goal-a',
    ]) {
      expect(text, raw).not.toContain(raw);
    }
  });

  test('says each outcome once, as its status word and nothing else (C2-10, C2-11)', async () => {
    const view = open('/checks');
    await waitFor(() => expect(rowKinds(view.container)).toHaveLength(5));

    const words = [...view.container.querySelectorAll('[data-check-kind]')].map((row) =>
      row.getAttribute('data-status'),
    );
    expect(words).toEqual(['Check not met', 'Check met', 'Tripped', 'Flagged', 'Blocked']);
    for (const row of view.container.querySelectorAll('[data-check-kind]')) {
      expect(row.querySelectorAll('.cinder-badge, .cinder-chip')).toHaveLength(0);
    }
  });

  test('says line two in the design’s order, and a scorer’s score and no message (C2-09, C2-13)', async () => {
    const view = open('/checks');
    await waitFor(() => expect(rowKinds(view.container)).toHaveLength(5));

    const lineTwo = [...view.container.querySelectorAll('[data-check-kind]')].map((row) =>
      row.querySelector('.cinder-stacked-list-item__meta')?.textContent?.trim(),
    );
    expect(lineTwo).toEqual([
      'Goal check, Tool runner, version 3',
      'Scorer, Assistant, score 0.82, version 2',
      'Tripwire, Tool runner',
      'Session, Tool runner',
      'Guardrail',
    ]);
  });

  test('groups the rows under day bands, newest first, once each (C2-07)', async () => {
    const view = open('/checks');
    await waitFor(() => expect(rowKinds(view.container)).toHaveLength(5));

    const bands = [...view.container.querySelectorAll('.cinder-data-list-group__label')].map(
      (band) => band.textContent?.trim(),
    );
    expect(bands).toHaveLength(new Set(bands).size);
    expect(bands.length).toBe(2);
  });
});

describe('the Kind segments', () => {
  test('each asks the operation for its kind, and the rows are what it answers', async () => {
    const view = open('/checks');
    await waitFor(() => expect(rowKinds(view.container)).toHaveLength(5));
    expect(lastSent()).not.toHaveProperty('kind');

    for (const [segment, kind] of [
      ['Goal checks', 'goal.attempt.validated'],
      ['Scorers', 'scorer.recorded'],
      ['Guardrails', 'run.guardrail'],
      ['Tripwires', 'run.tripwire'],
      ['Flagged sessions', 'session.tainted'],
    ] as const) {
      await fireEvent.click(view.getByRole('radio', { name: segment }));
      await waitFor(() => expect(lastSent()).toMatchObject({ kind }));
      await waitFor(() => expect(rowKinds(view.container)).toEqual([kind]));
    }
    await fireEvent.click(view.getByRole('radio', { name: 'All' }));
    await waitFor(() => expect(rowKinds(view.container)).toHaveLength(5));
    expect(lastSent()).not.toHaveProperty('kind');
  });

  test('choosing a Kind removes an applied Outcome that the kind cannot have (C2-06)', async () => {
    const view = open('/checks?outcome=pass');
    await waitFor(() => expect(rowKinds(view.container)).toEqual(['scorer.recorded']));
    expect(router.search.get('outcome')).toBe('pass');

    await fireEvent.click(view.getByRole('radio', { name: 'Guardrails' }));

    await waitFor(() => expect(router.search.get('kind')).toBe('guardrail'));
    expect(router.search.get('outcome')).toBeNull();
    await waitFor(() => expect(rowKinds(view.container)).toEqual(['run.guardrail']));
  });
});

describe('the chips', () => {
  test('Check lists the checks of the rows loaded, as words and a version, and the one chosen narrows the request and the rows', async () => {
    const view = open('/checks');
    await waitFor(() => expect(rowKinds(view.container)).toHaveLength(5));

    const radios = await openChip(view, CHECKS_COPY.facets.check);
    expect(radios.map((radio) => radio.value).toSorted()).toEqual(
      [
        'pii-input',
        'politeness@2',
        'prompt-injection',
        'spend-limit',
        'summary-lists-every-refund@3',
      ].toSorted(),
    );
    expect(
      [...document.querySelectorAll('.cinder-filter-bar__options label')].map((label) =>
        label.textContent?.trim(),
      ),
    ).toContain('Summary lists every refund, version 3');

    await fireEvent.click(radios.find((radio) => radio.value === 'politeness@2')!);

    await waitFor(() => expect(lastSent()).toMatchObject({ checkId: 'politeness@2' }));
    await waitFor(() => expect(rowKinds(view.container)).toEqual(['scorer.recorded']));
    expect(router.search.get('check')).toBe('politeness@2');
  });

  test('Outcome offers every word under All and only the kind’s under a Kind, and the one chosen narrows the request', async () => {
    const view = open('/checks');
    await waitFor(() => expect(rowKinds(view.container)).toHaveLength(5));
    const everyWord = await openChip(view, CHECKS_COPY.facets.outcome);
    expect(everyWord).toHaveLength(12);
    await fireEvent.click(everyWord.find((radio) => radio.value === 'tripwire')!);
    await waitFor(() => expect(lastSent()).toMatchObject({ outcome: 'tripwire' }));
    await waitFor(() => expect(rowKinds(view.container)).toEqual(['run.tripwire']));
  });

  test('Outcome under a Kind lists only that kind’s words', async () => {
    const view = open('/checks?kind=guardrail');
    await waitFor(() => expect(rowKinds(view.container)).toEqual(['run.guardrail']));
    const radios = await openChip(view, CHECKS_COPY.facets.outcome);
    expect(radios.map((radio) => radio.value)).toEqual(['block', 'warn', 'sanitize', 'redact']);
    expect(
      [...document.querySelectorAll('.cinder-filter-bar__options label')].map((label) =>
        label.textContent?.trim(),
      ),
    ).toEqual(['Blocked', 'Warned', 'Sanitized', 'Redacted']);
  });

  test('Agent lists the display names of the agents the rows name, and the one chosen narrows the request', async () => {
    const view = open('/checks');
    await waitFor(() => expect(rowKinds(view.container)).toHaveLength(5));
    const radios = await openChip(view, CHECKS_COPY.facets.agent);
    expect(radios.map((radio) => radio.value)).toEqual(['assistant', 'tool-runner']);

    await fireEvent.click(radios.find((radio) => radio.value === 'assistant')!);

    await waitFor(() => expect(lastSent()).toMatchObject({ agentName: 'assistant' }));
    await waitFor(() => expect(rowKinds(view.container)).toEqual(['scorer.recorded']));
    expect(router.search.get('agent')).toBe('assistant');
  });

  test('Time offers four presets, and the one chosen sends a start that far back', async () => {
    const view = open('/checks');
    await waitFor(() => expect(rowKinds(view.container)).toHaveLength(5));
    const radios = await openChip(view, CHECKS_COPY.facets.time);
    expect(radios.map((radio) => radio.value)).toEqual(['hour', 'day', 'week', 'month']);
    expect(
      [...document.querySelectorAll('.cinder-filter-bar__options label')].map((label) =>
        label.textContent?.trim(),
      ),
    ).toEqual(['Last hour', 'Last 24 hours', 'Last 7 days', 'Last 30 days']);

    const before = Date.now();
    await fireEvent.click(radios.find((radio) => radio.value === 'day')!);

    await waitFor(() => expect(typeof lastSent()['since']).toBe('number'));
    const since = lastSent()['since'] as number;
    expect(since).toBeGreaterThanOrEqual(before - 24 * 60 * 60 * 1_000);
    expect(since).toBeLessThanOrEqual(Date.now() - 24 * 60 * 60 * 1_000 + 1);
    expect(router.search.get('time')).toBe('day');
    // Every fixture row is old, so nothing is within the day: the filters match nothing.
    await view.findByRole('heading', { level: 2, name: CHECKS_COPY.noMatch.title });
  });

  test('an applied chip reads "Facet: value", its x takes it out of the address, and a reload keeps the filters (C2-05, C2-06)', async () => {
    const view = open('/checks?kind=goal&agent=tool-runner');
    await waitFor(() => expect(rowKinds(view.container)).toEqual(['goal.attempt.validated']));
    expect(lastSent()).toMatchObject({ kind: 'goal.attempt.validated', agentName: 'tool-runner' });
    const remove = view.getByRole('button', {
      name: new RegExp(`^Remove filter: ${CHECKS_COPY.facets.agent}: `),
    });

    await fireEvent.click(remove);

    await waitFor(() => expect(router.search.get('agent')).toBeNull());
    expect(router.search.get('kind')).toBe('goal');
  });
});

describe('the states', () => {
  test('first use: no filter bar, a bordered empty state with one primary New goal (C2-18)', async () => {
    const view = open('/checks', { rows: [] });

    const title = await view.findByRole('heading', { level: 2, name: CHECKS_COPY.empty.title });
    expect(title).not.toBeNull();
    expect(view.getByRole('heading', { level: 1, name: CHECKS_COPY.title })).not.toBeNull();
    expect(view.getByText(CHECKS_COPY.empty.description)).not.toBeNull();
    expect(view.queryByRole('search', { name: CHECKS_COPY.filtersLabel })).toBeNull();
    const action = view.getByRole('link', { name: CHECKS_COPY.empty.action });
    expect(action.getAttribute('href')).toBe('/goals/new');
  });

  test('filtered to nothing: the bar stays with its chips over a Clear filters state that leaves the filters (C2-19)', async () => {
    const view = open('/checks?kind=goal&outcome=error');
    await view.findByRole('heading', { level: 2, name: CHECKS_COPY.noMatch.title });
    expect(view.getByText(CHECKS_COPY.noMatch.description)).not.toBeNull();
    expect(view.getByRole('search', { name: CHECKS_COPY.filtersLabel })).not.toBeNull();
    expect(
      view.getByRole('button', {
        name: `Remove filter: ${CHECKS_COPY.facets.outcome}: Couldn't check`,
      }),
    ).not.toBeNull();

    await fireEvent.click(view.getByRole('button', { name: CHECKS_COPY.clearAction }));

    await waitFor(() => expect(router.search.toString()).toBe(''));
    await waitFor(() => expect(rowKinds(view.container)).toHaveLength(5));
  });

  test('loading: nothing under the header for 300 ms, then the bar and five placeholder rows (C2-20)', async () => {
    const view = open('/checks', { hold: true });
    await view.findByRole('heading', { level: 1, name: CHECKS_COPY.title });
    expect(view.queryByRole('search', { name: CHECKS_COPY.filtersLabel })).toBeNull();

    await waitFor(() =>
      expect(view.getByRole('search', { name: CHECKS_COPY.filtersLabel })).not.toBeNull(),
    );
    // The placeholders announce what is loading, and no result row is drawn.
    await waitFor(() =>
      expect(view.getAllByRole('status').map((status) => status.textContent?.trim())).toContain(
        CHECKS_COPY.loading,
      ),
    );
    expect(view.container.querySelectorAll('.cinder-skeleton').length).toBeGreaterThan(0);
    expect(rowKinds(view.container)).toEqual([]);
  });

  test('failing: a bordered error with the status and the operation behind its details, Try again primary, Check Health secondary (C2-21)', async () => {
    const view = open('/checks', { failPage: () => 500 });

    await view.findByRole('heading', { level: 2, name: CHECKS_COPY.loadFailed.title });
    expect(view.getByText(TASK_COPY.list.loadFailed.description(500))).not.toBeNull();
    expect(view.queryByRole('search', { name: CHECKS_COPY.filtersLabel })).toBeNull();
    expect(view.getByRole('button', { name: RETRY_LABEL })).not.toBeNull();
    const health = view.getByRole('link', { name: TASK_COPY.list.loadFailed.checkHealth });
    expect(health.getAttribute('href')).toBe('/health');
    // The operation is behind the details, never in the sentence.
    expect(view.container.textContent).toContain('bureau.checks.list');
    expect(view.getByText(TASK_COPY.list.loadFailed.description(500)).textContent).not.toContain(
      'bureau.checks.list',
    );
  });

  test('failing, then Try again reads the list again', async () => {
    let failing = true;
    const view = open('/checks', { failPage: () => (failing ? 500 : undefined) });
    await view.findByRole('heading', { level: 2, name: CHECKS_COPY.loadFailed.title });
    failing = false;

    await fireEvent.click(view.getByRole('button', { name: RETRY_LABEL }));

    await waitFor(() => expect(rowKinds(view.container)).toHaveLength(5));
  });

  test('a frame that refuses the probe says forbidden, with the scope in monospace and no list (C2-23)', async () => {
    stub = installBureauWorld(emptyBureauWorld());
    stub.on('bureau.checks.list', () => {
      throw new StubFault('Forbidden', 403, 'Forbidden');
    });
    landAt('/checks');
    const view = render(RouteOutletHarness, {
      props: {
        client: new HttpClient({ baseUrl: 'http://localhost/api' }),
        scopes: AUTHORIZATION_SCOPES,
      },
    } as never);

    await view.findByRole('heading', { level: 1, name: VIEW_COPY.checks.forbidden.title });
    expect(view.getByText('requires runs:read')).not.toBeNull();
    expect(view.queryByRole('search', { name: CHECKS_COPY.filtersLabel })).toBeNull();
    expect(rowKinds(view.container)).toEqual([]);
  });
});

describe('Load more', () => {
  const MANY = Array.from({ length: 7 }, (_, index) =>
    checkFixture(String(index), {
      checkId: `check-${String(index)}@1`,
      timestamp: `2026-10-19T${String(12 - index).padStart(2, '0')}:00:00.000Z`,
    }),
  );

  test('is a button with no count, drawn only while a cursor is left, and appends the next rows without repeating a band (C2-17)', async () => {
    const view = open('/checks', { rows: MANY, pageSize: 3 });
    await waitFor(() => expect(rowKinds(view.container)).toHaveLength(3));
    expect(view.container.textContent).not.toMatch(/Showing \d/);
    const button = view.getByRole('button', { name: CHECKS_COPY.loadMore });

    await fireEvent.click(button);
    await waitFor(() => expect(rowKinds(view.container)).toHaveLength(6));
    expect(sentList().at(-1)).toMatchObject({ cursor: '3' });
    const bands = [...view.container.querySelectorAll('.cinder-data-list-group__label')].map(
      (band) => band.textContent?.trim(),
    );
    expect(bands).toHaveLength(new Set(bands).size);

    await fireEvent.click(view.getByRole('button', { name: CHECKS_COPY.loadMore }));
    await waitFor(() => expect(rowKinds(view.container)).toHaveLength(7));
    expect(view.queryByRole('button', { name: CHECKS_COPY.loadMore })).toBeNull();
    expect(new Set(rowTitles(view.container)).size).toBe(7);
  });

  test('a failed Load more keeps every row, says so, and Try again reads the same page again (C2-22)', async () => {
    let failing = true;
    const view = open('/checks', {
      rows: MANY,
      pageSize: 3,
      failPage: (index) => (index === 1 && failing ? 500 : undefined),
    });
    await waitFor(() => expect(rowKinds(view.container)).toHaveLength(3));

    await fireEvent.click(view.getByRole('button', { name: CHECKS_COPY.loadMore }));

    await waitFor(() => expect(view.getByText('Couldn’t load more checks.')).not.toBeNull());
    expect(rowKinds(view.container)).toHaveLength(3);
    expect(view.queryByRole('button', { name: 'Retry' })).toBeNull();
    failing = false;
    await fireEvent.click(view.getByRole('button', { name: RETRY_LABEL }));
    await waitFor(() => expect(rowKinds(view.container)).toHaveLength(6));
  });
});
