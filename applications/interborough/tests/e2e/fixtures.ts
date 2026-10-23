/**
 * Playwright fixtures shared by every persona-flow spec (plan §11.4). The host serves one local
 * caller and asks for no sign-in, so the page needs no credential. There are two fixtures: the axe
 * gate, `checkA11y`, and an automatic one that fails a test whose page logged a console error,
 * threw, or had a request fail, unless `ALLOWED_PAGE_ERRORS` names it.
 */
import PlaywrightAxeBuilder from '@axe-core/playwright';
import { test as base, expect, type Page } from '@playwright/test';

/**
 * Polls every button/input's `background-color`/`color` across consecutive
 * animation frames until two consecutive samples are identical (or a bounded
 * number of frames elapses), so axe reads settled paint, not a
 * mid-transition blend.
 *
 * `foundation.css`'s reduced-motion rule (`*, ::before, ::after {
 * transition-duration: 0.01ms !important; }`, confirmed live against the
 * built CSS) collapses every Cinder transition to sub-frame length under
 * `use.reducedMotion: 'reduce'` (`playwright.config.ts`) — but "sub-frame"
 * still means the browser can paint an intermediate frame of an
 * interpolating `background-color`/`color` transition (e.g. a button's
 * disabled→enabled color swap, which every "fill the form, then check the
 * now-enabled submit button" step in this suite triggers) before settling.
 * Confirmed empirically, twice, with a fixed two-`requestAnimationFrame`
 * wait still in place: axe's own `color-contrast` check sampled a
 * DIFFERENT transitional blend on each run (`bgColor: '#adc1f3'` then
 * `'#5c79e7'`) on the identical "Submit decision" button, while a
 * `getComputedStyle` read moments later on the same element consistently
 * showed the correct settled `oklch(0.5 0.22 270)` background / `oklch(1 0
 * 0)` text (21:1) — so a FIXED frame count isn't a reliable bound here;
 * polling until the sample stops changing is.
 *
 * Cinder 0.21 added real `@starting-style` entry transitions to Modal and
 * Drawer, which exposed a second sampling hazard this poll alone cannot
 * see: the overlay PANEL fades in via `opacity`, and axe composites each
 * control's colors through that translucent ancestor — so a button whose
 * own `background-color`/`color` are already settled (signature stable)
 * still measures as a washed-out blend (observed: the drain dialog's
 * primary button flagged at 2.88:1 with bg `#8390ea` while its computed
 * resting style was the correct `oklch(0.5 0.22 270)` / 21:1). Two
 * additions close it: `waitForAnimationsToFinish` first awaits every
 * finite animation/transition on the page (near-instant under this
 * suite's `reducedMotion: 'reduce'`), and the signature below includes
 * `opacity` so an ancestor fade is itself detected as unsettled paint.
 */
