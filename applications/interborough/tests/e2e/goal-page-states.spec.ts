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
const WIDTHS =
  process.env['INTERBOROUGH_DESIGN_REVIEW_CAPTURE'] === undefined
    ? ([1920, 1280, 375, 320] as const)
    : ([1280, 375] as const);

type JsonRecord = Record<string, unknown>;

/** When the captioned working goal was created and made its first attempt: Mon, Nov 2, 10:41 AM (67x). */
const WORKING_GOAL_CREATED = Date.parse('2026-11-02T10:41:00-06:00');
/** How long the run of the attempt being checked took: the sample world's second attempt's run. */
const WORKING_ATTEMPT_RUN_MILLISECONDS =
  SAMPLE_WORLD_DURATIONS.summarizeRefundsSecondAttempt * 1000;
const WORKING_ATTEMPT_FIRST = Date.parse('2026-11-02T10:41:00-06:00');
const WORKING_ATTEMPT_NEWEST = Date.parse('2026-11-02T10:44:00-06:00');
const REFUNDS_PROMPT =
  'Summarize open refunds. List every refund that is waiting for approval and say why.';
const REFUNDS_CHECK_NAME = 'summary-lists-every-refund-waiting-for-approval';
const REFUNDS_CHECK_LABEL = 'Summary lists every refund waiting for approval';
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

/**
 * The captioned Edit state names its real configured check in prose. It keeps the same catalog
 * source, version and configuration schema, while the matching goal view retains its phrase.
 */
