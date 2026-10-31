/**
 * Playwright fixtures shared by every persona-flow spec (plan §11.4). The host serves one local
 * caller and asks for no sign-in, so the page needs no credential. There are two fixtures: the axe
 * gate, `checkA11y`, and an automatic one that fails a test whose page logged a console error,
 * threw, or had a request fail, on any page of its context, unless `ALLOWED_PAGE_ERRORS` names it
 * or the test declared it.
 */
import PlaywrightAxeBuilder from '@axe-core/playwright';
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';

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
  /**
   * How many matching reports the declaration covers. A declaration made through
   * `pageErrors.expect(...)` covers one by default and fails the test if it covers fewer or more,
   * so a second failure the test did not mean to cause is not hidden by the first one's allowance.
   * Suite-wide entries cover every match.
   */
  readonly count?: number;
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

/**
 * Leaves the Bureau's event feed unanswered for the rest of the test. Once the page has loaded, the
 * feed's catch-up (`feed.resync`) asks every Bureau-driven list again, and every view probe still on
 * its first read (`app/bureau-event-queries.ts`). A test that counts the failures it causes would
 * count one more or not, by the order the network happens to answer in. A test about something other
 * than the feed holds it, and counts exactly.
 */
export async function holdBureauFeed(page: Page): Promise<void> {
  await page.route('**/bureau/v1/subscriptions/bureau.events**', () => {
    // Never answered: the feed stays connecting, so no catch-up arrives.
  });
}

/** A declaration the test made through `pageErrors.expect(...)`. */
type DeclaredAllowance = { readonly allowance: PageErrorAllowance };

/**
 * What every page of one browser context reported during one test, and which of it the test
 * expects. The context is the unit, not the default `page`: a test that opens a second tab
 * (`context.newPage()`) or a popup is held to the same bar.
 */
export class PageErrorLog {
  readonly #reports: string[] = [];
  readonly #standing: PageErrorAllowance[] = [...ALLOWED_PAGE_ERRORS];
  readonly #declared: DeclaredAllowance[] = [];
  readonly #watched = new WeakSet<Page>();

  constructor(context: BrowserContext) {
    for (const page of context.pages()) this.#watch(page);
    context.on('page', (page) => this.#watch(page));
  }

  #watch(page: Page): void {
    if (this.#watched.has(page)) return;
    this.#watched.add(page);
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

  /**
   * Declares a report this test causes on purpose, such as a request it answers with a 500. It
   * covers one matching report, or `allowance.count` of them.
   */
  expect(allowance: PageErrorAllowance): void {
    this.#declared.push({ allowance });
  }

  /**
   * Declares a report this test causes on purpose, however many times: every match is covered and
   * none is required. For a cause whose count follows the page's refetches (a mount, a reload, a
   * reconnect), where an exact count would only pin how often the page happens to ask. A test that
   * can name the count uses {@link expect}.
   */
  expectEvery(allowance: PageErrorAllowance): void {
    this.#standing.push(allowance);
  }

  /** Hands each report to the first declaration with room for it; what no one covers is left over. */
  #settle(): { unexpected: string[]; matched: number[] } {
    const matched = this.#declared.map(() => 0);
    const unexpected: string[] = [];
    for (const line of this.#reports) {
      if (this.#standing.some((entry) => entry.pattern.test(line))) continue;
      const index = this.#declared.findIndex(
        (entry, position) =>
          (matched[position] ?? 0) < (entry.allowance.count ?? 1) &&
          entry.allowance.pattern.test(line),
      );
      if (index < 0) unexpected.push(line);
      else matched[index] = (matched[index] ?? 0) + 1;
    }
    return { unexpected, matched };
  }

  /** What the pages reported that no standing entry and no declaration with room covers. */
  unexpected(): string[] {
    return this.#settle().unexpected;
  }

  /** The declarations that covered fewer reports than they said they would. */
  unused(): string[] {
    const { matched } = this.#settle();
    return this.#declared.flatMap((entry, position) => {
      const wanted = entry.allowance.count ?? 1;
      const seen = matched[position] ?? 0;
      return seen < wanted
        ? [
            `${entry.allowance.pattern} (${entry.allowance.reason}): expected ${wanted}, saw ${seen}`,
          ]
        : [];
    });
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
    // Built from the page's context, so the first page exists before the log listens and every
    // page the test opens later is watched too.
    async ({ page }, use) => {
      const log = new PageErrorLog(page.context());
      await use(log);
      expect(log.unexpected(), 'a page reported errors the test did not expect').toEqual([]);
      expect(log.unused(), 'the test declared reports its pages never made').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
