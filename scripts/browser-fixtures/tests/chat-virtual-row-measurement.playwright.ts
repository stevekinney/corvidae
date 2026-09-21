/**
 * Regression coverage for COR-190: the `content-visibility: visible`
 * overrides that scope real-height layout to virtualized rows —
 * `components/chat/src/lib/components/chat/message/chat-message.svelte`'s
 * `:global(.chat-virtual-row) .chat-message` rule, and
 * `chat-date-separator.svelte`'s `:global(.chat-virtual-row)
 * .chat-date-separator` counterpart.
 *
 * Outside a virtual row, `.chat-message`/`.chat-date-separator` use
 * `content-visibility: auto` with an intrinsic-size fallback, which is a
 * deliberate perf optimization for long non-virtualized transcripts. Inside a
 * `.chat-virtual-row`, mounted rows are already bound to the visible window
 * by the virtualizer, so they must lay out at their REAL height instead —
 * otherwise the virtualizer measures the 180px/48px fallback instead of the
 * row's actual content, and its cached offsets drift away from where rows
 * actually render.
 *
 * This suite exercises the shared Chat harness fixture (`private-harness`,
 * the same fixture `chat-harness.playwright.ts` uses) rather than a
 * dedicated exercise route: corvidae's `applications/chat-room` has no
 * `exercises/` routes, and the harness already ships a `#t-virtualized`
 * toggle plus a long, variable-height seeded transcript (`seed-long`) built
 * for exactly this kind of virtualization coverage.
 *
 * `openHarness` below is a trimmed duplicate of
 * `chat-harness.playwright.ts`'s own helper (same route, theme preset, and
 * readiness wait) rather than an import — that file exports nothing, is
 * intentionally left untouched here, and is being edited concurrently in
 * another session.
 */
import { THEME_STORAGE_KEY } from '@lostgradient/testing';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { fixtureRoute } from './overlay-fixture.ts';

const HARNESS = '[data-testid="chat-private-harness"]';

type ResizeObserverLoopWindow = Window & { __resizeObserverLoopErrors?: string[] };

/**
 * Opens /page/chat's private harness fixture. Installs a
 * `window.addEventListener('error', …)` init script that records only
 * messages containing "ResizeObserver loop" into a page-local array —
 * never calling `preventDefault`/`stopPropagation`, so the browser's own
 * handling of the error is unaffected — which `dispose` asserts is empty.
 * Virtualized remeasurement (a ResizeObserver on every mounted row) is
 * exactly the kind of resize-driven churn that error class comes from.
 */