async function captionRefundCheck(page: Page): Promise<void> {
  await page.route(isBureauCall, async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { method?: string };
    if (body.method !== 'bureau.goals.get' && body.method !== 'bureau.validators.list') {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const answer = (await response.json()) as { result?: JsonRecord };
    if (body.method === 'bureau.goals.get') {
      const goal = answer.result ?? {};
      await route.fulfill({
        response,
        json: {
          ...answer,
          result: {
            ...goal,
            validator: { ...(goal['validator'] as JsonRecord), name: REFUNDS_CHECK_NAME },
          },
        },
      });
      return;
    }
    const result = answer.result ?? {};
    const validators = (result['validators'] as JsonRecord[] | undefined) ?? [];
    await route.fulfill({
      response,
      json: {
        ...answer,
        result: {
          ...result,
          validators: validators.map((validator) =>
            validator['name'] === 'contains-phrase' && validator['version'] === '1'
              ? { ...validator, name: REFUNDS_CHECK_NAME }
              : validator,
          ),
        },
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
  await expect(page.getByRole('combobox', { name: 'Check' })).toHaveText(
    `${REFUNDS_CHECK_LABEL}, version 1`,
  );
  await expect(page.getByLabel('Phrase')).toHaveValue('waiting for approval');
  await expect(page.getByRole('combobox', { name: 'Agent' })).toHaveValue('tool-runner');
  await expect(page.getByRole('spinbutton', { name: 'Attempt limit' })).toHaveValue('5');
  await expect(page.getByText('Saving doesn’t start an attempt.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled();
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
          createdAt: new Date(WORKING_GOAL_CREATED).toISOString(),
          // The move to checking is the goal's last write, made as the newest attempt's run ended.
          updatedAt: new Date(
            WORKING_ATTEMPT_NEWEST + WORKING_ATTEMPT_RUN_MILLISECONDS,
          ).toISOString(),
          attempts: attempts.map((attempt) =>
            Number(attempt['attemptIndex']) === newest
              ? {
                  ...attempt,
                  startedAt: new Date(WORKING_ATTEMPT_NEWEST).toISOString(),
                  status: 'evaluating',
                  completedAt: null,
                  finishReason: null,
                }
              : {
                  ...attempt,
                  startedAt: new Date(WORKING_ATTEMPT_FIRST).toISOString(),
                  feedback: 'Summary listed 3 of 4 refunds waiting for approval',
                },
          ),
        },
      },
    });
  });
}

/** Rewrites only this capture's owner goal view, leaving the sample world and validator catalog intact. */
async function rewriteGoalView(
  page: Page,
  change: (goal: JsonRecord) => JsonRecord,
): Promise<void> {
  await page.route(isBureauCall, async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { method?: string };
    if (body.method !== 'bureau.goals.get') {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const answer = (await response.json()) as { result?: JsonRecord };
    await route.fulfill({
      response,
      json: { ...answer, result: change(answer.result ?? {}) },
    });
  });
}

/** The five release-note failures use the distinct feedback captions from row 67l. */
async function captionGaveUpAttempts(page: Page): Promise<void> {
  const feedback = [
    'Notes didn’t mention the staging fix',
    'Notes didn’t mention the staging fix',
    'Notes were over the length limit',
    'Notes didn’t mention the staging fix',
    'Notes didn’t mention the staging fix',
  ];
  await rewriteGoalView(page, (goal) => ({
    ...goal,
    attempts: ((goal['attempts'] as JsonRecord[] | undefined) ?? []).map((attempt) => ({
      ...attempt,
      feedback: feedback[Number(attempt['attemptIndex'])] ?? null,
    })),
  }));
}

/** The stopped refund's first check gives the captioned feedback from row 67r. */
async function captionStoppedAttempt(page: Page): Promise<void> {
  await rewriteGoalView(page, (goal) => ({
    ...goal,
    attempts: ((goal['attempts'] as JsonRecord[] | undefined) ?? []).map((attempt) =>
      Number(attempt['attemptIndex']) === 0
        ? { ...attempt, feedback: 'Summary listed 3 of 4 refunds waiting for approval' }
        : attempt,
    ),
  }));
}

/** The completed scripted goal names its check and the check's own successful reply (67v). */
async function captionDoneAttempt(page: Page): Promise<void> {
  await rewriteGoalView(page, (goal) => ({
    ...goal,
    validator: { ...(goal['validator'] as JsonRecord), name: 'reply-says-hello' },
    // The named caption is parameterless; the stock hello phrase would append its config here.
    validatorConfiguration: null,
    attempts: ((goal['attempts'] as JsonRecord[] | undefined) ?? []).map((attempt) => ({
      ...attempt,
      reason: 'Reply said hello',
    })),
  }));
}

/** Re-proves the captioned working attempt after the capture helper changes the viewport. */
async function workingGoalReady(page: Page): Promise<void> {
  const attempt = page.locator('[data-attempt]').first();
  await expect(attempt).toHaveAttribute('data-status-word', /Running/);
  // What its run took, never the time since it started (67x).
  await expect(attempt).toContainText('Agent took 1 min 12 s');
  await expect(attempt).toContainText('10:44 AM');
  await expect(page.locator('[data-attempt]').nth(1)).toContainText(
    'summary listed 3 of 4 refunds waiting for approval',
  );
  const statusDot = attempt.getByRole('img', { name: 'Running, checking the result' });
  await expect(statusDot).toBeVisible();
  const status = statusDot.locator(
    'xpath=ancestor::*[contains(@class, "cinder-stacked-list-item__status")][1]',
  );
  const statusLabel = statusDot.locator('.cinder-status-dot__label');
  const title = attempt.locator('.cinder-stacked-list-item__title');
  await expect(statusLabel).toHaveText('Running, checking the result');
  const boxes = await readBoxes(page, { status, statusLabel, title });
  const width = page.viewportSize()?.width;
  if (width !== undefined && width <= 375) {
    expect(boxes.title.y + boxes.title.height).toBeLessThanOrEqual(boxes.status.y);
  } else {
    expect(boxes.statusLabel.x + boxes.statusLabel.width).toBeLessThanOrEqual(boxes.title.x);
  }
  expect(
    await status.evaluate((element: HTMLElement) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
}

async function gaveUpAttemptsReady(page: Page): Promise<void> {
  await expect(page.getByTestId('goal-attempts-heading')).toContainText('Attempts 5 of 5');
  const expected = [
    ['Attempt 5', '8:21 AM', 'took 6 s', 'notes didn’t mention the staging fix'],
    ['Attempt 4', '8:19 AM', 'took 7 s', 'notes didn’t mention the staging fix'],
    ['Attempt 3', '8:17 AM', 'took 5 s', 'notes were over the length limit'],
    ['Attempt 2', '8:15 AM', 'took 6 s', 'notes didn’t mention the staging fix'],
    ['Attempt 1', '8:13 AM', 'took 8 s', 'notes didn’t mention the staging fix'],
  ] as const;
  for (const [index, values] of expected.entries()) {
    const attempt = page.locator('[data-attempt]').nth(index);
    for (const value of values) await expect(attempt).toContainText(value);
    await expect(attempt).toHaveAttribute('data-status-word', 'Check not met');
  }
}

async function stoppedAttemptsReady(page: Page): Promise<void> {
  await expect(page.getByTestId('goal-attempts-heading')).toContainText('Attempts 2 of 5');
  const newest = page.locator('[data-attempt]').first();
  await expect(newest).toContainText('Attempt 2');
  await expect(newest).toContainText('10:07 AM');
  await expect(newest).toContainText('Tool runner, canceled at 10:08 AM after 1 min 12 s');
  await expect(newest).toHaveAttribute('data-status-word', 'Canceled');
  const first = page.locator('[data-attempt]').nth(1);
  await expect(first).toContainText('Attempt 1');
  await expect(first).toContainText('10:05 AM');
  await expect(first).toContainText('Tool runner, took 2 min 5 s');
  await expect(first).toContainText('summary listed 3 of 4 refunds waiting for approval');
  await expect(first).toHaveAttribute('data-status-word', 'Check not met');
}

async function doneAttemptReady(page: Page): Promise<void> {
  await expect(page.getByTestId('goal-attempts-heading')).toContainText('Attempts 1 of 1');
  const details = page.getByRole('heading', { name: 'Details' }).locator('..');
  await expect(details).toContainText('Reply says hello');
  await expect(details).not.toContainText('"hello"');
  const attempt = page.locator('[data-attempt]').first();
  await expect(attempt).toContainText('Attempt 1');
  await expect(attempt).toContainText('7:48 AM');
  await expect(attempt).toContainText('Assistant, took 8 s, reply said hello');
  await expect(attempt).toHaveAttribute('data-status-word', 'Done');
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
      await workingGoalReady(page);
      await captureForDesignReview(page, {
        route: '/goals/:goal',
        state: 'working',
        source: SOURCE,
        ready: workingGoalReady,
      });
    });

    test('a gave-up goal shows the five distinct captioned attempt reasons (67l)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await captionGaveUpAttempts(page);
      await openGoal(page, `/goals/${encodeURIComponent(world.goals.draftReleaseNotes)}`, width);
      await gaveUpAttemptsReady(page);
      await captureForDesignReview(page, {
        route: '/goals/:goal',
        state: 'gave up attempts',
        source: SOURCE,
        ready: gaveUpAttemptsReady,
      });
    });

    test('a stopped goal shows its canceled attempt and captioned prior feedback (67r)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await captionStoppedAttempt(page);
      await openGoal(page, `/goals/${encodeURIComponent(world.goals.summarizeRefunds)}`, width);
      await stoppedAttemptsReady(page);
      await captureForDesignReview(page, {
        route: '/goals/:goal',
        state: 'stopped attempts',
        source: SOURCE,
        ready: stoppedAttemptsReady,
      });
    });

    test('a done goal shows the captioned check and successful reply (67v)', async ({ page }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await captionDoneAttempt(page);
      await openGoal(page, `/goals/${encodeURIComponent(world.goals.sayHello)}`, width);
      await doneAttemptReady(page);
      await captureForDesignReview(page, {
        route: '/goals/:goal',
        state: 'done attempt',
        source: SOURCE,
        ready: doneAttemptReady,
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
      await captionRefundCheck(page);
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
