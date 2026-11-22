/**
 * The runs that need a look (COR-2528), captured for the design review on a desktop and a phone and
 * walked end to end: a run that is stalled, one that is looping and one that is over the spend
 * threshold are in Health's Needs attention (each row opens its run), carry a badge on the Runs
 * list, are found through the list's Needs attention chip (the page asks the Bureau for them, one
 * state at a time, so a settled run that overspent is there), and are said on their own page.
 *
 * The sample Bureau has no run in any of these states, so the real answers are rewritten before the
 * page reads them: three of the sample world's runs are given a state, and the attention list gets
 * the items the Bureau lists for them. The stalled run is the order 4468 lookup, made to be still
 * going with its stream held open, as `run-page-live-states.spec.ts` does.
 *
 * Every title names the route it captures, so a design review's route filter (`--grep '/runs'`)
 * runs it.
 */
import type { Page, Route } from '@playwright/test';

import { SAMPLE_NOW, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import {
  readSampleWorldRecords,
  type SampleWorldRecords,
} from '../../fixtures/sample-world-records.ts';
import { RUN_ATTENTION_COPY } from '../../src/app/copy/run-attention.ts';
import type { TaskAttention } from '../../src/lib/bureau-tasks.ts';
import { HEALTH_ATTENTION_COPY } from '../../src/routes/health/health-copy.ts';
import { isBureauCall } from './bureau-answer-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';
import { readBoxes } from './read-boxes.ts';

const SOURCE = 'run-attention-states.spec.ts';
const WIDTHS = [1280, 375] as const;

type Json = Record<string, unknown>;

/** When the Bureau saw the stalled run stall: a minute before the sample clock, 10:49 AM Central. */
const STALLED_SINCE = '2026-11-02T10:49:00-06:00';

/** What a run that cost $12.35 used, which the Bureau reports on the task. */
const EXPENSIVE_USAGE: Json = {
  promptTokens: 80_000,
  completionTokens: 20_000,
  totalTokens: 100_000,
  costUsd: 12.3456,
};

/** A run that settled over the spend threshold, which no sample run is: the list is given it as a task. */
const SETTLED_RUN_ID = 'run-attention-settled';
const SETTLED_RUN: Json = {
  id: SETTLED_RUN_ID,
  contextId: SETTLED_RUN_ID,
  agentName: 'tool-runner',
  owner: 'anonymous:local',
  actor: null,
  kind: 'chat',
  origin: { kind: 'api' },
  status: 'completed',
  finishReason: 'stop',
  statusMessage: null,
  createdAt: '2026-11-02T10:46:00-06:00',
  updatedAt: '2026-11-02T10:47:30-06:00',
  cleanup: null,
  openWaits: [],
  usage: EXPENSIVE_USAGE,
  attention: ['overspending'],
  stalledSince: null,
};

/** A run that is in all three states at once, so a row draws three badges: the list is given it too. */
const THREE_STATES_RUN_ID = 'run-attention-all';
const THREE_STATES_RUN: Json = {
  ...SETTLED_RUN,
  id: THREE_STATES_RUN_ID,
  contextId: THREE_STATES_RUN_ID,
  status: 'working',
  createdAt: '2026-11-02T10:49:00-06:00',
  updatedAt: '2026-11-02T10:49:40-06:00',
  attention: ['stalled', 'looping', 'overspending'],
  stalledSince: STALLED_SINCE,
};

/**
 * The state two of the sample world's runs are made to be in, and the fields the Bureau reports
 * with it. Both are made the newest runs, so the Runs list's first page of ten holds them.
 */
function statesOf(world: SampleWorldRecords, stalledRun: Json): ReadonlyMap<string, Json> {
  return new Map<string, Json>([
    [
      world.runs.done,
      {
        status: 'working',
        attention: ['stalled'],
        stalledSince: STALLED_SINCE,
        createdAt: '2026-11-02T10:48:00-06:00',
        updatedAt: '2026-11-02T10:49:30-06:00',
        ...stalledRun,
      },
    ],
    [
      world.runs.waiting,
      {
        attention: ['looping'],
        stalledSince: null,
        createdAt: '2026-11-02T10:47:00-06:00',
        updatedAt: '2026-11-02T10:49:00-06:00',
      },
    ],
  ]);
}

/** The items the Bureau lists in Needs attention for those runs. */
function attentionItems(world: SampleWorldRecords): readonly Json[] {
  return [
    {
      kind: 'run-stalled',
      area: 'runs',
      at: Date.parse(STALLED_SINCE),
      runId: world.runs.done,
      agentName: 'tool-runner',
    },
    {
      kind: 'run-looping',
      area: 'runs',
      at: Date.parse('2026-11-02T10:48:30-06:00'),
      runId: world.runs.waiting,
      agentName: null,
    },
    {
      kind: 'run-overspending',
      area: 'runs',
      at: Date.parse('2026-11-02T10:46:30-06:00'),
      runId: SETTLED_RUN_ID,
      agentName: 'tool-runner',
      costUsd: 12.3456,
      thresholdUsd: 10,
      settledAt: Date.parse('2026-11-02T10:47:30-06:00'),
    },
  ];
}

/** Answers `route` with what `rewrite` makes of the host's answer to the same call. */
async function rewriteResult(
  route: Route,
  rewrite: (result: Json) => Json,
  request: { readonly postData?: string } = {},
): Promise<void> {
  const response = await route.fetch(request);
  const answer = (await response.json()) as { result?: Json };
  await route.fulfill({ response, json: { ...answer, result: rewrite(answer.result ?? {}) } });
}

/** Gives the runs their states in every answer the pages read, and lists them in Needs attention. */
async function installRunsNeedingAttention(
  page: Page,
  world: SampleWorldRecords,
  /** What the Run page's task says instead, for the run that is still going. */
  stalledRun: Json = {},
): Promise<void> {
  const states = statesOf(world, stalledRun);
  const given = (task: Json): Json => {
    const state = states.get(String(task['id']));
    return state === undefined ? task : { ...task, ...state };
  };
  // The run that is still going has no stream of its own: the host's stream of the finished run
  // would hand the page its terminal status.
  await page.route('**/bureau/v1/subscriptions/bureau.tasks.events**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('taskId') === world.runs.done) return;
    await route.fallback();
  });
  await page.route(isBureauCall, async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      method?: string;
      params?: Json;
    };
    switch (body.method) {
      case 'bureau.tasks.get': {
        await rewriteResult(route, (task) => given(task));
        return;
      }
      case 'bureau.tasks.list': {
        const wanted = body.params?.['attention'];
        // The sample Bureau has no run in a state, so a request that names one is answered from the
        // whole listing, and the states above are what the Bureau would have filtered by.
        const everyRun =
          wanted === undefined
            ? {}
            : {
                postData: JSON.stringify({
                  ...body,
                  params: { ...body.params, attention: undefined },
                }),
              };
        await rewriteResult(
          route,
          (result) => {
            // The settled run is listed once: on the first page of the page's own read of every run.
            const params = body.params ?? {};
            const wholeList =
              params['limit'] === 100 &&
              params['pageToken'] === undefined &&
              Object.keys(params).every((key) => ['limit', 'pageToken', 'attention'].includes(key));
            const tasks = [
              ...(wholeList ? [THREE_STATES_RUN, SETTLED_RUN] : []),
              ...((result['tasks'] as Json[] | undefined) ?? []).map(given),
            ];
            return wanted === undefined
              ? { ...result, tasks }
              : {
                  ...result,
                  tasks: tasks.filter((task) =>
                    ((task['attention'] as unknown[] | undefined) ?? []).includes(wanted),
                  ),
                  nextPageToken: null,
                };
          },
          everyRun,
        );
        return;
      }
      case 'bureau.health.attention': {
        await rewriteResult(route, (result) => {
          const items = [
            ...((result['items'] as Json[] | undefined) ?? []),
            ...attentionItems(world),
          ];
          const checks = ((result['checks'] as Json[] | undefined) ?? []).filter(
            (check) => check['area'] !== 'runs',
          );
          return {
            ...result,
            items,
            count: items.length,
            checks: [...checks, { area: 'runs', count: attentionItems(world).length }],
          };
        });
        return;
      }
      default:
        await route.fallback();
    }
  });
}

