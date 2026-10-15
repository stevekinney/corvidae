import type { Page } from '@playwright/test';

import { loadManifest, runAxe, type AxeBuckets } from '@lostgradient/testing';
import { expect, test } from './component-page-fixture.ts';

const entriesBySlug = new Map(loadManifest().map((entry) => [entry.slug, entry] as const));
const desktopViewport = { name: 'desktop', width: 1280, height: 900 } as const;
const lightTheme = 'light' as const;

function getEntry(slug: string) {
  const entry = entriesBySlug.get(slug);
  if (!entry) throw new Error(`Component manifest is missing slug: ${slug}`);
  return entry;
}

function axeViolations(buckets: AxeBuckets): unknown[] {
  return Object.values(buckets).flat();
}

function renderedIndices(page: Page, mountSelector: string): Promise<number[]> {
  return page
    .locator(`${mountSelector} [data-cinder-virtual-index]`)
    .evaluateAll((nodes) =>
      nodes.map((node) => Number(node.getAttribute('data-cinder-virtual-index'))),
    );
}

test.describe('Virtualized list examples', () => {
  test('virtual-list keeps the 10k-row example windowed and axe-clean', async ({
    componentPage,
  }) => {
    const page = await componentPage.open({
      entry: getEntry('virtual-list'),
      theme: lightTheme,
      viewport: desktopViewport,
      fixtureName: 'assertion',
    });
    const mountSelector = '#example-mount-ten-thousand';
    const list = page.locator(`${mountSelector} .cinder-virtual-list`);
    const rows = page.locator(`${mountSelector} [data-cinder-virtual-index]`);

    await expect(list).toBeVisible();
    await expect.poll(() => rows.count()).toBeGreaterThan(0);
    await expect.poll(() => rows.count()).toBeLessThan(40);

    const buckets = await runAxe(
      page,
      {
        slug: 'virtual-list',
        theme: lightTheme,
        viewport: desktopViewport.name,
        fixture: 'ten-thousand',
      },
      { include: mountSelector },
    );
    expect(axeViolations(buckets)).toEqual([]);
  });

  test('data-table virtualized example keeps native table semantics and is axe-clean', async ({
    componentPage,
  }) => {
    const page = await componentPage.open({
      entry: getEntry('data-table'),
      theme: lightTheme,
      viewport: desktopViewport,
      fixtureName: 'assertion',
    });
    const mountSelector = '#example-mount-virtualized';
    const table = page.locator(`${mountSelector} table`);
    const bodyRows = page.locator(`${mountSelector} tbody tr:not([aria-hidden="true"])`);

    await expect(table).toBeVisible();
    await expect(table).toHaveAttribute('aria-rowcount', '10001');
    await expect(page.locator(`${mountSelector} thead th[scope="col"]`)).toHaveCount(4);
    await expect.poll(() => bodyRows.count()).toBeGreaterThan(0);
    await expect.poll(() => bodyRows.count()).toBeLessThan(40);

    const buckets = await runAxe(
      page,
      {
        slug: 'data-table',
        theme: lightTheme,
        viewport: desktopViewport.name,
        fixture: 'virtualized',
      },
      { include: mountSelector },
    );
    expect(axeViolations(buckets)).toEqual([]);
  });
});

/**
 * Horizontal and right-to-left windowing.
 *
 * These live here rather than in the component's unit tests because happy-dom has
 * no layout: `scrollWidth`/`clientWidth` are zero, `getComputedStyle().direction`
 * is always `'ltr'`, and the RTL `scrollLeft` conventions cannot be reproduced at
 * all. The inline axis is only observable in a real engine.
 */
