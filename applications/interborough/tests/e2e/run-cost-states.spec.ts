/**
 * What a run cost, in every place it is said (COR-2525), captured for the design review on a desktop
 * and a phone: a reply's details, the Run page's rail, the Runs list's Cost column, the Goals list
 * and Health's Needs attention. The Bureau answers the page as it would in a world whose runs were
 * priced; the real answer is rewritten before the page reads it (`rewriteBureauAnswer`), with
 * amounts large enough to read as dollars, and one amount under a cent for `< $0.01`. The sample
 * world's own runs, goals and chats are the rows that are rewritten or added to.
 *
 * Every title names the route it captures, so a design review's route filter (`--grep '/runs'`)
 * runs it.
 */
import type { Page } from '@playwright/test';

import { SAMPLE_NOW, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { readSampleWorldRecords } from '../../fixtures/sample-world-records.ts';
import { CHAT_COPY } from '../../src/app/copy/chat.ts';
import { COST_COPY } from '../../src/app/copy/cost.ts';
import { RUN_PAGE_COPY } from '../../src/app/copy/runs.ts';
import { isBureauCall, rewriteBureauAnswer } from './bureau-answer-support.ts';
import { untilChatLoaded } from './chat-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

const SOURCE = 'run-cost-states.spec.ts';
const WIDTHS = [1280, 375] as const;

type Json = Record<string, unknown>;

/** What the Bureau reports of a run it priced: `costUsd` in US dollars. */
function usage(totalTokens: number, costUsd: number | null): Json {
  return {
    promptTokens: Math.floor(totalTokens * 0.8),
    completionTokens: Math.ceil(totalTokens * 0.2),
    totalTokens,
    costUsd,
  };
}

/** Opens `path` at the sample clock and `width`. */
async function openAt(page: Page, path: string, width: number): Promise<void> {
  await page.clock.setFixedTime(SAMPLE_NOW);
  await page.setViewportSize({ width, height: 900 });
  await page.goto(path);
}

/** Gives the sample world's finished chat run the `usage` as `bureau.tasks.get` answers it. */
async function reportRunUsage(page: Page, runId: string, reported: Json | null): Promise<void> {
  await rewriteBureauAnswer(page, 'bureau.tasks.get', (result) =>
    result['id'] === runId ? { ...result, usage: reported } : result,
  );
}

/**
 * The Run page's rail, by the name its landmark carries. The shell's navigation is a complementary
 * landmark too, so the role alone names two.
 */
const runRail = (page: Page) =>
  page.getByRole('complementary', { name: RUN_PAGE_COPY.detailsHeading });

/** One fact of the Run page's rail, by its term, or the empty locator when the rail has none. */
const railFact = (page: Page, term: string) =>
  runRail(page)
    .locator('dt', { hasText: new RegExp(`^${term}$`) })
    .locator('xpath=following-sibling::dd[1]');

const RUN_STATES = [
  {
    state: 'priced run',
    usage: usage(48_200, 12.3456),
    tokens: '48,200',
    cost: '$12.35',
  },
  {
    state: 'run under one cent',
    usage: usage(310, 0.0042),
    tokens: '310',
    cost: COST_COPY.underOneCent,
  },
  { state: 'run with tokens and no cost', usage: usage(48_200, null), tokens: '48,200' },
  { state: 'run with no usage', usage: null },
] as const;

test.describe('/runs/:run: tokens and cost in the rail (COR-2525)', () => {
  test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

  for (const width of WIDTHS) {
    for (const run of RUN_STATES) {
      test(`${run.state} at ${String(width)} pixels`, async ({ page }) => {
        const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
        await reportRunUsage(page, world.runs.done, run.usage);
        await openAt(page, `/runs/${encodeURIComponent(world.runs.done)}`, width);
        await expect(page.locator('[data-run-header] [data-status-word]')).toBeVisible();

        await expect(runRail(page)).toBeVisible();
        if ('tokens' in run) await expect(railFact(page, 'Tokens')).toHaveText(run.tokens);
        else await expect(railFact(page, 'Tokens')).toHaveCount(0);
        if ('cost' in run) await expect(railFact(page, COST_COPY.label)).toHaveText(run.cost);
        else await expect(railFact(page, COST_COPY.label)).toHaveCount(0);
        await expect(page.getByText('$0.00')).toHaveCount(0);
        await captureForDesignReview(page, {
          route: '/runs/:run',
          state: run.state,
          source: SOURCE,
        });
      });
    }
  }
});

/** A run as `bureau.tasks.list` answers it, with the `usage` the Bureau recorded. */
function listedRun(id: string, createdAt: string, reported: Json | null, extra: Json = {}): Json {
  return {
    id,
    contextId: id,
    agentName: 'tool-runner',
    owner: 'anonymous:local',
    actor: null,
    kind: 'chat',
    origin: { kind: 'api' },
    status: 'completed',
    finishReason: 'stop',
    statusMessage: null,
    createdAt,
    updatedAt: createdAt,
    cleanup: null,
    openWaits: [],
    usage: reported,
    ...extra,
  };
}

/** The workflow instance's two steps: one priced, one with no cost, so the instance reads "At least". */
function instanceStep(id: string, createdAt: string, costUsd: number | null): Json {
  return listedRun(id, createdAt, usage(9_000, costUsd), {
    kind: 'catalog',
    origin: { kind: 'parent', parentRunId: 'run-cost-instance' },
  });
}

const FIXTURE_RUNS: readonly Json[] = [
  listedRun('run-cost-priced', '2026-11-02T16:45:00.000Z', usage(48_200, 12.3456)),
  listedRun('run-cost-small', '2026-11-02T16:44:30.000Z', usage(310, 0.0042)),
  instanceStep('run-cost-step-1', '2026-11-02T16:44:00.000Z', 3.4),
  instanceStep('run-cost-step-2', '2026-11-02T16:44:10.000Z', null),
  listedRun('run-cost-tokens-only', '2026-11-02T16:43:00.000Z', usage(48_200, null)),
  listedRun('run-cost-no-usage', '2026-11-02T16:42:00.000Z', null),
];

/** Adds the fixture runs to the first page of the Bureau's real answer. */
async function listPricedRuns(page: Page): Promise<void> {
  await page.route(isBureauCall, async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      method?: string;
      params?: Json;
    };
    if (body.method !== 'bureau.tasks.list') {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const answer = (await response.json()) as { result?: { tasks?: unknown[] } };
    const first = body.params?.['pageToken'] === undefined;
    const tasks = [...(first ? FIXTURE_RUNS : []), ...(answer.result?.tasks ?? [])];
    await route.fulfill({ response, json: { ...answer, result: { ...answer.result, tasks } } });
  });
}

