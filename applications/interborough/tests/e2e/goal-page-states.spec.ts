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
 *
 * Not run on this host (the browser suites run on GitHub, `main.yml`).
 */
import type { Page } from '@playwright/test';

import {
  SAMPLE_NOW,
  SAMPLE_NOW_MILLISECONDS,
  SAMPLE_TIME_ZONE,
} from '../../fixtures/sample-now.ts';
import { readSampleWorldRecords } from '../../fixtures/sample-world-records.ts';
import { rewriteBureauAnswer } from './bureau-answer-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';
import { readBoxes } from './read-boxes.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'goal-page-states.spec.ts';
const WIDTHS = [1280, 375] as const;

type JsonRecord = Record<string, unknown>;

/** Opens `path` at `width` and waits until the goal's attempts are listed. */
async function openGoal(page: Page, path: string, width: number): Promise<void> {
  await page.clock.setFixedTime(SAMPLE_NOW);
  await page.setViewportSize({ width, height: 900 });
  await page.goto(path);
  await expect(page.getByTestId('goal-attempts-heading')).toBeVisible();
}

/**
 * Makes the goal answer as one at work: its newest attempt's agent has finished and the check is
 * reading the result, so the goal and that attempt are `evaluating`, nothing is closed, and nothing
 * canceled it.
 */
async function answerAsWorkingGoal(page: Page): Promise<void> {
  await rewriteBureauAnswer(page, 'bureau.goals.get', (goal: JsonRecord) => {
    const attempts = (goal['attempts'] as JsonRecord[] | undefined) ?? [];
    const newest = Math.max(...attempts.map((attempt) => Number(attempt['attemptIndex'])));
    return {
      ...goal,
      status: 'evaluating',
      terminalReason: null,
      closedAt: null,
      cancellation: null,
      updatedAt: new Date(SAMPLE_NOW_MILLISECONDS - 60_000).toISOString(),
      attempts: attempts.map((attempt) =>
        Number(attempt['attemptIndex']) === newest
          ? { ...attempt, status: 'evaluating', completedAt: null, finishReason: null }
          : attempt,
      ),
    };
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
  });
}