/** Opens `path` at the sample clock and `width`. */
async function openAt(page: Page, path: string, width: number): Promise<void> {
  await page.clock.setFixedTime(SAMPLE_NOW);
  await page.setViewportSize({ width, height: 900 });
  await page.goto(path);
}

/** The path of a run's page. */
const runPath = (runId: string): string => `/runs/${encodeURIComponent(runId)}`;

test.describe('/health: Needs attention names the runs that need a look (COR-2528)', () => {
  test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

  for (const width of WIDTHS) {
    test(`a stalled, a looping and an overspending run each have a row that opens the run, at ${String(width)} pixels`, async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await installRunsNeedingAttention(page, world);
      await openAt(page, '/health', width);

      const row = (kind: string, runId: string) =>
        page.locator(`[data-attention="${kind}:${runId}"]`);
      const stalled = row('run-stalled', world.runs.done);
      await expect(stalled).toBeVisible();
      await expect(stalled).toContainText(HEALTH_ATTENTION_COPY.run.stalledTitle('Tool runner'));
      await expect(stalled).toContainText('It last made progress before then');
      await expect(row('run-looping', world.runs.waiting)).toContainText(
        HEALTH_ATTENTION_COPY.run.loopingTitle(HEALTH_ATTENTION_COPY.run.unnamed),
      );
      const overspending = row('run-overspending', SETTLED_RUN_ID);
      await expect(overspending).toContainText('has cost $12.35, over the spend threshold');
      // A row says what the run cost, never the threshold it crossed.
      await expect(overspending).not.toContainText('$10');
      for (const [kind, runId] of [
        ['run-stalled', world.runs.done],
        ['run-looping', world.runs.waiting],
        ['run-overspending', SETTLED_RUN_ID],
      ] as const) {
        await expect(
          row(kind, runId).getByRole('link', { name: HEALTH_ATTENTION_COPY.run.action }),
        ).toHaveAttribute('href', runPath(runId));
      }
      await captureForDesignReview(page, {
        route: '/health',
        state: 'needs attention with run rows',
        source: SOURCE,
      });

      // The stalled run is found through Needs attention, and its page says so.
      await stalled.getByRole('link', { name: HEALTH_ATTENTION_COPY.run.action }).click();
      await expect(page).toHaveURL(new RegExp(`${runPath(world.runs.done)}$`));
      await expect(
        page.locator('[data-testid="run-attention-note"][data-attention="stalled"]'),
      ).toBeVisible();
    });
  }
});