test.describe('/runs: the Cost column (COR-2525)', () => {
  test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

  for (const width of WIDTHS) {
    test(`priced rows, an "At least" workflow instance and rows with no cost at ${String(width)} pixels`, async ({
      page,
    }) => {
      await listPricedRuns(page);
      await openAt(page, '/runs', width);

      const cost = (id: string) =>
        page.locator(`main li[data-run="${id}"]`).getByTestId('run-cost');
      await expect(cost('run-cost-priced')).toHaveText('$12.35');
      await expect(cost('run-cost-small')).toHaveText(COST_COPY.underOneCent);
      await expect(cost('run-cost-instance')).toHaveText(COST_COPY.atLeast('$3.40'));
      await expect(cost('run-cost-tokens-only')).toHaveCount(0);
      await expect(cost('run-cost-no-usage')).toHaveCount(0);
      await expect(page.getByText('$0.00')).toHaveCount(0);
      if (width > 640) {
        // The trailing track is one width in every row: the time of a row with a cost ends where
        // the time of a row with none does.
        const timeEdge = async (id: string) =>
          page
            .locator(`main li[data-run="${id}"] time`)
            .evaluate((element) => Math.round(element.getBoundingClientRect().right));
        const priced = await timeEdge('run-cost-priced');
        expect(await timeEdge('run-cost-no-usage')).toBe(priced);
        expect(await timeEdge('run-cost-instance')).toBe(priced);
        // A cost sits on the first line, level with the title's text.
        const level = async (selector: string) =>
          page
            .locator(`main li[data-run="run-cost-priced"] ${selector}`)
            .first()
            .evaluate((element) => Math.round(element.getBoundingClientRect().bottom));
        expect(
          Math.abs((await level('[data-testid="run-cost"]')) - (await level('time'))),
        ).toBeLessThanOrEqual(3);
      }
      await captureForDesignReview(page, {
        route: '/runs',
        state: 'cost column',
        source: SOURCE,
      });
    });
  }
});

