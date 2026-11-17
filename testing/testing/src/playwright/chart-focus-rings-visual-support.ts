import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { ChartDefinition, ElementBox, ScreenshotClip } from './chart-focus-rings-support.ts';

const SCREENSHOT_CLIP_PADDING_CSS_PIXELS = 4;

async function ringStyleSnapshot(root: Locator, chart: ChartDefinition) {
  const layer = root.locator(`.${chart.rootClass}__focus-ring-layer`);
  await expect(layer).toHaveCount(1);
  await expect(layer).toHaveAttribute('aria-hidden', 'true');
  const ring = root
    .locator(
      `.${chart.rootClass}__focus-ring:not(.${chart.rootClass}__focus-ring-connector):not(.${chart.rootClass}__focus-ring-dot)`,
    )
    .first();
  const halo = root.locator(`.${chart.rootClass}__focus-ring-halo`).first();
  await expect(ring).toHaveCount(1);
  await expect(halo).toHaveCount(1);
  return ring.evaluate((element, haloClass) => {
    const styles = getComputedStyle(element);
    const haloElement = element.closest('g')?.querySelector(`.${haloClass}`);
    if (!(haloElement instanceof SVGElement)) throw new Error('Focus ring halo is missing.');
    const haloStyles = getComputedStyle(haloElement);
    const ringBox = element.getBoundingClientRect();
    const svg = element.closest('svg');
    if (!(svg instanceof SVGElement)) throw new Error('Focus ring is not inside an SVG.');
    return {
      stroke: styles.stroke,
      strokeWidth: Number.parseFloat(styles.strokeWidth),
      filter: styles.filter,
      haloDisplay: haloStyles.display,
      pointerEvents: styles.pointerEvents,
      vectorEffect: styles.getPropertyValue('vector-effect'),
      ringBox: {
        x: ringBox.x,
        y: ringBox.y,
        width: ringBox.width,
        height: ringBox.height,
      },
      svgBox: (() => {
        const box = svg.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      })(),
    };
  }, `${chart.rootClass}__focus-ring-halo`);
}

function expectNonTransparentStroke(stroke: string): void {
  expect(stroke).toBeTruthy();
  expect(stroke).not.toBe('none');
  expect(stroke).not.toBe('transparent');
  expect(stroke).not.toMatch(/rgba\([^)]*,\s*0(?:\s*\)|\s*%)/i);
  expect(stroke).not.toMatch(/rgb\([^)]*\/\s*0(?:\s*\)|\s*%)/i);
}

export function expectBoxInside(inner: ElementBox, outer: ElementBox, label: string): void {
  const tolerance = 1;
  expect(inner.x, `${label}: left edge`).toBeGreaterThanOrEqual(outer.x - tolerance);
  expect(inner.y, `${label}: top edge`).toBeGreaterThanOrEqual(outer.y - tolerance);
  expect(inner.x + inner.width, `${label}: right edge`).toBeLessThanOrEqual(
    outer.x + outer.width + tolerance,
  );
  expect(inner.y + inner.height, `${label}: bottom edge`).toBeLessThanOrEqual(
    outer.y + outer.height + tolerance,
  );
}

export async function assertVisibleRing(
  root: Locator,
  chart: ChartDefinition,
  forcedColors = false,
) {
  const snapshot = await ringStyleSnapshot(root, chart);
  expectNonTransparentStroke(snapshot.stroke);
  expect(snapshot.strokeWidth).toBeGreaterThan(0);
  expect(snapshot.pointerEvents).toBe('none');
  expect(snapshot.vectorEffect).toBe('non-scaling-stroke');
  expect(snapshot.ringBox.width).toBeGreaterThan(0);
  expect(snapshot.ringBox.height).toBeGreaterThan(0);
  expectBoxInside(snapshot.ringBox, snapshot.svgBox, `${chart.slug} focus ring inside SVG`);
  if (forcedColors) {
    expect(snapshot.filter).toBe('none');
    expect(snapshot.haloDisplay).toBe('none');
  }
}

export async function ringScreenshotClip(
  page: Page,
  root: Locator,
  chart: ChartDefinition,
): Promise<ScreenshotClip> {
  await root.scrollIntoViewIfNeeded();
  const ring = root
    .locator(
      `.${chart.rootClass}__focus-ring:not(.${chart.rootClass}__focus-ring-connector):not(.${chart.rootClass}__focus-ring-dot)`,
    )
    .first();
  const svg = root.locator('svg').first();
  const ringBox = await ring.boundingBox();
  const svgBox = await svg.boundingBox();
  if (!ringBox || !svgBox) throw new Error(`${chart.slug}: missing ring or SVG screenshot clip.`);
  expect(ringBox.width, `${chart.slug}: ring screenshot width`).toBeGreaterThan(0);
  expect(ringBox.height, `${chart.slug}: ring screenshot height`).toBeGreaterThan(0);
  expectBoxInside(ringBox, svgBox, `${chart.slug} screenshot ring inside SVG`);
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error(`${chart.slug}: missing viewport for screenshot clip.`);
  const padding = SCREENSHOT_CLIP_PADDING_CSS_PIXELS;
  const x = Math.max(0, svgBox.x, ringBox.x - padding);
  const y = Math.max(0, svgBox.y, ringBox.y - padding);
  const right = Math.min(
    viewport.width,
    svgBox.x + svgBox.width,
    ringBox.x + ringBox.width + padding,
  );
  const bottom = Math.min(
    viewport.height,
    svgBox.y + svgBox.height,
    ringBox.y + ringBox.height + padding,
  );
  if (right <= x || bottom <= y)
    throw new Error(`${chart.slug}: focus ring screenshot clip is outside the viewport.`);
  return { x, y, width: right - x, height: bottom - y };
}

export async function clippedScreenshot(page: Page, clip: ScreenshotClip): Promise<Buffer> {
  return page.screenshot({ clip });
}

export function changedPixelCount(beforeBuffer: Buffer, afterBuffer: Buffer): number {
  const before = PNG.sync.read(beforeBuffer);
  const after = PNG.sync.read(afterBuffer);
  expect(after.width).toBe(before.width);
  expect(after.height).toBe(before.height);
  return pixelmatch(before.data, after.data, undefined, before.width, before.height, {
    threshold: 0.1,
  });
}