test.describe('Virtual list - horizontal and RTL', () => {
  const columnWidth = 160;

  test('horizontal example scrolls the inline axis and windows from scrollLeft', async ({
    componentPage,
  }) => {
    const page = await componentPage.open({
      entry: getEntry('virtual-list'),
      theme: lightTheme,
      viewport: desktopViewport,
      fixtureName: 'assertion',
    });
    const mountSelector = '#example-mount-horizontal';
    const list = page.locator(`${mountSelector} .cinder-virtual-list`);

    await expect(list).toBeVisible();
    await expect(list).toHaveAttribute('data-cinder-orientation', 'horizontal');
    await expect
      .poll(async () => {
        const indices = await renderedIndices(page, mountSelector);
        return indices.length;
      })
      .toBeGreaterThan(0);

    // The container overflows along the inline axis and NOT the block axis. That is
    // what the orientation CSS is for; if the block axis overflowed instead, the
    // component would be windowing a dimension the user cannot scroll.
    const overflow = await list.evaluate((element) => ({
      inline: element.scrollWidth - element.clientWidth,
      block: element.scrollHeight - element.clientHeight,
    }));
    expect(overflow.inline).toBeGreaterThan(1_000);
    expect(overflow.block).toBeLessThanOrEqual(1);

    // Rows advance along the inline axis, so consecutive rows differ in x, not y.
    const firstTwo = await page
      .locator(`${mountSelector} [data-cinder-virtual-index]`)
      .evaluateAll((nodes) =>
        nodes.slice(0, 2).map((node) => {
          const rect = node.getBoundingClientRect();
          return { x: rect.x, y: rect.y };
        }),
      );
    expect(Math.abs(firstTwo[1]!.y - firstTwo[0]!.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(firstTwo[1]!.x - firstTwo[0]!.x)).toBeGreaterThan(columnWidth / 2);

    // The viewport extent must be measured along the INLINE axis. The container's
    // block-size is `auto` under `horizontal`, so it collapses to roughly one row's
    // height — measuring that instead would under-report the viewport and render
    // too few columns to fill it, blanking the trailing edge on a fast scroll.
    const visibleColumns = await list.evaluate(
      (element, width) => Math.ceil(element.clientWidth / width),
      columnWidth,
    );
    expect(visibleColumns).toBeGreaterThan(1);
    await expect
      .poll(async () => {
        const indices = await renderedIndices(page, mountSelector);
        return indices.length;
      })
      .toBeGreaterThanOrEqual(visibleColumns);

    await list.evaluate((element, offset) => {
      element.scrollLeft = offset;
    }, columnWidth * 40);

    await expect.poll(() => renderedIndices(page, mountSelector)).toContain(40);
    expect(await renderedIndices(page, mountSelector)).not.toContain(0);
  });

  test('rtl example reads its scroll offset from the right edge', async ({ componentPage }) => {
    const page = await componentPage.open({
      entry: getEntry('virtual-list'),
      theme: lightTheme,
      viewport: desktopViewport,
      fixtureName: 'assertion',
    });
    const mountSelector = '#example-mount-horizontal-rtl';
    const list = page.locator(`${mountSelector} .cinder-virtual-list`);

    await expect(list).toBeVisible();
    await expect
      .poll(async () => {
        const indices = await renderedIndices(page, mountSelector);
        return indices.length;
      })
      .toBeGreaterThan(0);
    expect(await list.evaluate((element) => getComputedStyle(element).direction)).toBe('rtl');

    // At rest the list sits at its start edge, which in RTL is the RIGHT edge: index 0
    // is against the container's right side, not its left.
    const atRest = await list.evaluate((element) => {
      const container = element.getBoundingClientRect();
      const first = element.querySelector('[data-cinder-virtual-index="0"]');
      if (!first) return null;
      const row = first.getBoundingClientRect();
      return { fromRight: container.right - row.right, fromLeft: row.left - container.left };
    });
    expect(atRest).not.toBeNull();
    expect(Math.abs(atRest!.fromRight)).toBeLessThanOrEqual(2);
    expect(atRest!.fromLeft).toBeGreaterThan(columnWidth);

    // Derive the browser's RTL scrollLeft convention HERE, independently of the
    // component's own probe, then drive the scroll through it. If the component
    // detected a different convention than the browser actually implements, the raw
    // value below still lands 40 columns from the start edge while the component
    // reads some other offset - and this fails. Pinning a convention by name instead
    // of detecting it is exactly the regression this guards.
    const convention = await list.evaluate((element) => {
      const start = element.scrollLeft;
      element.scrollLeft = -1;
      const afterNegative = element.scrollLeft;
      element.scrollLeft = start;
      if (start > 0) return 'reverse';
      return afterNegative < 0 ? 'negative' : 'default';
    });

    await list.evaluate(
      (element, { offset, mode }) => {
        const max = element.scrollWidth - element.clientWidth;
        element.scrollLeft =
          mode === 'negative' ? -offset : mode === 'reverse' ? max - offset : offset;
      },
      { offset: columnWidth * 40, mode: convention },
    );

    await expect.poll(() => renderedIndices(page, mountSelector)).toContain(40);
    expect(await renderedIndices(page, mountSelector)).not.toContain(0);
  });

  test('rtl example is axe-clean', async ({ componentPage }) => {
    const page = await componentPage.open({
      entry: getEntry('virtual-list'),
      theme: lightTheme,
      viewport: desktopViewport,
      fixtureName: 'assertion',
    });
    const mountSelector = '#example-mount-horizontal-rtl';
    await expect(page.locator(`${mountSelector} .cinder-virtual-list`)).toBeVisible();

    const buckets = await runAxe(
      page,
      {
        slug: 'virtual-list',
        theme: lightTheme,
        viewport: desktopViewport.name,
        fixture: 'horizontal-rtl',
      },
      { include: mountSelector },
    );
    expect(axeViolations(buckets)).toEqual([]);
  });
});

/**
 * COR-376: adaptiveOverscan under real scroll velocity.
 *
 * These live here rather than in the component's unit tests because events fired
 * from `@testing-library/svelte` share a timestamp, so the velocity tracker always
 * reads zero and adaptation never engages — see the "Structural" comments this
 * ticket removed from `virtual-list-adaptive-overscan-and-settling-under-row-
 * controls.test.ts` and `virtual-list-edge-callbacks-under-adaptive-overscan.test.ts`.
 * A real browser gives real timestamps.
 *
 * The `adaptive-overscan` example (fixed-height rows, `itemHeight={120}`,
 * `overscan={5}`) drives the first three assertions below — growth, settling back
 * to the floor, and `onEndReached`'s edge distance. The fourth, distinguishing a
 * MEASURED row size from the `itemHeight` estimate, needs `dynamicSize` with the
 * two deliberately far apart, which is exactly what the `adaptive-overscan-
 * dynamic-size` fixture-only route (not one of the component's public examples)
 * is for.
 */
test.describe('Virtual list - adaptive overscan under scroll velocity', () => {
  const ADAPTIVE_MOUNT = '#adaptive-overscan-example';
  const ADAPTIVE_LIST = `${ADAPTIVE_MOUNT} .cinder-virtual-list`;
  const ADAPTIVE_STATUS = `${ADAPTIVE_MOUNT} [data-testid="adaptive-overscan-status"]`;
  const ADAPTIVE_ROW_COUNT = 5_000;
  const ADAPTIVE_CONFIGURED_OVERSCAN = 5;

  type ScrollDriveSample = {
    scrollTop: number;
    renderedCount: number;
    endReachedCount: number;
    endReachedVisibleEndIndex: number;
  };

  /**
   * Drives real, browser-timestamped scroll events entirely INSIDE the page: each
   * iteration bumps `scrollTop` by `jumpPx` and awaits one animation frame, so the
   * elapsed time between samples is the browser's own frame cadence rather than a
   * Node<->browser round trip that could occasionally exceed the velocity tracker's
   * idle-reset window and read as a dropped gesture instead of a continuous fast
   * scroll. Returns one sample per frame so the test asserts on the whole trace —
   * including everything BEFORE `onEndReached` first fires — rather than racing a
   * single, separately-timed read.
   */
  async function driveAdaptiveScroll(
    page: Page,
    options: { startScrollTop?: number; jumpPx: number; frames: number },
  ): Promise<ScrollDriveSample[]> {
    return page.evaluate(
      ({ listSelector, statusSelector, startScrollTop, jumpPx, frames }) =>
        new Promise<ScrollDriveSample[]>((resolve, reject) => {
          const list = document.querySelector(listSelector);
          const status = document.querySelector(statusSelector);
          if (!(list instanceof HTMLElement) || !(status instanceof HTMLElement)) {
            reject(new Error('adaptive-overscan fixture not ready'));
            return;
          }
          if (startScrollTop !== undefined) list.scrollTop = startScrollTop;
          const samples: ScrollDriveSample[] = [];
          let frame = 0;
          const step = (): void => {
            if (frame >= frames) {
              resolve(samples);
              return;
            }
            list.scrollTop += jumpPx;
            frame += 1;
            requestAnimationFrame(() => {
              samples.push({
                scrollTop: list.scrollTop,
                renderedCount: list.querySelectorAll('[data-cinder-virtual-index]').length,
                endReachedCount: Number(status.dataset['endReachedCount']),
                endReachedVisibleEndIndex: Number(status.dataset['endReachedVisibleEndIndex']),
              });
              step();
            });
          };
          step();
        }),
      { listSelector: ADAPTIVE_LIST, statusSelector: ADAPTIVE_STATUS, ...options },
    );
  }

  async function openAdaptiveOverscanPage(page: Page): Promise<void> {
    const list = page.locator(ADAPTIVE_LIST);
    await expect(list).toBeVisible();
    await expect
      .poll(() => renderedIndices(page, ADAPTIVE_MOUNT).then((indices) => indices.length))
      .toBeGreaterThan(0);
  }

  test('renders more rows the faster the reader scrolls', async ({ componentPage }) => {
    const page = await componentPage.open({
      entry: getEntry('virtual-list'),
      theme: lightTheme,
      viewport: desktopViewport,
      fixtureName: 'assertion',
    });
    await openAdaptiveOverscanPage(page);
    const restingIndices = await renderedIndices(page, ADAPTIVE_MOUNT);
    const restingCount = restingIndices.length;

    const samples = await driveAdaptiveScroll(page, {
      startScrollTop: 200_000,
      jumpPx: 2_000,
      frames: 20,
    });
    const peakRenderedCount = Math.max(...samples.map((sample) => sample.renderedCount));

    // Comfortably past the configured floor (resolvedOverscan=5 on each side of a
    // ~400px viewport over 120px rows) — adaptive overscan actually engaged.
    expect(peakRenderedCount, `resting ${restingCount}, peak ${peakRenderedCount}`).toBeGreaterThan(
      restingCount + 10,
    );
  });

  test('settles back to the configured floor once the reader stops', async ({ componentPage }) => {
    const page = await componentPage.open({
      entry: getEntry('virtual-list'),
      theme: lightTheme,
      viewport: desktopViewport,
      fixtureName: 'assertion',
    });
    await openAdaptiveOverscanPage(page);
    const restingIndices = await renderedIndices(page, ADAPTIVE_MOUNT);
    const restingCount = restingIndices.length;

    const samples = await driveAdaptiveScroll(page, {
      startScrollTop: 200_000,
      jumpPx: 2_000,
      frames: 20,
    });
    const grownCount = Math.max(...samples.map((sample) => sample.renderedCount));
    expect(grownCount, `resting ${restingCount}, grown ${grownCount}`).toBeGreaterThan(
      restingCount + 10,
    );

    // No further scrollTop writes after the drive above ends. The idle timer
    // (200ms with no new sample) resets the tracked velocity, and the next
    // render should fall back to exactly the configured floor. Generous timeout
    // and a small tolerance band, per the "design for margins" note on this
    // ticket — this must not be timing-flaky.
    await expect
      .poll(() => renderedIndices(page, ADAPTIVE_MOUNT).then((indices) => indices.length), {
        timeout: 3_000,
      })
      .toBeLessThanOrEqual(restingCount + 2);
  });

  test('onEndReached fires within the CONFIGURED overscan of the end, not the wider effective one', async ({
    componentPage,
  }) => {
    const page = await componentPage.open({
      entry: getEntry('virtual-list'),
      theme: lightTheme,
      viewport: desktopViewport,
      fixtureName: 'assertion',
    });
    await openAdaptiveOverscanPage(page);
    const list = page.locator(ADAPTIVE_LIST);

    // Starts far enough from the end that the velocity tracker has plenty of
    // samples to ramp up on before arriving there — the old bug's effect scales
    // with how far the effective overscan has grown past the configured one, so
    // it only shows up clearly once adaptive overscan has actually widened.
    const maxScrollTop = await list.evaluate(
      (element) => element.scrollHeight - element.clientHeight,
    );
    const startScrollTop = Math.max(0, maxScrollTop - 200_000);

    const samples = await driveAdaptiveScroll(page, {
      startScrollTop,
      jumpPx: 4_000,
      frames: 55,
    });

    const firstFiredIndex = samples.findIndex((sample) => sample.endReachedCount > 0);
    expect(
      firstFiredIndex,
      'onEndReached never fired while scrolling to the end',
    ).toBeGreaterThanOrEqual(0);

    // Nothing before it fired reported a call — it did not fire early.
    for (const sample of samples.slice(0, firstFiredIndex)) {
      expect(sample.endReachedCount).toBe(0);
    }

    // And where it DID fire is close to the true end. The old bug (subtracting
    // the CONFIGURED overscan from a window widened by the EFFECTIVE one) fires
    // as many rows early as the effective overscan has grown past the
    // configured one — reverting it at this drive's velocity fires ~33 rows
    // early (effective overscan reaches roughly 36 each side). A 30-row budget
    // — six times the configured overscan of 5 — comfortably covers a frame's
    // worth of jump overshoot (~33 rows per 4,000px frame at this list's 120px
    // rows) while catching that regression with margin to spare.
    const fired = samples[firstFiredIndex]!;
    const rowsFromEnd = ADAPTIVE_ROW_COUNT - 1 - fired.endReachedVisibleEndIndex;
    expect(rowsFromEnd, JSON.stringify(fired)).toBeGreaterThanOrEqual(0);
    expect(rowsFromEnd, JSON.stringify(fired)).toBeLessThanOrEqual(
      ADAPTIVE_CONFIGURED_OVERSCAN + 25,
    );
  });

  test("converts scroll velocity with the row's MEASURED size under dynamicSize, not the itemHeight estimate", async ({
    componentPage,
  }) => {
    const page = await componentPage.open({
      entry: getEntry('virtual-list'),
      theme: lightTheme,
      viewport: desktopViewport,
      fixtureName: 'assertion',
    });
    const mountSelector = '#adaptive-overscan-dynamic-size-example';
    const listSelector = `${mountSelector} .cinder-virtual-list`;
    const list = page.locator(listSelector);
    await expect(list).toBeVisible();
    await expect
      .poll(() => renderedIndices(page, mountSelector).then((indices) => indices.length))
      .toBeGreaterThan(0);

    // `itemHeight={5}` against rows that measure a fixed 90px once mounted (18x
    // apart) — dividing a given pixel distance by 5 instead of 90 asks for
    // roughly 18x as many rows. Primed first (a full, slow top-to-bottom
    // traversal) so every row's real 90px size is already cached before the
    // timed drive below: the conversion is supposed to use that measured
    // average once one exists, not the estimate, and the timed drive needs a
    // clean read on THAT, not on corrections still settling from first-time
    // measurements.
    const peakRenderedCount = await list.evaluate(async (element) => {
      let top = 0;
      for (;;) {
        element.scrollTop = top;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const currentMax = element.scrollHeight - element.clientHeight;
        if (top >= currentMax) break;
        top = Math.min(currentMax, top + 200);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));

      let peak = 0;
      for (let frame = 0; frame < 15; frame += 1) {
        element.scrollTop = Math.max(0, element.scrollTop - 500);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        peak = Math.max(peak, element.querySelectorAll('[data-cinder-virtual-index]').length);
      }
      return peak;
    });

    // Grew past the configured floor (resolvedOverscan=3 on each side of a
    // ~300px/90px viewport) — adaptive overscan actually engaged during the
    // primed backward drive.
    expect(peakRenderedCount).toBeGreaterThan(20);
    // ...but nowhere near what dividing by the 5px itemHeight ESTIMATE would
    // give at this same velocity: roughly 18x more rows of overscan than
    // dividing by the row's real 90px measured size, which saturates the
    // default 50-row ceiling on each side (~104 rendered rows total) well
    // before the correct conversion does. 60 sits with wide margin below that
    // and above every peak this correct conversion produced across repeated
    // manual runs (27-53).
    expect(peakRenderedCount).toBeLessThan(60);
  });
});