async function openHarness(
  browser: Browser,
): Promise<{ page: Page; harness: Locator; dispose: () => Promise<void> }> {
  const context = await browser.newContext({
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    viewport: { width: 1280, height: 900 },
  });
  try {
    await context.addInitScript(
      ([key, value]) => {
        localStorage.setItem(key, value);
      },
      [THEME_STORAGE_KEY, 'dark'] as const,
    );
    await context.addInitScript(() => {
      const target = window as ResizeObserverLoopWindow;
      target.__resizeObserverLoopErrors = [];
      window.addEventListener('error', (event) => {
        if (typeof event.message === 'string' && event.message.includes('ResizeObserver loop')) {
          target.__resizeObserverLoopErrors?.push(event.message);
        }
      });
    });
    const page = await context.newPage();
    // snapshot mode (the fixtureRoute default) applies
    // `content-visibility: visible !important` to every element for
    // deterministic screenshots — that would blanket-override the exact CSS
    // this suite exists to test, so it is explicitly disabled here.
    // `reducedMotion: 'reduce'` above still suppresses the app's own
    // `@media (prefers-reduced-motion: reduce)`-gated animations.
    await page.goto(fixtureRoute('chat', { fixtureName: 'private-harness', snapshot: false }), {
      waitUntil: 'load',
    });
    await page.waitForSelector('#app > *', { state: 'visible', timeout: 20_000 });
    const harness = page.locator(HARNESS);
    await harness.waitFor({ state: 'visible', timeout: 20_000 });
    await expect
      .poll(() =>
        page.evaluate(() => ({
          theme: document.documentElement.dataset['theme'],
          cinderTheme: document.documentElement.dataset['cinderTheme'],
        })),
      )
      .toEqual({ theme: 'dark', cinderTheme: 'dark' });
    return {
      page,
      harness,
      async dispose() {
        try {
          const resizeObserverLoopErrors = await page.evaluate(
            () => (window as ResizeObserverLoopWindow).__resizeObserverLoopErrors ?? [],
          );
          expect(
            resizeObserverLoopErrors,
            'virtual row measurement must not emit ResizeObserver loop errors',
          ).toEqual([]);
        } finally {
          await context.close();
        }
      },
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}

/**
 * Waits a handful of animation frames so the virtualizer's
 * ResizeObserver-driven remeasurement (triggered by the scroll above) has
 * settled before geometry is read.
 */
async function waitForAnimationFrames(page: Page, frames = 8): Promise<void> {
  await page.evaluate(
    (frameCount) =>
      new Promise<void>((resolve) => {
        let remaining = frameCount;
        const tick = (): void => {
          remaining -= 1;
          if (remaining <= 0) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    frames,
  );
}

type VirtualRowMeasurement = { index: number; height: number; translateY: number };

/**
 * Reads every currently-mounted `.chat-virtual-row`'s index, real rendered
 * height (`getBoundingClientRect().height`, box-sizing: border-box so this
 * already includes the row's own padding), and computed `translateY` (from
 * `virtualizedRowStyle`'s `transform: translateY(virtualItem.start)`),
 * sorted by index.
 */
async function measureVirtualRows(timeline: Locator): Promise<VirtualRowMeasurement[]> {
  return timeline.locator('.chat-virtual-row').evaluateAll((elements) =>
    elements
      .map((element) => {
        const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
        return {
          index: Number(element.getAttribute('data-cinder-virtual-index')),
          height: element.getBoundingClientRect().height,
          translateY: matrix.m42,
        };
      })
      .toSorted((a, b) => a.index - b.index),
  );
}

test.describe('chat virtual row measurement — content-visibility scoping', () => {
  test('a virtualized row forces content-visibility: visible for its message and date separator', async ({
    browser,
  }) => {
    const { harness, dispose } = await openHarness(browser);
    try {
      await harness.locator('[data-testid="seed-thread"]').click();
      await harness.locator('#t-virtualized').click();

      const timeline = harness.locator('.chat-timeline');
      // Seed before enabling virtualization so this CSS-scoping test does not
      // also exercise transcript-growth auto-stick-to-bottom. Keep a direct
      // scrollTop assertion anyway: the row window must be parked at the top
      // without using scrollToTop(), because that imperative API sets
      // `data-cinder-force-visible` and would globally force
      // content-visibility: visible, masking the `.chat-virtual-row` rule this
      // test isolates.
      await timeline.evaluate((element) => {
        element.scrollTop = 0;
      });
      await expect
        .poll(async () => timeline.evaluate((element) => element.scrollTop), { timeout: 10_000 })
        .toBe(0);
      await expect(timeline).not.toHaveAttribute('data-cinder-force-visible');

      const virtualMessage = timeline.locator('.chat-virtual-row .chat-message').first();
      const virtualSeparator = timeline.locator('.chat-virtual-row .chat-date-separator').first();
      await expect(virtualMessage).toBeVisible();
      await expect(virtualSeparator).toBeVisible();

      await expect(virtualMessage).toHaveCSS('content-visibility', 'visible');
      await expect(virtualSeparator).toHaveCSS('content-visibility', 'visible');
    } finally {
      await dispose();
    }
  });

  test('a non-virtualized row keeps the default content-visibility: auto (control)', async ({
    browser,
  }) => {
    const { harness, dispose } = await openHarness(browser);
    try {
      await harness.locator('[data-testid="seed-thread"]').click();

      const timeline = harness.locator('.chat-timeline');
      // Virtualization was never toggled on, so nothing here is wrapped in a
      // `.chat-virtual-row` — this is the scoping rule's control case.
      await expect(timeline.locator('.chat-virtual-row')).toHaveCount(0);
      // The rule under test is scoped to virtual rows, not forced globally —
      // but that is only true while the escape hatch for a programmatic
      // scroll-to-bottom/-top (`data-cinder-force-visible`, which forces
      // EVERY row visible regardless of `.chat-virtual-row`) is inactive.
      // This test never calls scrollToTop()/scrollToBottom(), so assert that
      // control explicitly instead of assuming it.
      await expect(timeline).not.toHaveAttribute('data-cinder-force-visible');

      const message = timeline.locator('.chat-message').first();
      const separator = timeline.locator('.chat-date-separator').first();
      await expect(message).toBeVisible();
      await expect(separator).toBeVisible();

      await expect(message).toHaveCSS('content-visibility', 'auto');
      await expect(separator).toHaveCSS('content-visibility', 'auto');
    } finally {
      await dispose();
    }
  });
});

test.describe('chat virtual row measurement — geometry', () => {
  test("adjacent virtual rows are offset by exactly the previous row's real rendered height", async ({
    browser,
  }) => {
    const { page, harness, dispose } = await openHarness(browser);
    try {
      await harness.locator('#t-virtualized').click();
      await harness.locator('[data-testid="seed-long"]').click();

      const timeline = harness.locator('.chat-timeline');
      // The long, variable-height transcript (`seed-long`) is exactly the
      // fixture built for this: message lengths vary enough that real row
      // heights diverge from the virtualizer's estimate. It starts pinned to
      // the bottom with a mounted window of several rows already in the
      // DOM — no scrolling needed; this test only needs any two adjacent
      // mounted rows, not specifically the top of the list. (A scroll here
      // would also route through the app's auto-stick-to-bottom effect,
      // which treats a raw `scrollTop` assignment on this long a virtualized
      // list as unintentional and corrects it back — not something this
      // measurement needs to fight.)
      await expect(timeline.getByText('Answer 150:').first()).toBeVisible({ timeout: 10_000 });
      await expect(timeline).not.toHaveAttribute('data-cinder-force-visible');
      await waitForAnimationFrames(page);

      const rows = await measureVirtualRows(timeline);
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const row of rows) {
        expect(row.height, `row ${row.index} must have a positive measured height`).toBeGreaterThan(
          0,
        );
      }

      const consecutivePairs = rows
        .map((row, position) => ({ row, next: rows[position + 1] }))
        .filter(
          (pair): pair is { row: VirtualRowMeasurement; next: VirtualRowMeasurement } =>
            pair.next !== undefined && pair.next.index === pair.row.index + 1,
        );
      expect(
        consecutivePairs.length,
        'must find at least one pair of consecutive mounted virtual rows',
      ).toBeGreaterThanOrEqual(1);

      for (const { row, next } of consecutivePairs) {
        expect(
          Math.round(next.translateY - row.translateY),
          `row ${row.index} -> ${next.index}: offset must equal row ${row.index}'s real rendered height, not an intrinsic fallback`,
        ).toBe(Math.ceil(row.height));
      }
    } finally {
      await dispose();
    }
  });
});
