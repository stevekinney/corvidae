/**
 * The goal page (`/goals/:goal`) in the states the design review judges and the sample world does
 * not show on its own (COR-2425, rows 67n, 67p and 67x), captured on a desktop and a phone:
 *
 * - a working goal (67x): Summarize open refunds answers as a goal whose second attempt has run and
 *   whose result is being checked, by rewriting the Bureau's answer to `bureau.goals.get`, the way
 *   `run-page-live-states.spec.ts` builds its live run;
 * - Start again held (67p): Summarize open refunds runs Tool runner, a model agent, and the sample
 *   world connects no provider, so Start again is held with "Connect a provider" beneath it;
 * - Start again pressed (67n): Draft release notes runs the scripted Assistant, so Start again is
 *   live and opens New goal prefilled with the goal's prompt and check.
 * - Edit (68o, 68p): Summarize open refunds opens as its Tool runner goal with the connected
 *   provider state, its own prompt and check prefilled, and the Save footer visible.
 *
 * Not run on this host (the browser suites run on GitHub, `main.yml`).
 */
import type { Page, Route } from '@playwright/test';

import { SAMPLE_NOW, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { SAMPLE_WORLD_DURATIONS } from '../../fixtures/sample-world-history.ts';
import { readSampleWorldRecords } from '../../fixtures/sample-world-records.ts';
import { isBureauCall } from './bureau-answer-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';
import { readBoxes } from './read-boxes.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'goal-page-states.spec.ts';
const WIDTHS = [1280, 375] as const;

type JsonRecord = Record<string, unknown>;

/** When the captioned working goal was created and made its first attempt: Mon, Nov 2, 10:41 AM (67x). */
const WORKING_GOAL_CREATED = Date.parse('2026-11-02T10:41:00-06:00');
/** How long the run of the attempt being checked took: the sample world's second attempt's run. */
const WORKING_ATTEMPT_RUN_MILLISECONDS =
  SAMPLE_WORLD_DURATIONS.summarizeRefundsSecondAttempt * 1000;
const REFUNDS_PROMPT =
  'Summarize open refunds. List every refund that is waiting for approval and say why.';
const RELEASE_NOTES_PROMPT =
  'Draft release notes from the pull requests merged since the last release. Group them as fixes, features and chores. Keep the notes under 200 words, write in plain language, and be sure to mention the staging fix, which changed how releases are checked before they go out.';

/** Answers the host provider list as connected, without changing the seeded goal or agent records. */
async function connectProvider(page: Page): Promise<void> {
  await page.route('**/host/providers', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { providers: Record<string, unknown>[] };
    await route.fulfill({
      response,
      json: {
        ...body,
        providers: body.providers.map((provider) => ({
          ...provider,
          hasKey: true,
          connected: true,
        })),
      },
    });
  });
}

/** Opens `path` at `width` and waits until the goal's attempts are listed. */
async function openGoal(page: Page, path: string, width: number): Promise<void> {
  await page.clock.setFixedTime(SAMPLE_NOW);
  await page.setViewportSize({ width, height: 900 });
  await page.goto(path);
  // A goal with no attempt shows the empty state alone, without the heading (owner report, 2026-11-19).
  await expect(
    page.getByTestId('goal-attempts-heading').or(page.getByTestId('goal-attempts-empty')),
  ).toBeVisible();
}

/** Opens an edit form after its data has been read, preserving the page's fixed capture clock. */
async function openGoalEdit(page: Page, path: string, width: number): Promise<void> {
  await page.clock.setFixedTime(SAMPLE_NOW);
  await page.setViewportSize({ width, height: 900 });
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: 'Edit goal' })).toBeVisible();
}