/**
 * COR-376: a pinned horizontal sticky row keeps its own height.
 *
 * `horizontal-sticky-header-clip` (fixture-only route, not one of the component's
 * public examples) is a wider-spaced variant of `horizontal-sticky-headers`: its
 * header, at 96px, is taller than its 64px neighbours exactly like that example's,
 * but its groupSize (40 instead of 10) is wider than the rendered window (viewport
 * + overscan on each side spans roughly 14-16 columns). `horizontal-sticky-headers`
 * itself can't isolate this regression — its headers are close enough together that
 * a second, equally tall header is always ALSO in flow near any pinned one, which
 * stretches the window's auto cross-size to the right height by coincidence and
 * masks the bug whether or not the fix is present.
 *
 * Once a header pins it leaves flow (`position: absolute`), and without feeding its
 * measured cross-axis extent back onto the in-flow window, the window's auto
 * block-size is computed only from the shorter in-flow columns and the root's
 * `overflow-y: hidden` clips the header's bottom edge. This asserts the pinned
 * header's full box stays inside the list's own box, which happy-dom cannot compute
 * at all: it has no layout, so `position: sticky`/`absolute` and `overflow` never
 * resolve there.
 */
test.describe('Virtual list - pinned horizontal sticky header stays unclipped', () => {
  const mountSelector = '#example-mount-horizontal-sticky-header-clip';
  const columnWidth = 120;

  test('the pinned header is not clipped by the list once it crosses the window boundary', async ({
    componentPage,
  }) => {
    const page = await componentPage.open({
      entry: getEntry('virtual-list'),
      theme: lightTheme,
      viewport: desktopViewport,
      fixtureName: 'assertion',
    });
    const list = page.locator(`${mountSelector} .cinder-virtual-list`);
    await expect(list).toBeVisible();

    // Group 1 (header at index 40), scrolled 8 columns past its own start —
    // past the default overscan (5), so header 40's own index has left the
    // rendered window and it is truly PINNED (out of flow), not just held in
    // place while still inside it — and the NEXT header (80) is far outside
    // the rendered window too, so it is the only tall row anywhere nearby.
    const targetColumn = 48;
    await list.evaluate((element, offset) => {
      element.scrollLeft = offset;
    }, columnWidth * targetColumn);
    await expect
      .poll(() => list.evaluate((element) => Math.round(element.scrollLeft)))
      .toBe(columnWidth * targetColumn);

    const header = page.locator(`${mountSelector} [data-cinder-virtual-index="40"]`);
    await expect(header).toBeVisible();
    await expect(header).toHaveAttribute('data-cinder-sticky-pinned', 'true');

    const listBox = await list.boundingBox();
    const headerBox = await header.boundingBox();
    if (listBox === null || headerBox === null) throw new Error('Missing bounding box.');

    // The header's own full height, not squashed to its shorter neighbours' 64px.
    expect(Math.round(headerBox.height)).toBe(96);
    // And entirely WITHIN the list's own box — a header clipped by overflow still
    // reports its full (unclipped) layout box from getBoundingClientRect, so this
    // is the assertion the CSS-only structural test could not make: both edges
    // fall inside the list's box, which only holds if the list actually grew to
    // make room rather than merely refraining from squashing the row. Playwright's
    // `boundingBox()` returns `{x, y, width, height}`, not a DOMRect, so the edges
    // are derived rather than read directly.
    expect(headerBox.y).toBeGreaterThanOrEqual(listBox.y - 1);
    expect(headerBox.y + headerBox.height).toBeLessThanOrEqual(listBox.y + listBox.height + 1);
  });
});

