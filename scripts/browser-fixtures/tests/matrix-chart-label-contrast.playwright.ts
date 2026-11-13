/// <reference lib="dom" />
/**
 * Every number in a MatrixChart keeps at least 4.5:1 against its own cell, in both themes and
 * along the whole sequential and diverging ramp; the numbers take only two colours (white or
 * black), switched once along each ramp; and a cell with no value is the page canvas, not the
 * lowest value. Colours are resolved by the browser and read back as sRGB through a canvas, so
 * `color-mix()`, `light-dark()` and relative colour all count as the page paints them.
 */

import { loadManifest } from '@lostgradient/testing';
import { expect, type Page } from '@playwright/test';
import { test } from './component-page-fixture.ts';

const entry = loadManifest().find((candidate) => candidate.slug === 'matrix-chart');
const fixture = entry?.fixtures?.find((candidate) => candidate.name === 'ramp');

type Reading = { cell: number[]; label: number[] | null; empty: boolean };

/** Each cell's painted sRGB and its number's, in document order, for one chart. */
async function readings(page: Page, testId: string): Promise<Reading[]> {
  return page.getByTestId(testId).evaluate((root) => {
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (context === null) throw new Error('No 2D canvas.');
    const srgb = (color: string): number[] => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = '#000';
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data.subarray(0, 3));
    };
    return [...root.querySelectorAll('.cinder-matrix-chart__cell-group')].map((group) => {
      const cell = group.querySelector('.cinder-matrix-chart__cell');
      const label = group.querySelector('.cinder-matrix-chart__cell-label');
      if (cell === null) throw new Error('No cell.');
      return {
        cell: srgb(getComputedStyle(cell).fill),
        label: label === null ? null : srgb(getComputedStyle(label).fill),
        empty: cell.hasAttribute('data-cinder-empty'),
      };
    });
  });
}

function luminance([red, green, blue]: number[]): number {
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red!) + 0.7152 * linear(green!) + 0.0722 * linear(blue!);
}

function contrast(a: number[], b: number[]): number {
  const [lighter, darker] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return (lighter! + 0.05) / (darker! + 0.05);
}

for (const theme of ['light', 'dark'] as const) {
  test(`every MatrixChart number keeps 4.5:1 on its own cell (${theme})`, async ({
    componentPage,
  }) => {
    if (entry === undefined || fixture === undefined) throw new Error('No matrix ramp fixture.');
    const page = await componentPage.open({
      entry,
      theme,
      viewport: { name: 'desktop', width: 1280, height: 900 },
      fixtureName: 'ramp',
      fixtureContentHash: fixture.fixtureContentHash,
    });
    await page.locator('.cinder-matrix-chart__cell-label').first().waitFor();
    for (const chart of ['sequential', 'diverging']) {
      const cells = await readings(page, chart);
      const labelled = cells.filter((cell) => cell.label !== null);
      expect(labelled.length, chart).toBeGreaterThanOrEqual(11);
      for (const { cell, label } of labelled) {
        expect(contrast(cell, label!), `${chart} ${cell.join(',')}`).toBeGreaterThanOrEqual(4.5);
      }
      // Only white and black, never a tinted or per-cell colour.
      const colours = new Set(labelled.map(({ label }) => label!.join(',')));
      expect([...colours].every((colour) => colour === '255,255,255' || colour === '0,0,0')).toBe(
        true,
      );
      // Along a row, the colour switches at most once on each side of the ramp's middle.
      const row = labelled.slice(0, 11).map(({ label }) => label!.join(','));
      const switches = row.slice(1).filter((colour, index) => colour !== row[index]).length;
      expect(switches, chart).toBeLessThanOrEqual(chart === 'diverging' ? 2 : 1);
    }
    // The empty cell is the page canvas, not the lowest step of the ramp.
    const sequential = await readings(page, 'sequential');
    const empty = sequential.filter((cell) => cell.empty);
    expect(empty).toHaveLength(1);
    const lowest = sequential[0]!;
    expect(empty[0]!.cell.join(',')).not.toBe(lowest.cell.join(','));
    expect(empty[0]!.label).toBeNull();
  });
}
