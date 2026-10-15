import { FIXTURE_ORIGIN } from '../scripts/fixture-port.ts';
/// <reference lib="dom" />
/** Browser proof for dense domain focus rings in the application-owned Chat fixture. */
import {
  boxShadowLayerCount,
  THEME_STORAGE_KEY,
  waitForFocusStyleFrame,
} from '@lostgradient/testing';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';

import { environmentConfiguration } from '../environment-configuration.ts';
import { fixtureRoute } from './overlay-fixture.ts';
import { outerBands, parseBoxShadow } from './quiet-focus-rings-support.ts';

const HARNESS = '[data-testid="chat-private-harness"]';
const FIXTURE_ROUTE = fixtureRoute('chat', { fixtureName: 'private-harness' });
const BASE_URL = environmentConfiguration().browserFixtureUrl ?? FIXTURE_ORIGIN;

type ChatHarnessPage = { page: Page; harness: Locator; dispose: () => Promise<void> };

async function openChatHarness(
  browser: Browser,
  options: { forcedColors?: 'active' } = {},
): Promise<ChatHarnessPage> {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    viewport: { width: 1280, height: 900 },
    ...(options.forcedColors !== undefined ? { forcedColors: options.forcedColors } : {}),
  });
  try {
    await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [
      THEME_STORAGE_KEY,
      'dark',
    ] as const);
    const page = await context.newPage();
    await page.goto(FIXTURE_ROUTE, { waitUntil: 'load' });
    await page.waitForSelector('#app > *', { state: 'visible', timeout: 20_000 });
    const harness = page.locator(HARNESS);
    await harness.waitFor({ state: 'visible', timeout: 20_000 });
    return { page, harness, dispose: () => context.close() };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function blurToBody(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    document.body.focus();
  });
}

async function activeElementSummary(page: Page): Promise<string> {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element) return '<none>';
    const id = element.id ? `#${element.id}` : '';
    const classes =
      element instanceof HTMLElement && element.className
        ? `.${element.className.trim().replace(/\s+/g, '.')}`
        : '';
    return `${element.tagName.toLowerCase()}${id}${classes}`;
  });
}

