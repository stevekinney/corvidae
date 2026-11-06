/**
 * Component tests for the Health Overview (`routes/health/index.svelte`, rows 76b to 77f): the
 * frame (the heading, the storage line, the tab bar with no Diagnostics tab), the Needs attention
 * list from `bureau.health.attention`, Recent activity from the audit trail, the three metric
 * cards, and the Advanced disclosure. The Bureau is a stub that answers as the real one does; the
 * real one is exercised by the Playwright suite (`tests/e2e/health-overview.spec.ts`). The engine
 * answers nothing here, so its counts read as unavailable, which is also a state worth proving.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, jest, test } from 'bun:test';
import { flushSync } from 'svelte';

import RouteOutletHarness from '../../app/shell/route-outlet.test-harness.svelte';
import {
  installBureauStub,
  StubFault,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import {
  emptyWorld,
  installWorkflowWorld,
  runFixture,
  type WorkflowStub,
} from '../../lib/workflow-world.test-support.ts';
import { landAt } from '../chat/pages.test-support.ts';

let stub: BureauStub | undefined;
let engine: WorkflowStub | undefined;
afterEach(() => {
  jest.useRealTimers();
  cleanup();
  stub?.restore();
  stub = undefined;
  engine?.restore();
  engine = undefined;
});

const AT = Date.now() - 60 * 60_000;

const ATTENTION = {
  items: [
    { kind: 'no-provider', area: 'providers', at: AT, provider: 'anthropic' },
    {
      kind: 'alert',
      area: 'storage',
      at: AT - 3_600_000,
      metric: 'storage.size',
      currentValue: 1_717_986_918,
      threshold: 1_073_741_824,
    },
    {
      kind: 'missed-runs',
      area: 'schedules',
      at: AT - 7_200_000,
      scheduleId: 'schedule-daily',
      scheduleName: 'Daily summary',
      count: 4,
      since: Date.UTC(2026, 9, 30, 9),
      occurrences: [
        { occurrence: Date.UTC(2026, 9, 30, 9), count: 1 },
        { occurrence: Date.UTC(2026, 9, 31, 9), count: 1 },
      ],
    },
  ],
  count: 3,
  checks: [
    { area: 'storage', count: 1 },
    { area: 'schedules', count: 1 },
    { area: 'providers', count: 1 },
  ],
};

const ALL_CLEAR = { items: [], count: 0, checks: [] };

const AUDIT = {
  records: [
    {
      sequence: 1,
      timestamp: new Date(AT).toISOString(),
      type: 'provider.disconnected',
      resource: 'provider:anthropic',
      principal: 'anonymous:local',
      detail: { provider: 'anthropic' },
    },
    {
      sequence: 0,
      timestamp: new Date(AT - 3 * 3_600_000).toISOString(),
      type: 'host.started',
      resource: 'host',
      principal: 'system:host',
      detail: null,
    },
  ],
  nextCursor: null,
  total: 1240,
};

function open(
  path = '/health',
  handlers: Record<string, (params: Record<string, unknown>) => unknown> = {},
  passThrough = false,
) {
  stub = installBureauStub(
    {
      'bureau.health.attention': () => ATTENTION,
      'bureau.audit.query': () => AUDIT,
      'bureau.reviews.list': () => ({ reviews: [], nextPageToken: null }),
      'bureau.schedules.list': () => ({ schedules: [], nextOffset: null }),
      'bureau.contexts.get': () => {
        throw new StubFault('NotFound', 404, 'No such chat.');
      },
      ...handlers,
    },
    { passThrough },
  );
  landAt(path);
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
}

describe('the frame', () => {
  test('is headed Health, names where the installation runs, and has four tabs and no Diagnostics', async () => {
    const view = open();
    const heading = await view.findByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('Health');
    // The stub's host keeps its state in ~/.interborough, which the line writes the way a person does.
    expect(await view.findByText('Running on SQLite in ~/.interborough')).not.toBeNull();
    expect(view.getByRole('button', { name: /Storage details/ })).not.toBeNull();

    const tabs = view.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
      'Overview',
      'Workers',
      'Storage',
      'Audit log',
    ]);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    for (const word of ['Diagnostics', 'Metrics', 'Alerts', 'Checks']) {
      expect(view.queryByRole('tab', { name: word })).toBeNull();
    }
  });

  test('has one Live indicator and no "Updated every" text', async () => {
    const view = open();
    await view.findByRole('heading', { level: 1 });
    await waitFor(() =>
      expect(view.getAllByRole('status', { name: /Connection/ })).toHaveLength(1),
    );
    expect(view.container.textContent).not.toContain('Updated every');
  });

  test('a tab opens its own page, and the heading stays Health', async () => {
    const view = open();
    await view.findByRole('heading', { level: 1 });
    await fireEvent.click(view.getByRole('tab', { name: 'Audit log' }));
    await waitFor(() => expect(window.location.pathname).toBe('/health/audit'));
  });
});

describe('loading (rows 76w and 76x)', () => {
  /** The page with the list of what needs attention that never answers. */
  async function openHanging() {
    // The route's page is loaded on demand; load it first so that mounting it needs no real time.
    await import('./index.svelte');
    jest.useFakeTimers();
    const view = open('/health', { 'bureau.health.attention': () => new Promise(() => {}) });
    // Let the route's lazy import resolve and the page mount, without moving the clock.
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    flushSync();
    return view;
  }

  function advance(milliseconds: number): void {
    jest.advanceTimersByTime(milliseconds);
    flushSync();
  }

  test('draws the frame at once and nothing of the body for 300 ms, and no Live indicator', async () => {
    const view = await openHanging();
    advance(299);
    expect(view.getByRole('heading', { level: 1, name: 'Health' })).not.toBeNull();
    expect(view.getAllByRole('tab')).toHaveLength(4);
    expect(view.queryByTestId('needs-attention')).toBeNull();
    expect(view.queryByRole('group', { name: 'Health counts' })).toBeNull();
    expect(view.container.querySelector('.cinder-skeleton')).toBeNull();
    expect(view.queryByRole('status', { name: /Connection/ })).toBeNull();
  });

  test('then keeps the real layout: real labels and headings, placeholders for values, rows and charts', async () => {
    const view = await openHanging();
    advance(300);
    const counts = view.getByRole('group', { name: 'Health counts' });
    expect(
      [...counts.querySelectorAll('.cinder-statistic__label')].map((label) =>
        label.textContent?.trim(),
      ),
    ).toEqual(['Running now', 'Needs you', 'Failed in 24 hours', 'Missed schedule runs (7 days)']);
    // A placeholder block stands where each count will be, never a zero.
    expect(counts.querySelectorAll('.cinder-skeleton')).toHaveLength(4);
    expect(counts.textContent).not.toMatch(/\b0\b/);

    const card = view.getByTestId('needs-attention');
    expect(card.querySelector('h2')?.textContent).toBe('Needs attention');
    expect(card.querySelector('.cinder-badge')).toBeNull();
    expect(card.querySelectorAll('.cinder-skeleton-row')).toHaveLength(3);

    const cards = view.getByTestId('metric-cards');
    expect([...cards.querySelectorAll('h2')].map((heading) => heading.textContent)).toEqual([
      'Storage use',
      'Runs started',
      'Time to finish',
    ]);
    expect(cards.querySelectorAll('.cinder-skeleton')).toHaveLength(6);
    // The rest of the page waits for its data, and the Live indicator is not drawn.
    expect(view.queryByRole('heading', { level: 2, name: /Recent activity/ })).toBeNull();
    expect(view.queryByTestId('advanced-diagnostics')).toBeNull();
    expect(view.queryByRole('status', { name: /Connection/ })).toBeNull();
  });

  test('a read that is quick never flashes a placeholder', async () => {
    jest.useFakeTimers();
    const view = open();
    // Answered before 300 ms: the first thing drawn is the real list.
    await waitFor(() =>
      expect(view.getByTestId('needs-attention').querySelectorAll('li').length).toBe(3),
    );
    expect(view.container.querySelector('.cinder-skeleton-row')).toBeNull();
  });
});

