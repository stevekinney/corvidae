/**
 * A fault's remediation and Retry (COR-2560), on the two ways a screen draws a classified fault on
 * Cinder's `ErrorState`: the Hooks list's failed first load (an `ErrorState` of the page whose
 * description says what failed) and the Reviews page's fault row (`src/app/fault-error-state.svelte`,
 * the row the fault boundary and every query fault banner share). Either way the fault's
 * `remediation` is its own line under the description, never the heading, and Retry is offered
 * unless the fault says `retryable: false`.
 *
 * Each state answers the surface's list with a JSON-RPC fault that carries the advice where the
 * Bureau puts it, in `error.data` next to `httpStatus` (`postBureauCall`,
 * `src/lib/bureau-transport.ts`, copies it onto the thrown error with `faultAdviceOf`), so the page
 * reads exactly what a real fault gives it. Each state is a named capture for the design review, at
 * 1280 and at a phone (the capture repeats a phone at 320 by 640). The three states: a retryable
 * fault with a remediation, a fault that is not retryable (its remediation stays, Retry goes), and a
 * fault with no remediation (Retry stays, no line).
 *
 * Not drawn: the fault boundary itself, which only a thrown render error reaches and no page
 * throws on purpose; it draws the same `fault-error-state.svelte` row as the Reviews page's.
 */
import type { Locator, Page } from '@playwright/test';

import { SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';

const BUREAU_CALLS = '**/jsonrpc';
const BUREAU_LOGGED = /\/jsonrpc/;
const WIDTHS = [1280, 375] as const;
const SOURCE = 'fault-remediation.spec.ts';

/** The advice a fault carries, as the Bureau puts it in `error.data`. */
interface Advice {
  readonly retryable?: boolean;
  readonly remediation?: string;
}

/** One screen that draws a classified fault, and how to find the fault on it. */
interface Surface {
  /** The route the screen is on, which every test title names. */
  readonly route: '/hooks' | '/reviews';
  /** The Bureau call whose failure the screen draws. */
  readonly method: string;
  /** Waits for the screen to show the failed state, and answers the region that holds the fault. */
  readonly failed: (page: Page) => Promise<Locator>;
  /** Captures the screen for the design review under the name of `state`. */
  readonly capture: (page: Page, state: string) => Promise<void>;
}

const SURFACES: readonly Surface[] = [
  {
    route: '/hooks',
    method: 'bureau.hooks.list',
    async failed(page) {
      const main = page.locator('main');
      await expect(
        main.getByRole('heading', { level: 2, name: 'Couldn’t load hooks' }),
      ).toBeVisible();
      await expect(main).toContainText(
        'The server answered with an error (503). Nothing you did caused it.',
      );
      return main;
    },
    capture: (page, state) =>
      captureForDesignReview(page, { route: '/hooks', state, source: SOURCE }),
  },
  {
    route: '/reviews',
    method: 'bureau.reviews.list',
    async failed(page) {
      const fault = page.locator('[data-page="reviews"] .weft-fault-boundary').first();
      await expect(fault.getByRole('heading', { name: 'Something went wrong' })).toBeVisible();
      await expect(fault).toContainText('The Bureau is not ready.');
      return fault;
    },
    capture: (page, state) =>
      captureForDesignReview(page, { route: '/reviews', state, source: SOURCE }),
  },
];

/**
 * Answers every call of `method` with a JSON-RPC fault carrying `advice`: a 503 unless `status` says
 * otherwise, which the console classifies by status (503 is `internal`, 409 is `conflict`).
 */
async function answerWithFault(page: Page, method: string, advice: Advice, status = 503) {
  await page.route(BUREAU_CALLS, async (route) => {
    const body = route.request().postData() ?? '';
    if (!body.includes(`"${method}"`)) {
      await route.fallback();
      return;
    }
    const { id } = JSON.parse(body) as { id: unknown };
    await route.fulfill({
      status,
      json: {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32000,
          message: 'The Bureau is not ready.',
          data: { httpStatus: status, ...advice },
        },
      },
    });
  });
}