/**
 * COR-374: coalesces held keyboard navigation during a smooth scroll.
 *
 * With `stickyItems` and `smoothScroll` both set, each keypress used to
 * resolve its destination from the live scroll position, which lags a
 * running `scrollTo({ behavior: 'smooth' })` animation — a second press
 * arriving before the first had visibly moved read the same leading row,
 * resolved the same destination, and superseded the running animation
 * outright. N held presses could advance as few as one row.
 *
 * This needs a real browser: the bug only exists once an actual smooth-scroll
 * animation is in flight, which happy-dom cannot reproduce (its own
 * `Element.scroll` applies a `behavior: 'smooth'` write on a deferred timer
 * rather than animating it — see the component's unit tests, which exploit
 * exactly that gap for the invalidation cases that DON'T need real motion).
 */
test.describe('Virtual list - COR-374 coalesces held keyboard navigation during a smooth scroll', () => {
  const mountSelector = '#example-mount-sticky-headers-smooth-scroll';
  // The fixture's rows and its one 40px header sharing the same height, so a
  // coalesced step is exactly one `itemHeight` regardless of which row it
  // starts from.
  const itemHeight = 40;

  test('N rapid ArrowDown presses advance N rows, not fewer', async ({ componentPage }) => {
    const page = await componentPage.open({
      entry: getEntry('virtual-list'),
      theme: lightTheme,
      viewport: desktopViewport,
      fixtureName: 'assertion',
    });
    const list = page.locator(`${mountSelector} .cinder-virtual-list`);
    await expect(list).toBeVisible();
    await expect
      .poll(() => renderedIndices(page, mountSelector).then((indices) => indices.length))
      .toBeGreaterThan(0);

    // Starts unscrolled, with the sticky header over the leading edge — a
    // known, deterministic starting row rather than one this test would have
    // to re-derive from measured geometry.
    expect(await list.evaluate((element) => element.scrollTop)).toBe(0);
    await list.focus();

    const presses = 10;
    for (let index = 0; index < presses; index += 1) {
      await page.keyboard.press('ArrowDown');
      // Real, short intervals — fast enough that a smooth-scroll animation
      // from an earlier press is very likely still running when a later one
      // lands, which is the exact condition this coalescing exists for.
      // Slower than this and every press would already see the previous
      // one's settled position, a real repro but not one that reliably
      // exercises the in-flight case at all.
      await page.waitForTimeout(40);
    }

    // The final, settled position — never anything read mid-animation, so
    // this carries no timing sensitivity of its own. One `itemHeight` per
    // press, with a generous poll window per this ticket's "design with
    // margins" note; none of the rows crossed are sticky (the next header
    // is far past row `presses`), so no header-skip arithmetic complicates
    // the expected value.
    await expect
      .poll(async () => list.evaluate((element) => element.scrollTop), { timeout: 3_000 })
      .toBe(presses * itemHeight);

    // And steady — not a snapshot mid-way through a correction that would
    // have drifted the value a moment later.
    await page.waitForTimeout(250);
    expect(await list.evaluate((element) => element.scrollTop)).toBe(presses * itemHeight);
  });

  test('a slower, deliberate press-by-press sequence still advances one row at a time', async ({
    componentPage,
  }) => {
    // The non-adversarial control: pressing well past every animation's own
    // settle time must keep behaving exactly as it always has. Coalescing
    // must never change the OUTCOME of navigation that was never actually
    // interrupted — only how it survives being interrupted.
    const page = await componentPage.open({
      entry: getEntry('virtual-list'),
      theme: lightTheme,
      viewport: desktopViewport,
      fixtureName: 'assertion',
    });
    const list = page.locator(`${mountSelector} .cinder-virtual-list`);
    await expect(list).toBeVisible();
    await expect
      .poll(() => renderedIndices(page, mountSelector).then((indices) => indices.length))
      .toBeGreaterThan(0);

    await list.focus();

    for (let index = 0; index < 3; index += 1) {
      await page.keyboard.press('ArrowDown');
      await expect
        .poll(async () => list.evaluate((element) => element.scrollTop), { timeout: 3_000 })
        .toBe((index + 1) * itemHeight);
      await page.waitForTimeout(150);
    }
  });
});