describe('Needs attention', () => {
  test('lists the three problems in the Bureau’s order, each with its action, under a neutral count', async () => {
    const view = open();
    const card = await view.findByTestId('needs-attention');
    await waitFor(() => expect(card.querySelectorAll('li').length).toBe(3));

    const rows = [...card.querySelectorAll('li')];
    expect(rows[0]?.textContent).toContain('No model provider connected');
    expect(rows[0]?.textContent).toContain('The Anthropic key was removed at');
    expect(rows[1]?.textContent).toContain('Storage is over its warning level · 1.6 GB');
    expect(rows[2]?.textContent).toContain('Daily summary missed 4 runs since Oct 30');
    expect(card.textContent).toContain('Connect a provider');
    expect(card.textContent).toContain('View storage');
    expect(card.textContent).toContain('Change retention');
    expect(card.textContent).toContain('View schedule');
    expect(card.querySelector('.cinder-badge')?.textContent?.trim()).toBe('3');
    // The list is the status, so no banner sits above it.
    expect(view.queryByRole('region', { name: /unreachable|reach the/i })).toBeNull();
  });

  test('an action goes where it says', async () => {
    const view = open();
    const button = await view.findByRole('link', { name: 'View storage' });
    expect(button.getAttribute('href')).toBe('/health/storage');
    await fireEvent.click(button);
    await waitFor(() => expect(window.location.pathname).toBe('/health/storage'));
  });

  test('with nothing to report collapses to one row with no count and no actions', async () => {
    const view = open('/health', { 'bureau.health.attention': () => ALL_CLEAR });
    const card = await view.findByTestId('needs-attention');
    await waitFor(() => expect(card.textContent).toContain('Nothing needs attention'));
    expect(card.textContent).toContain('Storage, schedules, providers and hooks are fine.');
    expect(card.querySelector('.cinder-badge')).toBeNull();
    expect(card.querySelectorAll('a, button')).toHaveLength(0);
  });

  test('a list that could not be read says so and never claims all is well', async () => {
    const view = open('/health', {
      'bureau.health.attention': () => {
        throw new StubFault('Internal', 500, 'The Bureau failed.');
      },
    });
    const card = await view.findByTestId('needs-attention');
    await waitFor(() => expect(card.textContent).toContain('Couldn’t read what needs attention'));
    expect(card.textContent).not.toContain('Nothing needs attention');
    expect(view.getByRole('button', { name: 'Try again' })).not.toBeNull();
  });
});