/** The edit witness holds after the capture helper repeats a phone shot at 320px. */
async function editGoalReady(page: Page): Promise<void> {
  await expect(page.getByLabel('What should the agent do?')).toHaveValue(REFUNDS_PROMPT);
  await expect(
    page.getByRole('button', { name: /Summary lists every refund waiting for approval/ }),
  ).toBeVisible();
  await expect(page.getByLabel('Attempt limit')).toHaveValue('5');
  await expect(page.getByText('Saving doesn’t start an attempt.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
}

/** The long prompt remains clamped after a capture helper resizes a phone to 320px. */
async function gaveUpPromptReady(page: Page): Promise<void> {
  const asked = page.getByTestId('goal-asked');
  await expect(asked).toContainText(RELEASE_NOTES_PROMPT);
  await expect(asked.getByRole('button', { name: 'Show more' })).toBeVisible();
}

/**
 * Makes the goal answer as one at work: its newest attempt's agent has finished and the check is
 * reading the result, so the goal and that attempt are `evaluating`, nothing is closed, and nothing
 * canceled it.
 */
async function answerAsWorkingGoal(page: Page): Promise<void> {
  await page.route(isBureauCall, async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { method?: string };
    if (body.method !== 'bureau.goals.get') {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const answer = (await response.json()) as { result?: JsonRecord };
    const goal = answer.result ?? {};
    const attempts = (goal['attempts'] as JsonRecord[] | undefined) ?? [];
    const newest = Math.max(...attempts.map((attempt) => Number(attempt['attemptIndex'])));
    // The captioned goal is today's (67x: created Mon, Nov 2, 10:41 AM, its first attempt then):
    // every time the goal records moves by the same amount, so each attempt keeps its own span, and
    // what each attempt's run took is still read from the run.
    const first = attempts.find((attempt) => Number(attempt['attemptIndex']) === 0);
    const shift =
      WORKING_GOAL_CREATED - Date.parse(String(first?.['startedAt'] ?? goal['createdAt']));
    const moved = (value: unknown): unknown =>
      typeof value === 'string' && Number.isFinite(Date.parse(value))
        ? new Date(Date.parse(value) + shift).toISOString()
        : value;
    const newestStarted = attempts.find((attempt) => Number(attempt['attemptIndex']) === newest)?.[
      'startedAt'
    ];
    await route.fulfill({
      response,
      json: {
        ...answer,
        result: {
          ...goal,
          status: 'evaluating',
          terminalReason: null,
          closedAt: null,
          cancellation: null,
          createdAt: moved(goal['createdAt']),
          // The move to checking is the goal's last write, made as the newest attempt's run ended.
          updatedAt: new Date(
            Date.parse(String(moved(newestStarted))) + WORKING_ATTEMPT_RUN_MILLISECONDS,
          ).toISOString(),
          attempts: attempts.map((attempt) =>
            Number(attempt['attemptIndex']) === newest
              ? {
                  ...attempt,
                  startedAt: moved(attempt['startedAt']),
                  status: 'evaluating',
                  completedAt: null,
                  finishReason: null,
                }
              : {
                  ...attempt,
                  startedAt: moved(attempt['startedAt']),
                  completedAt: moved(attempt['completedAt']),
                },
          ),
        },
      },
    });
  });
}

for (const width of WIDTHS) {
  // The routes lead the title, so a design review's route filter (`--grep '/goals'`) runs these.
  test.describe(`/goals/:goal and /goals/new at ${String(width)} pixels`, () => {
    test('a working goal says its newest attempt is checking the result (67x)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await answerAsWorkingGoal(page);
      await openGoal(page, `/goals/${encodeURIComponent(world.goals.summarizeRefunds)}`, width);
      await expect(page.locator('[data-attempt]').first()).toHaveAttribute(
        'data-status-word',
        /Running/,
      );
      // What its run took, never the time since it started (67x).
      await expect(page.locator('[data-attempt]').first()).toContainText('Agent took 1 min 12 s');
      await captureForDesignReview(page, {
        route: '/goals/:goal',
        state: 'working',
        source: SOURCE,
      });
    });

    test('with no provider, Start again on a model agent’s goal is held with Connect a provider beneath it (67p)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await openGoal(page, `/goals/${encodeURIComponent(world.goals.summarizeRefunds)}`, width);
      const reason = page.getByTestId('goal-provider-reason');
      await expect(reason).toBeVisible();
      const again = page.getByRole('link', { name: 'Start again' });
      await expect(again).toHaveAttribute('aria-disabled', 'true');
      await expect(again).toHaveAttribute(
        'aria-describedby',
        (await reason.getAttribute('id')) ?? '',
      );
      // Beneath the button, never beside the status word.
      const { button, below } = await readBoxes(page, { button: again, below: reason });
      expect(below.y).toBeGreaterThanOrEqual(button.y + button.height - 1);
      await captureForDesignReview(page, {
        route: '/goals/:goal',
        state: 'start again held',
        source: SOURCE,
      });
    });

    test('Start again on a scripted agent’s goal opens New goal prefilled with its prompt and check (67n)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await openGoal(page, `/goals/${encodeURIComponent(world.goals.draftReleaseNotes)}`, width);
      const again = page.getByRole('link', { name: 'Start again' });
      await expect(again).not.toHaveAttribute('aria-disabled', 'true');
      await again.click();
      await expect(page).toHaveURL(/\/goals\/new/);
      await expect(page.getByLabel('What should the agent do?')).not.toHaveValue('');
      await captureForDesignReview(page, {
        route: '/goals/new',
        state: 'start again prefilled',
        source: SOURCE,
      });
    });

    test('a connected provider preserves the stopped Tool runner goal in Edit, with its own fields and Save footer (68o, 68p)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await connectProvider(page);
      await openGoalEdit(
        page,
        `/goals/${encodeURIComponent(world.goals.summarizeRefunds)}/edit`,
        width,
      );
      await editGoalReady(page);
      await captureForDesignReview(page, {
        route: '/goals/:goal/edit',
        state: 'edit goal prefilled',
        source: SOURCE,
        ready: editGoalReady,
      });
    });
  });
}

test('the gave-up goal keeps its exact long prompt behind Show more on a phone (67j)', async ({
  page,
}) => {
  const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
  await openGoal(page, `/goals/${encodeURIComponent(world.goals.draftReleaseNotes)}`, 375);
  await gaveUpPromptReady(page);
  await captureForDesignReview(page, {
    route: '/goals/:goal',
    state: 'gave up, prompt clamped',
    source: SOURCE,
    ready: gaveUpPromptReady,
  });
});