/** The goal's attempts with a cost each; one cost per attempt, `null` for an attempt with none. */
function pricedAttempts(attempts: readonly Json[], costs: readonly (number | null)[]): Json[] {
  // A goal with fewer attempts than costs gets copies of its first, so every cost has an attempt.
  const padded = costs.map((_cost, index) => {
    const attempt = attempts[index] ?? attempts[0] ?? {};
    return index < attempts.length
      ? attempt
      : { ...attempt, attemptId: `${String(attempt['attemptId'])}-${String(index)}` };
  });
  return padded.map((attempt, index) => ({
    ...attempt,
    usage: { steps: 3, tokens: 12_000, costUsd: costs[index] ?? null },
  }));
}

test.describe('/goals: what a goal cost (COR-2525)', () => {
  test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

  for (const width of WIDTHS) {
    test(`a full, a partial and no cost at ${String(width)} pixels`, async ({ page }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      const costs = new Map<string, readonly (number | null)[]>([
        [world.goals.sayHello, [1.25]],
        [world.goals.summarizeRefunds, [4.5, null]],
        [world.goals.draftReleaseNotes, [null]],
      ]);
      await rewriteBureauAnswer(page, 'bureau.goals.list', (result) => ({
        ...result,
        goals: ((result['goals'] as Json[] | undefined) ?? []).map((goal) => {
          const priced = costs.get(String(goal['goalRunId']));
          return priced === undefined
            ? goal
            : { ...goal, attempts: pricedAttempts((goal['attempts'] as Json[]) ?? [], priced) };
        }),
      }));
      await openAt(page, '/goals', width);

      const cost = (id: string) =>
        page.locator(`main li[data-goal="${id}"]`).getByTestId('goal-cost');
      await expect(cost(world.goals.sayHello)).toHaveText('$1.25');
      await expect(cost(world.goals.summarizeRefunds)).toHaveText(COST_COPY.atLeast('$4.50'));
      await expect(cost(world.goals.draftReleaseNotes)).toHaveCount(0);
      await expect(page.getByText('$0.00')).toHaveCount(0);
      await captureForDesignReview(page, {
        route: '/goals',
        state: 'full, partial and no cost',
        source: SOURCE,
      });
    });
  }
});

/** The three run items the Bureau lists once runs stall, loop and overspend; no row words them yet. */
const RUN_ATTENTION_ITEMS: readonly Json[] = [
  {
    kind: 'run-overspending',
    area: 'runs',
    at: Date.parse('2026-11-02T16:40:00.000Z'),
    runId: 'run-cost-priced',
    agentName: 'tool-runner',
    costUsd: 12.3456,
    thresholdUsd: 10,
    settledAt: null,
  },
  {
    kind: 'run-stalled',
    area: 'runs',
    at: Date.parse('2026-11-02T16:30:00.000Z'),
    runId: 'run-cost-stalled',
    agentName: 'tool-runner',
  },
  {
    kind: 'run-looping',
    area: 'runs',
    at: Date.parse('2026-11-02T16:20:00.000Z'),
    runId: 'run-cost-looping',
    agentName: null,
  },
];

test.describe('/health: Needs attention while the Bureau lists runs over the threshold (COR-2525)', () => {
  test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

  for (const width of WIDTHS) {
    test(`the run items are counted and have no row yet, at ${String(width)} pixels`, async ({
      page,
    }) => {
      await rewriteBureauAnswer(page, 'bureau.health.attention', (result) => {
        const items = [...((result['items'] as Json[] | undefined) ?? []), ...RUN_ATTENTION_ITEMS];
        const checks = ((result['checks'] as Json[] | undefined) ?? []).filter(
          (check) => check['area'] !== 'runs',
        );
        return {
          ...result,
          items,
          count: items.length,
          checks: [...checks, { area: 'runs', count: RUN_ATTENTION_ITEMS.length }],
        };
      });
      await openAt(page, '/health', width);

      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const attention = page.getByTestId('needs-attention');
      const settledAttention = attention
        .getByRole('list', { name: 'Needs attention' })
        .or(page.getByTestId('needs-attention-clear'));
      await expect(settledAttention).toBeVisible();
      await expect(page.getByText('run-cost-priced')).toHaveCount(0);
      await captureForDesignReview(page, {
        route: '/health',
        state: 'needs attention with no run rows yet',
        source: SOURCE,
      });
    });
  }
});

