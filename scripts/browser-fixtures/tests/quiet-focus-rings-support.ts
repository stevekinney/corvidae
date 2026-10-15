/// <reference lib="dom" />
/**
 * Shared helpers for the COR-1498 focus-ring specs. The ring is tight (no
 * offset band) and 2px wide; filled controls paint it in
 * `--cinder-ring-on-accent`. These helpers open a themed fixture page, drive
 * keyboard focus, and read the painted ring back out of computed style.
 */
import { THEME_STORAGE_KEY, waitForFocusStyleFrame } from '@lostgradient/testing';
import { expect, type Browser, type Locator, type Page } from '@playwright/test';

import { environmentConfiguration } from '../environment-configuration.ts';
import { FIXTURE_ORIGIN } from '../scripts/fixture-port.ts';
import { fixtureRoute } from './overlay-fixture.ts';

export type Theme = 'light' | 'dark';
export const THEMES: readonly Theme[] = ['light', 'dark'];
export const DEVICE_SCALE_FACTOR = 2;

const BASE_URL = environmentConfiguration().browserFixtureUrl ?? FIXTURE_ORIGIN;
const MAX_TAB_PRESSES = 120;

export type ThemedPage = { page: Page; dispose: () => Promise<void> };

export async function openThemedFixture(
  browser: Browser,
  theme: Theme,
  slug: string,
  options: { fixtureName?: string; forcedColors?: 'active' } = {},
): Promise<ThemedPage> {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    colorScheme: theme,
    reducedMotion: 'reduce',
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    viewport: { width: 1280, height: 900 },
    ...(options.forcedColors === undefined ? {} : { forcedColors: options.forcedColors }),
  });
  try {
    await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [
      THEME_STORAGE_KEY,
      theme,
    ] as const);
    const page = await context.newPage();
    const fixtureOptions =
      options.fixtureName === undefined ? {} : { fixtureName: options.fixtureName };
    await page.goto(fixtureRoute(slug, fixtureOptions), { waitUntil: 'load' });
    await page.waitForSelector('#app > *', { state: 'visible', timeout: 20_000 });
    return { page, dispose: () => context.close() };
  } catch (error) {
    await context.close();
    throw error;
  }
}

/**
 * Walk Tab from `document.body` until `target` is focused, then wait one frame
 * so the focus cascade has painted. A keyboard walk is what engages
 * `:focus-visible`; a programmatic `.focus()` would not.
 */
export async function focusByKeyboard(page: Page, target: Locator, label: string): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    document.body.focus();
  });
  for (let attempt = 0; attempt < MAX_TAB_PRESSES; attempt += 1) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((element) => element === document.activeElement)) {
      await waitForFocusStyleFrame(page);
      expect(
        await target.evaluate((element) => element.matches(':focus-visible')),
        `${label} should match :focus-visible after the keyboard walk`,
      ).toBe(true);
      return;
    }
  }
  throw new Error(`Tab walk did not reach ${label}.`);
}

export type ShadowLayer = {
  color: string;
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  inset: boolean;
};

