import { expect, type Page } from '@playwright/test';

export const EDGE_TOLERANCE = 0.5;
export const HORIZONTAL_LIST = '.cinder-tab-list[aria-label="Workflow stages"]';
export const VERTICAL_LIST = '.cinder-tab-list[aria-label="Workflow stages (vertical)"]';

export type RingMetrics = {
  matchesFocusVisible: boolean;
  boxShadow: string;
  tab: { top: number; bottom: number; left: number; right: number };
  list: { top: number; bottom: number; left: number; right: number };
  ringOutsetPx: number;
  resolvedRingColor: string;
};

export async function resolvedRingColor(page: Page, withinSelector: string): Promise<string> {
  return page.evaluate((selector) => {
    const anchor = document.querySelector(selector);
    if (!(anchor instanceof HTMLElement)) throw new Error(`No element matched ${selector}`);
    const token = getComputedStyle(anchor).getPropertyValue('--cinder-ring-color').trim();
    const probe = document.createElement('span');
    probe.style.color = token;
    document.body.append(probe);
    try {
      return getComputedStyle(probe).color;
    } finally {
      probe.remove();
    }
  }, withinSelector);
}

function ringOutset(boxShadow: string): number {
  let maximum = 0;
  for (const layer of boxShadow.split(/,(?![^(]*\))/)) {
    if (/\binset\b/.test(layer)) continue;
    const lengths = [...layer.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((match) =>
      Number.parseFloat(match[1] ?? '0'),
    );
    if (lengths.length < 2) continue;
    const outset =
      (lengths[3] ?? 0) + Math.max(Math.abs(lengths[0] ?? 0), Math.abs(lengths[1] ?? 0));
    maximum = Math.max(maximum, outset);
  }
  return maximum;
}

async function readTabMetrics(page: Page, selector: string): Promise<RingMetrics> {
  return page
    .evaluate((listSelector) => {
      const list = document.querySelector(listSelector);
      if (!(list instanceof HTMLElement)) throw new Error(`No list ${listSelector}`);
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) throw new Error('No active element');
      const tabRect = active.getBoundingClientRect();
      const listRect = list.getBoundingClientRect();
      const styles = getComputedStyle(active);
      const probe = document.createElement('span');
      probe.style.color = styles.getPropertyValue('--cinder-ring-color').trim();
      document.body.append(probe);
      let resolvedColor: string;
      try {
        resolvedColor = getComputedStyle(probe).color;
      } finally {
        probe.remove();
      }
      return {
        matchesFocusVisible: active.matches(':focus-visible'),
        boxShadow: styles.boxShadow,
        tab: { top: tabRect.top, bottom: tabRect.bottom, left: tabRect.left, right: tabRect.right },
        list: {
          top: listRect.top,
          bottom: listRect.bottom,
          left: listRect.left,
          right: listRect.right,
        },
        resolvedRingColor: resolvedColor,
      };
    }, selector)
    .then((metrics) => ({ ...metrics, ringOutsetPx: ringOutset(metrics.boxShadow) }));
}

export async function tabWalkToTab(
  page: Page,
  listSelector: string,
  tabName: string,
): Promise<RingMetrics> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    document.body.focus();
  });
  let landed = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await page.keyboard.press('Tab');
    landed = await page.evaluate(
      ({ selector, name }) => {
        const list = document.querySelector(selector);
        const active = document.activeElement;
        return (
          list !== null &&
          active instanceof HTMLElement &&
          active.classList.contains('cinder-tab') &&
          list.contains(active) &&
          active.textContent?.trim() === name
        );
      },
      { selector: listSelector, name: tabName },
    );
    if (landed) break;
  }
  expect(landed, `Tab walk never reached "${tabName}" in ${listSelector}`).toBe(true);
  return readTabMetrics(page, listSelector);
}

export function assertRingUnclipped(metrics: RingMetrics, label: string): void {
  const outset = metrics.ringOutsetPx;
  expect(
    metrics.tab.top - outset,
    `${label}: painted ring top inside list top`,
  ).toBeGreaterThanOrEqual(metrics.list.top - EDGE_TOLERANCE);
  expect(
    metrics.tab.bottom + outset,
    `${label}: painted ring bottom inside list bottom`,
  ).toBeLessThanOrEqual(metrics.list.bottom + EDGE_TOLERANCE);
  expect(
    metrics.tab.left - outset,
    `${label}: painted ring left inside list left`,
  ).toBeGreaterThanOrEqual(metrics.list.left - EDGE_TOLERANCE);
  expect(
    metrics.tab.right + outset,
    `${label}: painted ring right inside list right`,
  ).toBeLessThanOrEqual(metrics.list.right + EDGE_TOLERANCE);
}
