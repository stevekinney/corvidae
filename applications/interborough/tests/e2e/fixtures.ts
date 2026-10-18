/**
 * Playwright fixtures shared by every persona-flow spec (plan §11.4). The host serves one local
 * caller and asks for no sign-in, so the page needs no credential: the only fixture is the axe
 * gate, `checkA11y`.
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

export const test = base.extend<{ checkA11y: (screenLabel: string) => Promise<void> }>({
  checkA11y: async ({ page }, use) => {
    await use((screenLabel: string) => assertNoSeriousAxeViolations(page, screenLabel));
  },
});

export { expect };