const THRESHOLD_KEY = 'runs.spendThresholdUsd';

test.describe('/settings: the spend threshold (COR-2527)', () => {
  test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

  for (const width of WIDTHS) {
    test(`a number field that refuses 0 and a negative amount, unset and refused, at ${String(width)} pixels`, async ({
      page,
    }) => {
      await openAt(page, '/settings', width);
      const advanced = page.getByRole('button', { name: 'Advanced', exact: true });
      await expect(advanced).toHaveAttribute('aria-expanded', 'false');
      await advanced.click();
      await expect(advanced).toHaveAttribute('aria-expanded', 'true');
      const row = page.locator(`[data-setting="${THRESHOLD_KEY}"]`);
      await expect(row).toBeVisible();
      await expect(row).toContainText(COST_COPY.threshold.label);
      const field = row.getByRole('spinbutton');
      await expect(field).toBeVisible();
      await expect(row).toContainText(COST_COPY.threshold.unit);
      await captureForDesignReview(page, {
        route: '/settings',
        state: 'spend threshold unset',
        source: SOURCE,
      });

      // Nothing is saved: the row only says why the amount is refused.
      await field.fill('0');
      await field.blur();
      await expect(row).toContainText('Enter more than 0.');
      await field.fill('-5');
      await field.blur();
      await expect(row).toContainText('Enter more than 0.');
      await captureForDesignReview(page, {
        route: '/settings',
        state: 'spend threshold refused',
        source: SOURCE,
      });
    });
  }
});

const REPLY_COPY = CHAT_COPY.replyDetails;

/** Rewrites the cost of every run the page watches end: its `RUN_FINISHED` carries `costUsd`. */
async function priceStreamedRuns(page: Page, costUsd: number | null): Promise<void> {
  await page.route('**/bureau/ag-ui**', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const text = await response.text();
    const value = costUsd === null ? 'null' : String(costUsd);
    await route.fulfill({
      response,
      body: text.replaceAll(/"costUsd":\s*[^,}\]]+/g, `"costUsd":${value}`),
    });
  });
}

test.describe('/chats/:chat: the cost in a reply’s details (COR-2525)', () => {
  const CASES = [
    { state: 'reply details with a cost', cost: 12.3456, shown: '$12.35' },
    { state: 'reply details with no cost', cost: null, shown: undefined },
  ] as const;

  for (const width of WIDTHS) {
    for (const reply of CASES) {
      test(`${reply.state} at ${String(width)} pixels`, async ({ page }) => {
        await priceStreamedRuns(page, reply.cost);
        await page.setViewportSize({ width, height: 900 });
        await page.goto('/chats/new?agent=demo:assistant');
        await untilChatLoaded(page);
        const composer = page.getByRole('textbox');
        await composer.fill('Say hello');
        await composer.press('Enter');
        const assistant = page.locator('[data-message-role="assistant"]');
        await expect(assistant).toHaveCount(1);

        await assistant.first().hover();
        await page.getByRole('button', { name: REPLY_COPY.action }).first().click();
        const panel = page.getByTestId('reply-details');
        await expect(panel).toBeVisible();
        if (reply.shown === undefined) {
          await expect(panel.getByTestId('reply-cost')).toHaveCount(0);
        } else {
          await expect(panel.getByTestId('reply-cost')).toHaveText(reply.shown);
        }
        await expect(panel).not.toContainText('$0.00');
        await captureForDesignReview(page, {
          route: '/chats/:chat',
          state: reply.state,
          source: SOURCE,
        });
      });
    }
  }
});
