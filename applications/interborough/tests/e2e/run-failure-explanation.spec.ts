/**
 * The Run page of a failed run says why it failed in the Bureau's words (COR-2533,
 * `bureau.tasks.explain`): the sample world's Release notes run, which failed at step 2 when GitHub
 * did not answer, is explained from what the Bureau stored of it, never from a model and never from
 * a sentence the browser holds per category. The block on the step that failed reads the sentence,
 * the cause and what to do next, and the link in Chat's failed line (`chat-states.spec.ts`) opens
 * this section.
 *
 * Captured for the design review on a desktop and a phone, in `/runs/:run`'s `failed run explained`
 * state. Not run on this host (the browser suites run on GitHub, `main.yml`).
 */
import { SAMPLE_NOW_MILLISECONDS, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { readSampleWorldRecords } from '../../fixtures/sample-world-records.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'run-failure-explanation.spec.ts';
const WIDTHS = [1280, 375] as const;

for (const width of WIDTHS) {
  // The route leads the title, so a design review's route filter (`--grep '/runs/:run'`) runs these.
  test.describe(`/runs/:run at ${String(width)} pixels, a failed run explained`, () => {
    test('reads the Bureau’s sentence, cause, step, tries and next step on the step that failed (COR-2533)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await page.clock.setFixedTime(SAMPLE_NOW_MILLISECONDS);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/runs/${encodeURIComponent(world.runs.failed)}`);

      const block = page.getByTestId('run-step-failure');
      const explanation = block.locator('[data-run-explanation]');
      // The sentence is the server's: it names the step and the cause, from stored identifiers.
      const summary = explanation.locator('[data-explanation="summary"]');
      await expect(summary).toContainText('GitHub returned HTTP 503');
      // The cause is plain text on the label's edge, not a badge in the alert's own tint.
      await expect(explanation.locator('[data-explanation="cause"]')).toBeVisible();
      await expect(explanation.locator('[data-explanation="cause"] .cinder-badge')).toHaveCount(0);
      await expect(explanation.locator('[data-explanation="remediation"]')).toContainText(
        'What to do next.',
      );
      // The failure is told once, on the step.
      await expect(page.locator('[data-run-explanation]')).toHaveCount(1);
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'failed run explained',
        source: SOURCE,
      });
    });
  });
}

for (const width of WIDTHS) {
  test.describe(`/runs/:run, the link to a failed run’s explanation at ${String(width)} pixels`, () => {
    test('opens the run’s page scrolled to the section that says why it failed (COR-2533)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await page.clock.setFixedTime(SAMPLE_NOW_MILLISECONDS);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/runs/${encodeURIComponent(world.runs.failed)}#failure-explanation`);

      // The section mounts after the run's own queries resolve, so the page scrolls to it itself
      // (the router's fragment), as it does after a client-side navigation from Chat.
      const section = page.locator('#failure-explanation');
      await expect(section).toBeVisible();
      await expect(section.locator('[data-explanation="summary"]')).toBeVisible();
      await expect(section).toBeInViewport();
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'after the Why it failed link, scrolled to the explanation',
        source: SOURCE,
      });
    });
  });
}