const COLOR_PATTERN = /^(?:[a-z-]+\([^()]*(?:\([^()]*\)[^()]*)*\)|#[0-9a-f]+|[a-z]+)/i;

/** Parse a computed `box-shadow` into layers. Returns [] for `none`. */
export function parseBoxShadow(boxShadow: string): ShadowLayer[] {
  const value = boxShadow.trim();
  if (value === '' || value === 'none') return [];
  return value.split(/,(?![^(]*\))/).map((raw) => {
    let rest = raw.trim();
    const inset = /\binset\b/.test(rest);
    rest = rest.replace(/\binset\b/, '').trim();
    const colorMatch = COLOR_PATTERN.exec(rest);
    if (colorMatch === null) throw new Error(`Unparseable box-shadow layer: ${raw}`);
    const color = colorMatch[0];
    const lengths = rest
      .slice(color.length)
      .trim()
      .split(/\s+/)
      .filter((part) => part.length > 0)
      .map((part) => Number.parseFloat(part));
    const [offsetX = 0, offsetY = 0, blur = 0, spread = 0] = lengths;
    return { color, offsetX, offsetY, blur, spread, inset };
  });
}

/**
 * A "band" is a hard-edged outer ring: not inset, no offset, no blur, and a
 * positive spread. Elevation shadows (blurred) are not bands. The old recipe
 * painted two bands (a 2px offset-colour halo inside a 4px ring); the tight
 * recipe paints exactly one.
 */
export function outerBands(layers: readonly ShadowLayer[]): ShadowLayer[] {
  return layers.filter(
    (layer) =>
      !layer.inset &&
      layer.offsetX === 0 &&
      layer.offsetY === 0 &&
      layer.blur === 0 &&
      layer.spread > 0,
  );
}

export type RingReading = {
  boxShadow: string;
  ringWidth: number;
  filledGap: number;
  ringColor: string;
  offsetColor: string;
  onAccentColor: string;
};

/** Read the painted box-shadow plus the resolved ring tokens on `target`. */
export async function readRing(target: Locator): Promise<RingReading> {
  return target.evaluate((element) => {
    const styles = getComputedStyle(element);
    // The probe sits beside the element so `light-dark()` resolves under the
    // same color-scheme (an <input> or <select> cannot host a rendered child).
    const probe = document.createElement('span');
    (element.parentElement ?? document.body).append(probe);
    try {
      const resolve = (token: string): string => {
        const value = styles.getPropertyValue(token).trim();
        if (value === '') throw new Error(`Token ${token} is unset on the focused element.`);
        // Reduced-motion fixtures give descendants a near-zero transition, and
        // computed style would report the pre-transition (inherited) colour.
        probe.style.setProperty('transition', 'none', 'important');
        probe.style.setProperty('color', value, 'important');
        return getComputedStyle(probe).color;
      };
      return {
        boxShadow: styles.boxShadow,
        ringWidth: Number.parseFloat(styles.getPropertyValue('--cinder-ring-width')),
        filledGap: Number.parseFloat(styles.getPropertyValue('--_cinder-focus-ring-filled-gap')),
        ringColor: resolve('--cinder-ring-color'),
        offsetColor: resolve('--cinder-ring-offset-color'),
        onAccentColor: resolve('--cinder-ring-on-accent'),
      };
    } finally {
      probe.remove();
    }
  });
}

/**
 * The expected focus ring:
 * - `tight`: one hard-edged band of `--cinder-ring-width` in `--cinder-ring-color`
 *   directly on the edge, with no offset band (unfilled controls);
 * - `gap`: a `--cinder-ring-offset-color` gap band, then the
 *   `--cinder-ring-color` ring outside it (filled controls);
 * - `on-accent`: one tight band in `--cinder-ring-on-accent` (FloatingAction
 *   primary, which predates COR-1498 and keeps its own ring).
 */
export type RingExpectation = 'tight' | 'gap' | 'on-accent';

export function expectRing(reading: RingReading, expected: RingExpectation, label: string): void {
  const bands = outerBands(parseBoxShadow(reading.boxShadow));
  const shape = bands.map((band) => ({ spread: band.spread, color: band.color }));
  if (expected === 'gap') {
    expect(reading.filledGap, `${label}: the filled gap is positive`).toBeGreaterThan(0);
    expect(shape, `${label}: gap band then ring (${reading.boxShadow})`).toEqual([
      { spread: reading.filledGap, color: reading.offsetColor },
      { spread: reading.filledGap + reading.ringWidth, color: reading.ringColor },
    ]);
    expect(reading.offsetColor, `${label}: the gap is distinct from the ring`).not.toBe(
      reading.ringColor,
    );
    return;
  }
  const color = expected === 'tight' ? reading.ringColor : reading.onAccentColor;
  expect(shape, `${label}: one tight band, no offset band (${reading.boxShadow})`).toEqual([
    { spread: reading.ringWidth, color },
  ]);
  expect(reading.ringColor, `${label}: the ring tokens differ`).not.toBe(reading.onAccentColor);
}