for (const surface of SURFACES) {
  test.describe(`${surface.route}: a fault’s remediation and Retry`, () => {
    test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

    for (const width of WIDTHS) {
      /** Opens the screen at `width` with its call answered by a fault carrying `advice`. */
      async function openFailed(
        page: Page,
        pageErrors: { expectEvery: (rule: { pattern: RegExp; reason: string }) => void },
        advice: Advice,
      ): Promise<Locator> {
        await page.setViewportSize({ width, height: 900 });
        pageErrors.expectEvery({
          pattern: loggedFailedResponse(503, BUREAU_LOGGED),
          reason: `the test answers ${surface.method} with a 503`,
        });
        await answerWithFault(page, surface.method, advice);
        await page.goto(surface.route);
        return surface.failed(page);
      }

      const tryAgain = (fault: Locator) => fault.getByRole('button', { name: 'Try again' });
      const remediationLine = (fault: Locator) => fault.locator('.cinder-error-state-remediation');

      test(`${surface.route}: a retryable fault shows its remediation under the description and offers Try again, at ${width} pixels`, async ({
        page,
        checkA11y,
        pageErrors,
      }) => {
        const remediation = 'The server is starting. Wait a moment, then try again.';
        const fault = await openFailed(page, pageErrors, { retryable: true, remediation });

        await expect(remediationLine(fault)).toHaveText(remediation);
        // The remediation is a line under the description, never the heading.
        await expect(fault.getByRole('heading').first()).not.toContainText(remediation);
        await expect(tryAgain(fault)).toHaveCount(1);

        await surface.capture(page, 'fault retryable with remediation');
        await checkA11y(
          `${surface.route} failed, a retryable fault with a remediation, ${width}px`,
        );
      });

      test(`${surface.route}: a fault that is not retryable keeps its remediation and offers no Try again, at ${width} pixels`, async ({
        page,
        checkA11y,
        pageErrors,
      }) => {
        const remediation = 'Open Health to see which part of the server stopped, then start it.';
        const fault = await openFailed(page, pageErrors, { retryable: false, remediation });

        await expect(remediationLine(fault)).toHaveText(remediation);
        await expect(tryAgain(fault)).toHaveCount(0);

        await surface.capture(page, 'fault not retryable');
        await checkA11y(`${surface.route} failed, a fault that is not retryable, ${width}px`);
      });

      test(`${surface.route}: a fault with no remediation shows no extra line and still offers Try again, at ${width} pixels`, async ({
        page,
        checkA11y,
        pageErrors,
      }) => {
        const fault = await openFailed(page, pageErrors, {});

        await expect(remediationLine(fault)).toHaveCount(0);
        await expect(tryAgain(fault)).toHaveCount(1);

        await surface.capture(page, 'fault with no remediation');
        await checkA11y(`${surface.route} failed, a fault with no remediation, ${width}px`);
      });
    }
  });
}

// A conflict is the warning tone of the shared fault row (`conflict` and `unreachable`, which
// Cinder's `ErrorState` draws in the warning colors): amber, not red, and still announced as an
// alert. Only the Reviews page's row has a tone of its own; the Hooks list's failed state is always
// a failure.
test.describe('/reviews: a conflict is drawn in the warning tone', () => {
  test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

  for (const width of WIDTHS) {
    test(`/reviews: a conflict shows its remediation in the warning tone and offers Try again, at ${width} pixels`, async ({
      page,
      checkA11y,
      pageErrors,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      pageErrors.expectEvery({
        pattern: loggedFailedResponse(409, BUREAU_LOGGED),
        reason: 'the test answers bureau.reviews.list with a 409',
      });
      const remediation = 'Read the list again, then decide.';
      await answerWithFault(page, 'bureau.reviews.list', { retryable: true, remediation }, 409);
      await page.goto('/reviews');

      const fault = page.locator('[data-page="reviews"] .weft-fault-boundary').first();
      await expect(fault.getByRole('heading', { name: 'Conflict' })).toBeVisible();
      await expect(fault).toHaveAttribute('data-tone', 'warning');
      await expect(fault.getByRole('alert')).toHaveCount(1);
      await expect(fault.locator('.cinder-error-state-remediation')).toHaveText(remediation);
      await expect(fault.getByRole('button', { name: 'Try again' })).toHaveCount(1);

      await captureForDesignReview(page, {
        route: '/reviews',
        state: 'fault warning conflict',
        source: SOURCE,
      });
      await checkA11y(`/reviews failed, a conflict in the warning tone, ${width}px`);
    });
  }
});