test.describe('Virtual list - COR-1523 window-scrolled sticky headers keep keyboard steps', () => {
  // The page scrolls here, not the list. The active header leaves flow when it pins
  // as its index leaves the rendered window, and the page's native scroll anchoring
  // then pulled the page back a row, undoing a keyboard step that nothing in the
  // list re-issues any more. The shift came from the window's inset landing a frame
  // late under reduced motion (COR-1535); with that gone the page keeps its
  // anchoring, which this list leaves on.
  const mountSelector = '#example-mount-sticky-headers-window-scroll';
  const itemHeight = 40;

  test('N rapid ArrowDown presses advance N rows through a header pinning', async ({
    componentPage,
  }) => {
    const page = await componentPage.open({
      entry: getEntry('virtual-list'),
      theme: lightTheme,
      viewport: desktopViewport,
      fixtureName: 'assertion',
    });
    const list = page.locator(`${mountSelector} .cinder-virtual-list`);
    await list.scrollIntoViewIfNeeded();
    const listTop = await list.evaluate(
      (element) => element.getBoundingClientRect().top + window.scrollY,
    );
    await page.evaluate((top) => window.scrollTo(0, top), listTop);
    // Header 0 sits at the leading edge with row 1 just below it.
    // Compared rounded on both sides: the list can start on a fractional pixel.
    await expect
      .poll(() => page.evaluate(() => Math.round(window.scrollY)))
      .toBe(Math.round(listTop));
    await expect
      .poll(() => renderedIndices(page, mountSelector).then((indices) => indices.includes(1)))
      .toBe(true);
    await list.evaluate((element) => element.focus({ preventScroll: true }));
    // The page's anchoring is on, so a shift as the header pins would show here.
    expect(await list.evaluate((element) => getComputedStyle(element).overflowAnchor)).toBe('auto');

    const presses = 10;
    for (let index = 0; index < presses; index += 1) {
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(40);
    }

    // Row 11 under the 40px header, past the point where header 0 has pinned.
    await expect
      .poll(() => page.evaluate(() => Math.round(window.scrollY)), { timeout: 3_000 })
      .toBe(Math.round(listTop + presses * itemHeight));
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(
      Math.round(listTop + presses * itemHeight),
    );
  });
});