test.describe('/runs: badges and the Needs attention chip (COR-2528)', () => {
  test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

  for (const width of WIDTHS) {
    test(`a badge for each state on a row, at ${String(width)} pixels`, async ({ page }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await installRunsNeedingAttention(page, world);
      await openAt(page, '/runs', width);

      const rowOf = (runId: string) => page.locator(`main li[data-run="${runId}"]`);
      await expect(rowOf(world.runs.done)).toBeVisible();
      await expect(rowOf(world.runs.done).locator('[data-attention="stalled"]')).toHaveText(
        RUN_ATTENTION_COPY.badges.stalled,
      );
      await expect(rowOf(world.runs.waiting).locator('[data-attention="looping"]')).toHaveText(
        RUN_ATTENTION_COPY.badges.looping,
      );
      await expect(rowOf(SETTLED_RUN_ID).locator('[data-attention="overspending"]')).toHaveText(
        RUN_ATTENTION_COPY.badges.overspending,
      );
      // One badge each on those three rows, and the three-state run's three.
      await expect(page.locator('main li[data-run] [data-attention]')).toHaveCount(6);
      await captureForDesignReview(page, {
        route: '/runs',
        state: 'attention badges',
        source: SOURCE,
      });
    });

    test(`a row in three states draws three badges and keeps its title, at ${String(width)} pixels`, async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await installRunsNeedingAttention(page, world);
      await openAt(page, '/runs', width);

      const row = page.locator(`main li[data-run="${THREE_STATES_RUN_ID}"]`);
      await expect(row).toBeVisible();
      const badges = row.locator('[data-attention]');
      await expect(badges).toHaveText([
        RUN_ATTENTION_COPY.badges.stalled,
        RUN_ATTENTION_COPY.badges.looping,
        RUN_ATTENTION_COPY.badges.overspending,
      ]);
      // The title is never crushed beside them: it is drawn whole (its row's width, or its own),
      // and the badges that do not fit beside it drop to a line under it, never past the row.
      const boxes = await readBoxes(page, {
        frame: row,
        title: row.locator('.cinder-stacked-list-item__title'),
        stalled: badges.nth(0),
        looping: badges.nth(1),
        overspending: badges.nth(2),
      });
      // The title's text is whole, cut by nothing: the box is as wide as the word needs, which for
      // a title as short as "Run" is only a few pixels, so what is asserted is the cut, not a width.
      const cut = await row
        .locator('.cinder-stacked-list-item__title')
        .evaluate((title) => title.scrollWidth > title.clientWidth);
      expect(cut).toBe(false);
      for (const badge of [boxes.stalled, boxes.looping, boxes.overspending]) {
        expect(badge.x + badge.width).toBeLessThanOrEqual(boxes.frame.x + boxes.frame.width + 1);
        // No badge overlaps the title: it is beside it or under it.
        const beside = badge.x >= boxes.title.x + boxes.title.width - 1;
        const under = badge.y >= boxes.title.y + boxes.title.height - 1;
        expect(beside || under).toBe(true);
      }
      await captureForDesignReview(page, {
        route: '/runs',
        state: 'three badges on one row',
        source: SOURCE,
      });
    });

    test(`the Needs attention filter asks the Bureau and finds the stalled run, at ${String(width)} pixels`, async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await installRunsNeedingAttention(page, world);
      // What the page asks the Bureau for: the filter is a request, not the page's own narrowing.
      const asked = new Set<string>();
      page.on('request', (request) => {
        if (!isBureauCall(new URL(request.url()))) return;
        const body = JSON.parse(request.postData() ?? '{}') as { method?: string; params?: Json };
        if (body.method === 'bureau.tasks.list' && typeof body.params?.['attention'] === 'string') {
          asked.add(body.params['attention']);
        }
      });
      // The chip's own control is folded into the Filter menu on a phone, so the address, which is
      // the filter's own state, opens it there.
      await openAt(page, width > 640 ? '/runs' : '/runs?attention=1', width);
      const rowOf = (runId: string) => page.locator(`main li[data-run="${runId}"]`);
      if (width > 640) {
        await expect(rowOf(world.runs.done)).toBeVisible();
        await page.getByRole('button', { name: new RegExp(RUN_ATTENTION_COPY.filter) }).click();
        await expect(page).toHaveURL(/[?&]attention=1(&|$)/);
        // The pressed chip carries one mark, its dot (the check is left out of a filter toggle).
        const chip = page.getByRole('button', { name: new RegExp(RUN_ATTENTION_COPY.filter) });
        await expect(chip).toHaveAttribute('aria-pressed', 'true');
        await expect(chip.locator('.cinder-filter-bar__dot')).toHaveCount(1);
        await expect(chip.locator('.cinder-chip__check')).toBeHidden();
      }

      await expect(rowOf(world.runs.done)).toBeVisible();
      await expect(rowOf(world.runs.done).locator('[data-attention="stalled"]')).toBeVisible();
      // A settled run that overspent is on the list, and a run with no state is not.
      await expect(rowOf(SETTLED_RUN_ID)).toBeVisible();
      await expect(rowOf(world.runs.failed)).toHaveCount(0);
      await expect(page.locator('main li[data-run]')).toHaveCount(4);
      expect([...asked].toSorted()).toEqual(['looping', 'overspending', 'stalled']);
      await captureForDesignReview(page, {
        route: '/runs',
        state: 'needs attention filter',
        source: SOURCE,
      });
    });
  }
});

