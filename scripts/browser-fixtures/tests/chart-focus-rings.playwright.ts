import {
  chartRoot,
  charts,
  focusFromSentinel,
  focusTargetDirectly,
  insertSentinelBeforeChartViewport,
  primaryRingSelector,
  resetFocusToBody,
  routeFor,
  tabUntilChartTargetFocused,
  targetSelector,
  tooltipDescribedByTarget,
} from './chart-focus-rings-support.ts';
import {
  assertVisibleRing,
  changedPixelCount,
  clippedScreenshot,
  expectBoxInside,
  ringScreenshotClip,
} from './chart-focus-rings-visual-support.ts';
import { expect, test } from './review-editor-browser-errors.ts';

test.describe('chart SVG focus rings', () => {
  for (const chart of charts) {
    test(`${chart.slug}: real Tab focus creates one visible SVG ring and a pixel delta`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto(routeFor(chart), { waitUntil: 'load' });
      await page.waitForLoadState('networkidle');

      const root = await chartRoot(page, chart);
      await resetFocusToBody(page);
      const encountered = await tabUntilChartTargetFocused(page, chart);
      expect(encountered.at(-1)?.ariaLabel).toBe(chart.accessibleName);
      const target = page.locator(targetSelector(chart)).first();
      await expect(target).toBeFocused();
      const diagnostic = await target.evaluate((element) => ({
        ariaLabel: element.getAttribute('aria-label'),
        matchesFocusVisible: element.matches(':focus-visible'),
      }));
      expect(diagnostic.ariaLabel).toBe(chart.accessibleName);

      await assertVisibleRing(root, chart);

      await page.addStyleTag({
        content: '[role="tooltip"] { visibility: hidden !important; }',
      });
      await insertSentinelBeforeChartViewport(root, chart);
      const clip = await ringScreenshotClip(page, root, chart);
      const afterFocus = await clippedScreenshot(page, clip);
      await page.locator('[data-chart-focus-sentinel]').first().focus();
      const beforeFocus = await clippedScreenshot(page, clip);
      await focusFromSentinel(page, chart);
      await expect(target).toHaveAttribute('data-cinder-target-id', chart.targetId);
      const afterRefocus = await clippedScreenshot(page, clip);

      expect(
        changedPixelCount(beforeFocus, afterFocus),
        `${chart.slug}: initial focus pixel delta`,
      ).toBeGreaterThanOrEqual(8);
      expect(
        changedPixelCount(beforeFocus, afterRefocus),
        `${chart.slug}: refocus pixel delta`,
      ).toBeGreaterThanOrEqual(8);
    });

    for (const mode of ['light', 'dark', 'forced-colors'] as const) {
      test(`${chart.slug}: computed SVG ring contract in ${mode}`, async ({ page }) => {
        await page.emulateMedia({
          colorScheme: mode === 'dark' ? 'dark' : 'light',
          forcedColors: mode === 'forced-colors' ? 'active' : 'none',
        });
        await page.goto(routeFor(chart), { waitUntil: 'load' });
        await page.waitForLoadState('networkidle');
        const root = await chartRoot(page, chart);
        await insertSentinelBeforeChartViewport(root, chart);
        await focusFromSentinel(page, chart);
        await assertVisibleRing(root, chart, mode === 'forced-colors');
      });
    }

    test(`${chart.slug}: keyboard Tab skips the aria-hidden SVG in a loading chart`, async ({
      page,
    }) => {
      await page.goto(routeFor(chart), { waitUntil: 'load' });
      await page.waitForSelector('#example-mount-loading', { state: 'visible', timeout: 20_000 });
      await page.waitForLoadState('networkidle');

      const loadingRoot = page.locator(`#example-mount-loading .${chart.rootClass}`).first();
      await expect(loadingRoot).toBeVisible();
      const loadingSvg = loadingRoot.locator('svg').first();
      await expect(loadingSvg).toHaveAttribute('aria-hidden', 'true');
      // The whole plot subtree — including the tabindex="0" focus targets — is
      // gated behind the same guard as <title>, so none exist in the DOM at all
      // while loading.
      await expect(loadingRoot.locator(`.${chart.targetClass}`)).toHaveCount(0);

      await insertSentinelBeforeChartViewport(loadingRoot, chart);
      const sentinel = page.locator('[data-chart-focus-sentinel]').first();
      await sentinel.focus();
      await expect(sentinel).toBeFocused();

      await page.keyboard.press('Tab');

      const focusedInsideHiddenSvg = await loadingSvg.evaluate((svg) =>
        svg.contains(document.activeElement),
      );
      expect(
        focusedInsideHiddenSvg,
        `${chart.slug}: Tab must not land inside the aria-hidden svg`,
      ).toBe(false);
    });
  }

  test('programmatic area-chart focus updates tooltip state without rendering the keyboard ring', async ({
    page,
  }) => {
    const chart = charts[0]!;
    await page.goto(routeFor(chart), { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    const root = await chartRoot(page, chart);
    const target = await focusTargetDirectly(page, chart);
    const tooltip = await tooltipDescribedByTarget(page, target);

    await expect(root.locator(`.${chart.rootClass}__focus-ring-layer`)).toHaveCount(0);
    await expect(tooltip).toContainText(chart.tooltipText);
  });

  test('tooltip does not fully cover a focused area-chart ring', async ({ page }) => {
    const chart = charts[0]!;
    await page.goto(routeFor(chart), { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    const root = await chartRoot(page, chart);
    await insertSentinelBeforeChartViewport(root, chart);
    await focusFromSentinel(page, chart);
    const target = page.locator(targetSelector(chart)).first();
    const tooltip = await tooltipDescribedByTarget(page, target);
    await expect(tooltip).toContainText(chart.tooltipText);

    const ringBox = await root.locator(primaryRingSelector(chart)).first().boundingBox();
    const tooltipBox = await tooltip.boundingBox();
    if (!ringBox || !tooltipBox) throw new Error('Missing ring or tooltip bounds.');

    const tooltipFullyCoversRing =
      tooltipBox.x <= ringBox.x &&
      tooltipBox.y <= ringBox.y &&
      tooltipBox.x + tooltipBox.width >= ringBox.x + ringBox.width &&
      tooltipBox.y + tooltipBox.height >= ringBox.y + ringBox.height;

    expect(tooltipFullyCoversRing).toBe(false);
  });

  test('visual focus-ring layer does not intercept chart hover hit surfaces', async ({ page }) => {
    const chart = charts[1]!;
    await page.goto(routeFor(chart), { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    const root = await chartRoot(page, chart);
    const target = page.locator(targetSelector(chart)).first();
    await target.scrollIntoViewIfNeeded();
    const targetBox = await target.boundingBox();
    if (!targetBox) throw new Error('Missing line-chart target bounds.');

    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2);

    const tooltip = await tooltipDescribedByTarget(page, target);
    await expect(root.locator(`.${chart.rootClass}__focus-ring-layer`)).toHaveCount(0);
    await expect(tooltip).toContainText(chart.tooltipText);
    await expect(root.locator(`.${chart.hitSurfaceClass}`).first()).toBeVisible();
  });

  test('horizontal bar-chart category labels stay inside the SVG viewport', async ({ page }) => {
    const chart = charts[2]!;
    await page.goto(routeFor(chart), { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    const label = page
      .locator(
        '.cinder-bar-chart[data-cinder-orientation="horizontal"] .cinder-bar-chart__tick-label',
      )
      .filter({ hasText: 'Critical escalation' })
      .first();
    await expect(label).toHaveText('Critical escalation');

    const root = label.locator(
      'xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " cinder-bar-chart ")]',
    );
    const svg = root.locator('svg').first();
    const bar = root.locator('.cinder-bar-chart__bar').first();
    const labelBox = await label.boundingBox();
    const svgBox = await svg.boundingBox();
    const barBox = await bar.boundingBox();
    if (!labelBox || !svgBox || !barBox) {
      throw new Error('Missing horizontal bar-chart label, SVG, or bar bounds.');
    }

    expectBoxInside(labelBox, svgBox, 'horizontal bar-chart category label inside SVG');
    expect(barBox.width, 'horizontal bar-chart preserves plot width').toBeGreaterThan(0);
  });
});
