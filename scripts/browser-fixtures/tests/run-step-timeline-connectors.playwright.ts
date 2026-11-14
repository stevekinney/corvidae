/// <reference lib="dom" />
/**
 * RunStepTimeline's connectors (owner review, 2026-11-13: "The line doesn't connect to the empty
 * dot"). Every marker occupies one box per variant whatever it draws, and the line runs from the
 * bottom of one marker's box to the top of the next sibling's, on the markers' axis, past any
 * nested rows. happy-dom performs no layout, so this is measured in a browser on the
 * `connectors` fixture (every status, a wrapped title, nested steps, both variants), in both
 * themes, at desktop and phone widths.
 */

import { THEME_STORAGE_KEY } from '@lostgradient/testing';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { fixtureRoute } from './overlay-fixture.ts';

const TOLERANCE = 0.5;

type Marker = { row: number; depth: number; x: number; top: number; bottom: number };
type Segment = { row: number; x: number; top: number; bottom: number; ends: boolean };
type Rail = { name: string; markers: Marker[]; segments: Segment[] };

async function openConnectors(
  browser: Browser,
  theme: 'light' | 'dark',
  width: number,
): Promise<Page> {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: 'reduce',
    viewport: { width, height: 1200 },
  });
  await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    THEME_STORAGE_KEY,
    theme,
  ] as const);
  const page = await context.newPage();
  await page.goto(fixtureRoute('run-step-timeline', { fixtureName: 'connectors' }), {
    waitUntil: 'load',
  });
  await page
    .locator('[data-testid="nested-narrative"] .cinder-run-step-timeline__item')
    .first()
    .waitFor();
  return page;
}

async function readRails(page: Page): Promise<Rail[]> {
  return page.evaluate(() => {
    const px = (value: string) => Number.parseFloat(value);
    return [...document.querySelectorAll<HTMLElement>('[data-testid]')].map((cell) => {
      const markers: Marker[] = [];
      const segments: Segment[] = [];
      const items = [
        ...cell.querySelectorAll<HTMLElement>(
          '.cinder-run-step-timeline > .cinder-run-step-timeline__item',
        ),
      ];
      items.forEach((item, row) => {
        const box = item.getBoundingClientRect();
        const marker = item.querySelector(
          ':scope > .cinder-run-step-timeline__event .cinder-run-step-marker, :scope > .cinder-run-step-timeline__event .cinder-status-dot__indicator',
        );
        if (marker) {
          const m = marker.getBoundingClientRect();
          markers.push({
            row,
            depth: Number(item.dataset['cinderDepth'] ?? 0),
            x: (m.left + m.right) / 2,
            top: m.top,
            bottom: m.bottom,
          });
        }
        if (item.dataset['cinderConnectorAfter'] === 'visible') {
          const line = getComputedStyle(item, '::before');
          const left = box.left + px(line.left);
          segments.push({
            row,
            x: left + px(line.width) / 2,
            top: box.top + px(line.top),
            bottom: box.bottom - px(line.bottom),
            ends: false,
          });
        }
        for (const rail of item.querySelectorAll<HTMLElement>(
          ':scope > .cinder-run-step-timeline__rail-through',
        )) {
          const r = rail.getBoundingClientRect();
          segments.push({
            row,
            x: (r.left + r.right) / 2,
            top: r.top,
            bottom: r.bottom,
            ends: rail.hasAttribute('data-cinder-ends'),
          });
        }
      });
      return { name: cell.dataset['testid'] ?? '', markers, segments };
    });
  });
}

// The epsilon absorbs floating-point noise in layout coordinates, not a looser bound.
const near = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE + 1e-6;

/** Each segment starts on a marker's bottom or the end of the segment above it, on one axis. */
function expectContinuous(rail: Rail): void {
  for (const segment of rail.segments) {
    const from =
      rail.markers.some(
        (marker) => near(marker.x, segment.x) && near(marker.bottom, segment.top),
      ) ||
      rail.segments.some(
        (other) => other !== segment && near(other.x, segment.x) && near(other.bottom, segment.top),
      );
    expect(from, `${rail.name} row ${segment.row}: the line starts on nothing`).toBe(true);
    const own = rail.markers.find((marker) => marker.row === segment.row);
    const to = segment.ends
      ? own !== undefined && near(own.bottom, segment.bottom)
      : rail.markers.some(
          (marker) => near(marker.x, segment.x) && near(marker.top, segment.bottom),
        ) ||
        rail.segments.some(
          (other) =>
            other !== segment && near(other.x, segment.x) && near(other.top, segment.bottom),
        );
    expect(to, `${rail.name} row ${segment.row}: the line ends on nothing`).toBe(true);
  }
}

/** Each marker is joined to the next marker at its depth, with no gap, along its own axis. */
function expectSiblingsJoined(rail: Rail): void {
  rail.markers.forEach((marker, index) => {
    const after = rail.markers.slice(index + 1);
    const shallower = after.findIndex((other) => other.depth < marker.depth);
    const scope = shallower === -1 ? after : after.slice(0, shallower);
    const sibling = scope.find((other) => other.depth === marker.depth);
    if (!sibling) return;
    expect(near(sibling.x, marker.x), `${rail.name} row ${marker.row}: siblings off axis`).toBe(
      true,
    );
    let reach = marker.bottom;
    for (;;) {
      const next = rail.segments.find(
        (segment) => near(segment.x, marker.x) && near(segment.top, reach),
      );
      if (!next) break;
      reach = next.bottom;
    }
    expect(reach, `${rail.name} row ${marker.row} to row ${sibling.row}`).toBeCloseTo(
      sibling.top,
      0,
    );
    expect(Math.abs(reach - sibling.top)).toBeLessThanOrEqual(TOLERANCE);
  });
}

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1280, 390]) {
    test(`${theme} at ${width}: every connector touches the markers it joins`, async ({
      browser,
    }) => {
      const page = await openConnectors(browser, theme, width);
      try {
        const rails = await readRails(page);
        expect(rails.map((rail) => rail.name)).toEqual([
          'narrative',
          'detailed',
          'nested',
          'nested-narrative',
        ]);
        for (const rail of rails) {
          expect(rail.markers.length, rail.name).toBeGreaterThan(3);
          // Every marker of a variant is one box, whatever it draws.
          const heights = new Set(
            rail.markers.map((marker) => Math.round(marker.bottom - marker.top)),
          );
          expect(heights.size, `${rail.name} marker heights`).toBe(1);
          expectContinuous(rail);
          expectSiblingsJoined(rail);
        }
      } finally {
        await page.context().close();
      }
    });
  }
}