const RUN_PAGE_STATES: readonly {
  readonly state: string;
  readonly states: readonly TaskAttention[];
  /** Whether the Bureau reports the instant the run was seen to stall. */
  readonly stalls: boolean;
}[] = [
  { state: 'stalled run', states: ['stalled'], stalls: true },
  { state: 'looping and overspending run', states: ['looping', 'overspending'], stalls: false },
];

test.describe('/runs/:run: the note says what is wrong (COR-2528)', () => {
  test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

  for (const width of WIDTHS) {
    for (const run of RUN_PAGE_STATES) {
      test(`${run.state} at ${String(width)} pixels`, async ({ page }) => {
        const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
        // The run that is still going is the sample's order 4468 lookup, given this page's states.
        await installRunsNeedingAttention(page, world, {
          attention: run.states,
          stalledSince: run.stalls ? STALLED_SINCE : null,
          usage: {
            promptTokens: 80_000,
            completionTokens: 20_000,
            totalTokens: 100_000,
            costUsd: 12.3456,
          },
        });
        await openAt(page, runPath(world.runs.done), width);
        await expect(page.locator('[data-run-header] [data-status-word]')).toBeVisible();

        const notes = page.locator('[data-testid="run-attention-note"]');
        await expect(notes).toHaveCount(run.states.length);
        for (const state of run.states) {
          await expect(
            page.locator(`[data-testid="run-attention-note"][data-attention="${state}"]`),
          ).toContainText(RUN_ATTENTION_COPY.note[state].title);
        }
        if (run.stalls) {
          // When it was seen to stall, 10:49 AM, and that it last made progress before then.
          await expect(notes.first()).toContainText('It was seen stalled at 10:49 AM');
          await expect(notes.first()).toContainText('last made progress before then');
        } else {
          await expect(notes.last()).toContainText('It has cost $12.35');
        }
        await captureForDesignReview(page, {
          route: '/runs/:run',
          state: run.state,
          source: SOURCE,
        });
      });
    }
  }
});