describe('the counts', () => {
  test('are the four of Home, in order, and a missed count carries a dot and its schedule', async () => {
    const view = open();
    const row = await view.findByRole('group', { name: 'Health counts' });
    await waitFor(() => expect(row.textContent).toContain('Daily summary'));
    const labels = [...row.querySelectorAll('.cinder-statistic__label')].map((label) =>
      label.textContent?.trim(),
    );
    expect(labels).toEqual([
      'Running now',
      'Needs you',
      'Failed in 24 hours',
      'Missed schedule runs (7 days)',
    ]);
    const missed = row.querySelector('[data-count="missed"]');
    expect(missed?.querySelector('.cinder-statistic__value')?.textContent?.trim()).toBe('4');
    expect(missed?.hasAttribute('data-cinder-attention')).toBe(true);
    // The engine answered nothing, so its counts are unavailable and never zero.
    await waitFor(() =>
      expect(
        row.querySelector('[data-count="running"] .cinder-statistic__value')?.textContent?.trim(),
      ).toBe('—'),
    );
  });
});

describe('Recent activity', () => {
  test('is headed with its zone, links to the audit log with its size, and lists lines with their times', async () => {
    const view = open();
    const heading = await view.findByRole('heading', { level: 2, name: /Recent activity/ });
    expect(heading.textContent).toContain('Central time');
    const link = await view.findByRole('link', { name: /Open audit log/ });
    await waitFor(() => expect(link.textContent).toContain('Open audit log (1,240 events) ›'));
    expect(link.getAttribute('href')).toBe('/health/audit');

    const lines = [...view.container.querySelectorAll('[data-activity]')];
    await waitFor(() =>
      expect(
        [...view.container.querySelectorAll('[data-activity]')].map(
          (line) => line.querySelector('.ib-recent-activity__text')?.textContent,
        ),
      ).toEqual([
        'You removed the Anthropic key',
        'Storage alert firing · over its warning level',
        'Server started',
      ]),
    );
    expect(lines.length).toBeGreaterThanOrEqual(0);
  });

  test('asks for the newest records and the total, once', async () => {
    const view = open();
    await view.findByRole('link', { name: /Open audit log/ });
    await waitFor(() => expect(stub?.callsTo('bureau.audit.query').length).toBeGreaterThan(0));
    expect(stub?.callsTo('bureau.audit.query')[0]?.params).toMatchObject({
      order: 'newest',
      includeTotal: true,
    });
  });
});