async function waitForAnimationsToFinish(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // `Document.getAnimations()` already spans the whole document (the
    // `{ subtree }` option exists only on `Element.getAnimations()`).
    const finite = document.getAnimations().filter((animation) => {
      const timing = animation.effect?.getTiming();
      // Infinite animations (spinners, indeterminate progress) never
      // finish — awaiting them would deadlock; axe's contrast math is not
      // affected by them on this suite's screens.
      return timing !== undefined && timing.iterations !== Infinity;
    });
    await Promise.race([
      Promise.allSettled(finite.map((animation) => animation.finished)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  });
}

async function waitForPaintSettle(page: Page): Promise<void> {
  const MAX_FRAMES = 30;
  await page.evaluate((maxFrames) => {
    // `signature` must stay nested inside this `page.evaluate` callback to
    // run in the browser context; it cannot be hoisted to this file's
    // module scope (a genuinely separate JS realm), which is what the rule
    // below suggests.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    function signature(): string {
      return Array.from(
        document.querySelectorAll('button, input, textarea, select, dialog, [role="dialog"]'),
      )
        .map((el) => {
          const cs = getComputedStyle(el);
          return `${cs.backgroundColor}|${cs.color}|${cs.opacity}`;
        })
        .join(';');
    }
    return new Promise<void>((resolve) => {
      let previous = signature();
      let frame = 0;
      function tick(): void {
        frame += 1;
        const current = signature();
        if (current === previous || frame >= maxFrames) {
          resolve();
          return;
        }
        previous = current;
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
  }, MAX_FRAMES);
}

/**
 * Fails the test when the page has a serious or critical axe violation.
 * Moderate/minor findings are out of scope for this gate — plan §11.4's
 * "zero serious/critical axe violations" bar — surfaced but not asserted,
 * so a moderate finding never blocks a merge while still being visible in
 * the error message if the count is nonzero.
 */
async function assertNoSeriousAxeViolations(page: Page, screenLabel: string): Promise<void> {
  await waitForAnimationsToFinish(page);
  await waitForPaintSettle(page);
  const results = await new PlaywrightAxeBuilder({ page }).analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  const summary = blocking
    .map(
      (violation) =>
        `${violation.id} (${violation.impact}): ${violation.help} — ${violation.nodes.length} node(s)`,
    )
    .join('\n');
  expect(
    blocking,
    `axe found serious/critical violations at "${screenLabel}":\n${summary}`,
  ).toEqual([]);
}

/**
 * A report a test may leave unfixed. The suite-wide list, `ALLOWED_PAGE_ERRORS`, starts empty and
 * every entry is a reviewed edit: a page that reports an error, or a request that dies, is a
 * defect (AGENTS.md), so the way to clear one is to fix its cause. An entry is only for a cause
 * outside Interborough, and names it in `reason`. A test that makes the server fail on purpose
 * declares the failure it caused through `pageErrors.expect(...)` instead.
 */
export type PageErrorAllowance = {
  /** Matched against the line the page reported (see `describePageError`). */
  readonly pattern: RegExp;
  /** Why this report is expected: the cause outside Interborough, or the failure the test caused. */
  readonly reason: string;
};

export const ALLOWED_PAGE_ERRORS: readonly PageErrorAllowance[] = [];

/** Playwright's `errorText` for a request the page itself cancelled. */
const ABORTED_BY_THE_PAGE = 'net::ERR_ABORTED';

/** One line for a console error or a failed request, the way a person would read it. */
export function describePageError(
  report:
    | { readonly kind: 'console'; readonly text: string; readonly location: string }
    | {
        readonly kind: 'request';
        readonly method: string;
        readonly url: string;
        readonly error: string;
      },
): string {
  return report.kind === 'console'
    ? `console error: ${report.text} (${report.location})`
    : `request failed: ${report.method} ${report.url} (${report.error})`;
}

/**
 * What Chromium logs for a response whose status is an error, which is all it logs for one. A test
 * that answers a request with this status on purpose expects exactly this line.
 */
export function loggedFailedResponse(status: number, urlPattern: RegExp): RegExp {
  return new RegExp(
    `^console error: Failed to load resource: the server responded with a status of ${status} .*${urlPattern.source}`,
  );
}

/** What a page reported during one test, and which of it the test expects. */
export class PageErrorLog {
  readonly #reports: string[] = [];
  readonly #allowed: PageErrorAllowance[] = [...ALLOWED_PAGE_ERRORS];

  constructor(page: Page) {
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const { url, lineNumber } = message.location();
      this.#reports.push(
        describePageError({
          kind: 'console',
          text: message.text(),
          location: url === '' ? 'no source' : `${url}:${lineNumber}`,
        }),
      );
    });
    page.on('pageerror', (error) => {
      this.#reports.push(`uncaught exception: ${error.message}`);
    });
    page.on('requestfailed', (request) => {
      const error = request.failure()?.errorText ?? 'unknown';
      // An abort is the page cancelling a request it no longer wants (a query whose view was left,
      // a run the person stopped). Chromium does not log it, and it is how a stream is meant to end
      // (COR-1643), so it is not a failure. Every other way a request dies is.
      if (error === ABORTED_BY_THE_PAGE) return;
      this.#reports.push(
        describePageError({ kind: 'request', method: request.method(), url: request.url(), error }),
      );
    });
  }

  /** Declares a report this test causes on purpose, such as a request it answers with a 500. */
  expect(allowance: PageErrorAllowance): void {
    this.#allowed.push(allowance);
  }

  /** What the page reported that nothing allows. */
  unexpected(): string[] {
    return this.#reports.filter((line) => !this.#allowed.some((entry) => entry.pattern.test(line)));
  }
}

export const test = base.extend<{
  checkA11y: (screenLabel: string) => Promise<void>;
  pageErrors: PageErrorLog;
}>({
  checkA11y: async ({ page }, use) => {
    await use((screenLabel: string) => assertNoSeriousAxeViolations(page, screenLabel));
  },
  // Every test fails when its page reported an error: the suite used to pass over them.
  pageErrors: [
    async ({ page }, use) => {
      const log = new PageErrorLog(page);
      await use(log);
      expect(log.unexpected(), 'the page reported errors the test did not expect').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