test.describe('Virtual list - COR-1535 geometry applies in the frame it is written', () => {
  // Reduced motion (which `themeContextOptions` emulates) sets every element's
  // `transition-duration` to 0.01ms while `transition-property` stays `all`, so an
  // element that declared no transition at all animates every property change. Its
  // computed value then holds the old one until the next frame. The window's inset
  // lagging a frame behind a sticky row that had already left flow is the shift that
  // page anchoring corrected in COR-1523.
  const mountSelector = '#example-mount-sticky-headers-window-scroll';

  test('the window, pinned row and spacer take their inline geometry at once', async ({
    componentPage,
  }) => {
    const page = await componentPage.open({
      entry: getEntry('virtual-list'),
      theme: lightTheme,
      viewport: desktopViewport,
      fixtureName: 'assertion',
    });
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
      true,
    );
    const list = page.locator(`${mountSelector} .cinder-virtual-list`);
    await list.scrollIntoViewIfNeeded();
    const listTop = await list.evaluate(
      (element) => element.getBoundingClientRect().top + window.scrollY,
    );
    await page.evaluate((top) => window.scrollTo(0, top), listTop);
    await expect
      .poll(() => renderedIndices(page, mountSelector).then((indices) => indices.includes(1)))
      .toBe(true);

    // Row 70, twenty rows into section 2: past the overscan, so header 50 is pinned. Read in
    // the same task as the write, after the component's synchronous update: a
    // transition would leave the computed value at the old offset here.
    const geometry = await list.evaluate(async (element, top) => {
      window.scrollTo(0, top + 2_800);
      await new Promise<void>((resolve) => {
        new MutationObserver((_, observer) => {
          observer.disconnect();
          resolve();
        }).observe(element, { subtree: true, attributes: true, childList: true });
      });
      const parts = ['__spacer', '__window'].map(
        (suffix) => element.querySelector(`.cinder-virtual-list${suffix}`) as HTMLElement,
      );
      const pinned = element.querySelector<HTMLElement>('[data-cinder-sticky-pinned="true"]');
      const rows = [...element.querySelectorAll<HTMLElement>('.cinder-virtual-list__row')];
      const [spacer, rendered] = parts as [HTMLElement, HTMLElement];
      return {
        pinned: pinned !== null,
        windowInset: [rendered.style.insetBlockStart, getComputedStyle(rendered).insetBlockStart],
        pinnedInset: pinned
          ? [pinned.style.insetBlockStart, getComputedStyle(pinned).insetBlockStart]
          : null,
        spacerSize: [spacer.style.blockSize, getComputedStyle(spacer).blockSize],
        animations: [spacer, rendered, ...rows].flatMap((node) => node.getAnimations()).length,
      };
    }, listTop);

    expect(geometry.pinned).toBe(true);
    expect(geometry.windowInset[1]).toBe(geometry.windowInset[0]);
    expect(geometry.pinnedInset?.[1]).toBe(geometry.pinnedInset?.[0]);
    expect(geometry.spacerSize[1]).toBe(geometry.spacerSize[0]);
    expect(geometry.animations).toBe(0);
  });
});
