import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

export type ChartDefinition = {
  slug: 'area-chart' | 'line-chart' | 'bar-chart';
  rootClass: string;
  targetClass: string;
  hitSurfaceClass: string;
  targetId: string;
  seriesId: string;
  accessibleName: string;
  tooltipText: string;
};

export type ElementBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ScreenshotClip = ElementBox;

export type TabbableSummary = {
  tagName: string;
  role: string | null;
  ariaLabel: string | null;
  text: string;
  targetId: string | null;
  seriesId: string | null;
};

export const charts: ChartDefinition[] = [
  {
    slug: 'area-chart',
    rootClass: 'cinder-area-chart',
    targetClass: 'cinder-area-chart__focus-target',
    hitSurfaceClass: 'cinder-area-chart__hit-surface',
    targetId: 'usage-string:Jan',
    seriesId: 'usage',
    accessibleName: 'Usage, Jan, 44',
    tooltipText: 'Jan: 44',
  },
  {
    slug: 'line-chart',
    rootClass: 'cinder-line-chart',
    targetClass: 'cinder-line-chart__focus-target',
    hitSurfaceClass: 'cinder-line-chart__hit-surface',
    targetId: 'revenue-string:Jan',
    seriesId: 'revenue',
    accessibleName: 'Revenue, Jan, 120',
    tooltipText: 'Jan: 120',
  },
  {
    slug: 'bar-chart',
    rootClass: 'cinder-bar-chart',
    targetClass: 'cinder-bar-chart__focus-target',
    hitSurfaceClass: 'cinder-bar-chart__hit-surface',
    targetId: 'active-string:Starter',
    seriesId: 'active',
    accessibleName: 'Active users, Starter, 120',
    tooltipText: 'Starter: 120',
  },
];

export function routeFor(chart: ChartDefinition): string {
  return `/page/${chart.slug}?snapshot=1`;
}

export function targetSelector(chart: ChartDefinition): string {
  return `.${chart.targetClass}[data-cinder-target-id="${chart.targetId}"][data-cinder-series-id="${chart.seriesId}"]`;
}

export function primaryRingSelector(chart: ChartDefinition): string {
  return `.${chart.rootClass}__focus-ring:not(.${chart.rootClass}__focus-ring-connector):not(.${chart.rootClass}__focus-ring-dot)`;
}

export async function chartRoot(page: Page, chart: ChartDefinition): Promise<Locator> {
  const target = page.locator(targetSelector(chart)).first();
  await expect(target).toHaveAttribute('aria-label', chart.accessibleName);
  const root = page.locator(`.${chart.rootClass}`).filter({ has: target }).first();
  await expect(root).toBeVisible();
  return root;
}

export async function focusTargetDirectly(page: Page, chart: ChartDefinition): Promise<Locator> {
  const target = page.locator(targetSelector(chart)).first();
  await target.focus();
  await expect(target).toBeFocused();
  return target;
}

export async function tooltipDescribedByTarget(page: Page, target: Locator): Promise<Locator> {
  await expect(target).toHaveAttribute('aria-describedby', /-tooltip$/);
  const tooltipId = await target.getAttribute('aria-describedby');
  if (!tooltipId) throw new Error('Chart target does not describe a tooltip.');
  return page.locator(`[id="${tooltipId}"][role="tooltip"]`).first();
}

async function activeElementSummary(page: Page): Promise<TabbableSummary> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof Element)) {
      return {
        tagName: '(none)',
        role: null,
        ariaLabel: null,
        text: '',
        targetId: null,
        seriesId: null,
      };
    }
    return {
      tagName: active.tagName.toLowerCase(),
      role: active.getAttribute('role'),
      ariaLabel: active.getAttribute('aria-label'),
      text: active.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) ?? '',
      targetId: active.getAttribute('data-cinder-target-id'),
      seriesId: active.getAttribute('data-cinder-series-id'),
    };
  });
}

export async function tabUntilChartTargetFocused(
  page: Page,
  chart: ChartDefinition,
  maximumAttempts = 100,
): Promise<TabbableSummary[]> {
  const encountered: TabbableSummary[] = [];
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    await page.keyboard.press('Tab');
    const summary = await activeElementSummary(page);
    encountered.push(summary);
    if (summary.targetId === chart.targetId && summary.seriesId === chart.seriesId) {
      return encountered;
    }
  }
  throw new Error(
    `${chart.slug}: Tab did not reach ${chart.targetId}. Encountered: ${JSON.stringify(
      encountered,
      null,
      2,
    )}`,
  );
}

export async function resetFocusToBody(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    document.body.setAttribute('tabindex', '-1');
    document.body.focus();
    document.body.removeAttribute('tabindex');
  });
}

export async function insertSentinelBeforeChartViewport(
  root: Locator,
  chart: ChartDefinition,
): Promise<void> {
  const svg = root.locator('svg').first();
  const documentBox = async (): Promise<ElementBox> =>
    svg.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return {
        x: box.x + window.scrollX,
        y: box.y + window.scrollY,
        width: box.width,
        height: box.height,
      };
    });
  const before = await documentBox();

  await root.evaluate((element, rootClass) => {
    const viewport = element.querySelector(`.${rootClass}__viewport`);
    if (!viewport?.parentElement) throw new Error(`Missing .${rootClass}__viewport`);
    const sentinel = document.createElement('button');
    sentinel.type = 'button';
    sentinel.textContent = 'chart focus sentinel';
    sentinel.setAttribute('data-chart-focus-sentinel', '');
    Object.assign(sentinel.style, {
      position: 'fixed',
      inset: '0 auto auto 0',
      width: '1px',
      height: '1px',
      padding: '0',
      margin: '0',
      border: '0',
      overflow: 'hidden',
      clipPath: 'inset(50%)',
      whiteSpace: 'nowrap',
    });
    viewport.parentElement.insertBefore(sentinel, viewport);
  }, chart.rootClass);

  const after = await documentBox();
  expect(Math.abs(after.x - before.x), `${chart.slug}: sentinel changed SVG x`).toBeLessThanOrEqual(
    0.5,
  );
  expect(Math.abs(after.y - before.y), `${chart.slug}: sentinel changed SVG y`).toBeLessThanOrEqual(
    0.5,
  );
  expect(
    Math.abs(after.width - before.width),
    `${chart.slug}: sentinel changed SVG width`,
  ).toBeLessThanOrEqual(0.5);
  expect(
    Math.abs(after.height - before.height),
    `${chart.slug}: sentinel changed SVG height`,
  ).toBeLessThanOrEqual(0.5);
}

export async function focusFromSentinel(
  page: Page,
  chart: ChartDefinition,
): Promise<TabbableSummary[]> {
  const sentinel = page.locator('[data-chart-focus-sentinel]').first();
  await sentinel.focus();
  await expect(sentinel).toBeFocused();
  const encountered = await tabUntilChartTargetFocused(page, chart);
  await expect(page.locator(targetSelector(chart)).first()).toBeFocused();
  return encountered;
}