async function tabUntilFocused(
  page: Page,
  target: Locator,
  label: string,
  maxPresses = 80,
  direction: 'forward' | 'backward' = 'forward',
): Promise<void> {
  for (let attempt = 0; attempt < maxPresses; attempt += 1) {
    await page.keyboard.press(direction === 'forward' ? 'Tab' : 'Shift+Tab');
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error(
    `Tab walk did not reach ${label}; active element is ${await activeElementSummary(page)}`,
  );
}

async function focusPaint(target: Locator): Promise<{
  boxShadow: string;
  matchesFocusVisible: boolean;
  outlineColor: string;
  outlineColorAlpha: number;
  outlineStyle: string;
  outlineWidth: string;
}> {
  await waitForFocusStyleFrame(target);
  return target.evaluate((element) => {
    function colorAlpha(color: string): number {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d');
      if (!context) return 0;
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return context.getImageData(0, 0, 1, 1).data[3] ?? 0;
    }
    const styles = getComputedStyle(element as HTMLElement);
    return {
      boxShadow: styles.boxShadow,
      matchesFocusVisible: element.matches(':focus-visible'),
      outlineColor: styles.outlineColor,
      outlineColorAlpha: colorAlpha(styles.outlineColor),
      outlineStyle: styles.outlineStyle,
      outlineWidth: styles.outlineWidth,
    };
  });
}

type FocusPaint = Awaited<ReturnType<typeof focusPaint>>;
const FOCUS_RING_SETTLE_TIMEOUT_MS = 500;
const FOCUS_RING_SETTLE_POLL_INTERVALS_MS = [10, 25, 50, 100];

async function waitForSettledFocusPaint(target: Locator, label: string): Promise<FocusPaint> {
  let paint = await focusPaint(target);
  try {
    await expect
      .poll(
        async () => {
          paint = await focusPaint(target);
          return paint.outlineColorAlpha;
        },
        { timeout: FOCUS_RING_SETTLE_TIMEOUT_MS, intervals: FOCUS_RING_SETTLE_POLL_INTERVALS_MS },
      )
      .toBe(0);
  } catch (error) {
    throw new Error(
      `${label} focus-ring recipe never settled to a transparent outline ` +
        `(outlineColor=${paint.outlineColor}, boxShadow=${paint.boxShadow}, ` +
        `matchesFocusVisible=${paint.matchesFocusVisible})`,
      { cause: error },
    );
  }
  return paint;
}

async function assertSharedOuterRing(
  target: Locator,
  label: string,
  options: { filled?: boolean } = {},
): Promise<void> {
  const paint = await waitForSettledFocusPaint(target, label);
  expect(paint.matchesFocusVisible, `${label} should match :focus-visible`).toBe(true);
  expect(paint.outlineStyle, `${label} should reserve an outline channel`).toBe('solid');
  expect(parseFloat(paint.outlineWidth), `${label} outline width`).toBeGreaterThan(0);
  expect(paint.boxShadow, `${label} should paint a focus shadow`).not.toBe('none');
  expect(
    boxShadowLayerCount(paint.boxShadow),
    `${label} should use the shared two-stop ring`,
  ).toBeGreaterThanOrEqual(2);
  // Updated for COR-1498: unfilled targets paint one tight 2px ring (the offset
  // stop is 0px). A solid accent fill (the enabled send button) paints a 2px
  // page-coloured gap and then the ring, so its hard bands are 2px and 4px.
  // Blurred elevation layers are not bands.
  expect(
    outerBands(parseBoxShadow(paint.boxShadow)).map((band) => band.spread),
    `${label} should paint ${options.filled ? 'a gap then the ring' : 'one tight 2px ring'}`,
  ).toEqual(options.filled ? [2, 4] : [2]);
  expect(paint.boxShadow, `${label} should not use an inset ring`).not.toContain('inset');
}

async function assertInsetRing(target: Locator, label: string): Promise<void> {
  const paint = await waitForSettledFocusPaint(target, label);
  expect(paint.matchesFocusVisible, `${label} should match :focus-visible`).toBe(true);
  expect(paint.outlineStyle, `${label} should reserve an outline channel`).toBe('solid');
  expect(parseFloat(paint.outlineWidth), `${label} outline width`).toBeGreaterThan(0);
  expect(paint.boxShadow, `${label} should paint an inset focus shadow`).toContain('inset');
}

async function seedDenseChatSurface(harness: Locator): Promise<void> {
  await harness.locator('[data-testid="seed-thread"]').click();
  await expect(harness.locator('[data-role="assistant"]').first()).toBeVisible({ timeout: 5_000 });
  const timeline = harness.locator('.chat-timeline');
  await timeline.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await expect.poll(async () => timeline.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(harness.locator('.chat-jump-button')).toBeVisible({ timeout: 5_000 });
  const composer = harness.locator('textarea.chat-input-editor').first();
  await composer.fill('Keyboard focus ring check');
  await expect(harness.locator('.chat-input-send')).toBeEnabled();
}

test.describe('domain focus rings -- chat harness', () => {
  test('keyboard tabs through dense chat targets with visible recipe-backed rings', async ({
    browser,
  }) => {
    const { page, harness, dispose } = await openChatHarness(browser);
    try {
      await seedDenseChatSurface(harness);
      const timeline = harness.locator('.chat-timeline');
      const messageCopy = harness.locator('.chat-message-action-button.chat-message-copy').first();
      const jumpToLatest = harness.locator('.chat-jump-button');
      const sendButton = harness.locator('.chat-input-send');
      const composer = harness.locator('textarea.chat-input-editor').first();
      await expect(timeline).toBeVisible();
      await expect(messageCopy).toBeAttached();
      await expect(jumpToLatest).toBeVisible();
      await expect(composer).toBeVisible();
      await expect(sendButton).toBeEnabled();
      await blurToBody(page);
      await tabUntilFocused(page, timeline, 'chat timeline', 120);
      await expect(timeline).toBeFocused();
      await assertInsetRing(timeline, 'chat timeline');
      await tabUntilFocused(page, messageCopy, 'message copy action', 8);
      await expect(messageCopy).toBeFocused();
      await assertSharedOuterRing(messageCopy, 'message copy action');
      await composer.click();
      await tabUntilFocused(page, jumpToLatest, 'jump to latest', 8, 'backward');
      await expect(jumpToLatest).toBeFocused();
      await assertSharedOuterRing(jumpToLatest, 'jump to latest');
      await composer.click();
      await tabUntilFocused(page, sendButton, 'send button', 8);
      await expect(sendButton).toBeFocused();
      await assertSharedOuterRing(sendButton, 'send button', { filled: true });
    } finally {
      await dispose();
    }
  });

  test('forced-colors fallback repaints the send button outline', async ({ browser }) => {
    const { page, harness, dispose } = await openChatHarness(browser, { forcedColors: 'active' });
    try {
      await seedDenseChatSurface(harness);
      await expect
        .poll(() => page.evaluate(() => window.matchMedia('(forced-colors: active)').matches))
        .toBe(true);
      const sendButton = harness.locator('.chat-input-send');
      await blurToBody(page);
      await tabUntilFocused(page, sendButton, 'send button', 160);
      await expect(sendButton).toBeFocused();
      const paint = await focusPaint(sendButton);
      expect(paint.matchesFocusVisible).toBe(true);
      expect(paint.outlineStyle).toBe('solid');
      expect(parseFloat(paint.outlineWidth)).toBeGreaterThan(0);
      expect(paint.outlineColorAlpha).toBeGreaterThan(0);
    } finally {
      await dispose();
    }
  });
});

test.describe('domain focus rings -- CIN-516 settle race regression', () => {
  test('the pre-settle paint is the CIN-516 signature and the recipe reads as an inset ring once it lands', async ({
    browser,
  }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    try {
      await page.setContent(`
        <style>
          #target:focus-visible { outline: 3px solid; }
        </style>
        <button id="target" style="margin: 40px; color: rgb(218, 230, 241);">Target</button>
      `);
      const target = page.locator('#target');
      await page.keyboard.press('Tab');
      await expect(target).toBeFocused();
      const preSettle = await focusPaint(target);
      expect(
        preSettle.outlineColorAlpha,
        'pre-settle outline should still be opaque',
      ).toBeGreaterThan(0);
      expect(preSettle.boxShadow, 'pre-settle should have no shadow yet').toBe('none');
      await page.addStyleTag({
        content:
          '#target:focus-visible { outline-color: transparent; box-shadow: inset 0 0 0 3px rgb(218, 230, 241); }',
      });
      await assertInsetRing(target, 'delayed-settle target');
    } finally {
      await context.close();
    }
  });
});