describe('the metric cards', () => {
  test('headed Storage use, Runs started and Time to finish, the first drawing no chart until it has two sizes', async () => {
    const view = open();
    const cards = await view.findByTestId('metric-cards');
    expect([...cards.querySelectorAll('h2')].map((heading) => heading.textContent)).toEqual([
      'Storage use',
      'Runs started',
      'Time to finish',
    ]);
    // The firing alert carries the size, since the feed reported none.
    await waitFor(() => expect(cards.textContent).toContain('1.6 GB'));
    expect(cards.textContent).toContain('Charts fill in as Interborough runs.');
    expect(cards.querySelector('.cinder-sparkbar')).toBeNull();
  });
});

describe('more runs than one page holds', () => {
  /** An engine that lists 450 runs of the last day, 250 of them running, at most 200 to a page. */
  function manyRuns(): WorkflowStub {
    const world = emptyWorld({
      runs: Array.from({ length: 450 }, (_, index) =>
        runFixture(`run-${String(index)}`, 'agentRun', {
          status: index < 250 ? 'running' : 'completed',
          createdAt: Date.now() - 60_000 - index,
          updatedAt: Date.now() - 60_000 - index + 8_000,
        }),
      ),
    });
    engine = installWorkflowWorld(world);
    return engine;
  }

  test('counts Running now and Runs started over every page, and the day before from the total', async () => {
    const runs = manyRuns();
    runs.on('weft.workflows.aggregate', () => ({ groups: [], total: 0 }));
    const view = open('/health', {}, true);
    const counts = await view.findByRole('group', { name: 'Health counts' });
    await waitFor(() =>
      expect(counts.querySelector('.cinder-statistic__value')?.textContent).toContain('250'),
    );
    const started = view.container.querySelector('[data-metric="runs-started"]');
    await waitFor(() =>
      expect(started?.querySelector('.ib-metric-card__value')?.textContent).toBe('450'),
    );
    // Every run was read, in pages of 200 that follow one another, and the day before only counted.
    const pagesOf = (matches: (params: Record<string, unknown>) => boolean) =>
      runs
        .callsTo('weft.workflows.list')
        .map((call) => call.params)
        .filter(matches)
        .map((params) => [params['limit'], params['offset']]);
    expect(pagesOf((params) => params['status'] === 'running')).toEqual([
      [200, 0],
      [200, 200],
    ]);
    expect(pagesOf((params) => params['status'] === undefined && params['limit'] === 200)).toEqual([
      [200, 0],
      [200, 200],
      [200, 400],
    ]);
    expect(pagesOf((params) => params['limit'] === 1)).toEqual([[1, undefined]]);
  });
});

describe('Advanced', () => {
  test('is collapsed at the foot, and holds Metrics, Alerts and Checks only behind it', async () => {
    const view = open();
    const advanced = await view.findByTestId('advanced-diagnostics');
    expect(advanced.textContent).toContain('Advanced');
    expect(advanced.textContent).toContain('Metrics, alerts and checks');
    const trigger = advanced.querySelector('button[aria-expanded]');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(view.queryByText('Open metrics ›')).toBeNull();
    // It is the last thing on the page.
    expect(
      view.container
        .querySelector('.ib-health-overview')
        ?.lastElementChild?.getAttribute('data-testid'),
    ).toBe('advanced-diagnostics');
  });

  test('is opened by an Open Diagnostics link, with three rows and a link on each', async () => {
    const view = open('/health?advanced=open');
    await view.findByText('Open metrics ›');
    expect(view.getByText('Open alerts ›')).not.toBeNull();
    expect(view.getByText('Open checks ›')).not.toBeNull();
    const advanced = view.getByTestId('advanced-diagnostics');
    expect(advanced.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe(
      'true',
    );
    // Checks counts the same problems as Needs attention.
    await waitFor(() =>
      expect(advanced.textContent).toContain('3 need attention · Storage, Schedules, Providers'),
    );
    await waitFor(() =>
      expect(advanced.textContent).toMatch(
        /storage\.size · firing since \d{1,2}:\d{2} (AM|PM) · 1 rule/,
      ),
    );
    expect(advanced.textContent).toContain(
      'Storage use, runs started, time to finish; each opens its chart.',
    );
  });
});
