import { FIXTURE_ORIGIN } from '@lostgradient/testing/browser/fixture-port';
import { environmentConfiguration } from '@lostgradient/testing/environment-configuration';
import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test, type Page } from '@playwright/test';

/**
 * COR-2725: a transcript at its end stays at its end when its box shrinks with no message arriving.
 * After the layout settles, the last visible row ends at or above the transcript's reading box (its
 * box less `scroll-padding-block-end`, where the fade at its end begins), and the transcript is
 * scrolled to the end of its scrollable area.
 *
 * The cases that guard the defect are the `fits` ones, which draw the route's own sequence
 * (Interborough chat states, "tool-only turn reconnecting" at 320 by 640): a turn that only called
 * tools is drawn, and its transcript fits its box exactly, so it rests at scroll position 0, which
 * is its end. Then the stream drops. No message arrives; the reconnect notice mounts in the
 * composer and takes room from the transcript, which now overflows by a few pixels. The browser
 * does not anchor a scroll position of 0, and nothing pinned the transcript for a box that merely
 * shrank, so the last row was left in the fade at the end of the transcript. The window made
 * smaller (375 to 320 wide) is the same sequence with the content growing instead. The `long`
 * cases, a transcript that overflows and is scrolled to its end, are kept as guards: the browser's
 * own scroll anchoring holds those at the end, and the cases say it keeps doing so.
 *
 * A person who had scrolled up is the negative control: they are not moved.
 *
 * The fixture is `fixtures/chat.svelte` behind `?pinnedResize=fits` or `?pinnedResize=long`.
 *
 * Run: `bun run --cwd components/chat test:browser --grep "pinned transcript"`
 */
async function open(page: Page, mode: 'fits' | 'long'): Promise<void> {
  const url = new URL(
    fixtureRoute('chat'),
    environmentConfiguration().browserFixtureUrl ?? FIXTURE_ORIGIN,
  );
  url.searchParams.set('pinnedResize', mode);
  await page.goto(url.href);
  await expect(page.getByTestId('pinned-resize-chat').locator('.chat-timeline')).toBeVisible();
  await expect(
    page.getByTestId('pinned-resize-chat').getByText('Look up order 4471'),
  ).toBeVisible();
}

interface Rest {
  /** How far the transcript is from the end of its scrollable area. */
  readonly distanceToEnd: number;
  /** How far the last visible row's bottom is below the reading box's end; at most 0 at rest. */
  readonly overhang: number;
  readonly scrollTop: number;
}

/** Reads where the transcript rests, from one layout. */
async function rest(page: Page): Promise<Rest> {
  return page.evaluate(() => {
    const timeline = document.querySelector<HTMLElement>(
      '[data-testid="pinned-resize-chat"] .chat-timeline',
    );
    if (timeline === null) throw new Error('The transcript is not on the page.');
    const rows = [...timeline.querySelectorAll<HTMLElement>('article[data-message-id]')].filter(
      (row) => row.getClientRects().length > 0,
    );
    const last = rows.at(-1);
    if (last === undefined) throw new Error('The transcript has no visible row.');
    const padding = Number.parseFloat(getComputedStyle(timeline).scrollPaddingBottom);
    const readingEnd =
      timeline.getBoundingClientRect().bottom - (Number.isFinite(padding) ? padding : 0);
    return {
      distanceToEnd: timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop,
      overhang: last.getBoundingClientRect().bottom - readingEnd,
      scrollTop: timeline.scrollTop,
    };
  });
}

/** After the layout settles, the transcript rests at its true end with its last row clear of the fade. */
async function expectRestsAtEnd(page: Page): Promise<void> {
  await expect(async () => {
    const { distanceToEnd, overhang } = await rest(page);
    expect(Math.abs(distanceToEnd)).toBeLessThanOrEqual(1);
    expect(overhang).toBeLessThanOrEqual(1);
  }).toPass();
}

async function pinToEnd(page: Page): Promise<void> {
  await page
    .getByTestId('pinned-resize-chat')
    .locator('.chat-timeline')
    .evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
  await expectRestsAtEnd(page);
}

/**
 * Sizes the box to the content: the chat is as tall as what it draws, with two pixels to spare, so
 * the transcript fits at scroll position 0 and the first change that takes room from it overflows.
 */
async function sizeBoxToContent(page: Page): Promise<void> {
  await page.getByTestId('pinned-resize-chat').evaluate((chat) => {
    const timeline = chat.querySelector<HTMLElement>('.chat-timeline');
    const sentinel = chat.querySelector<HTMLElement>('.chat-bottom-sentinel');
    if (timeline === null || sentinel === null) throw new Error('The transcript is not drawn.');
    const padding = Number.parseFloat(getComputedStyle(timeline).paddingBottom);
    const contentEnd =
      sentinel.getBoundingClientRect().bottom -
      timeline.getBoundingClientRect().top +
      timeline.scrollTop +
      (Number.isFinite(padding) ? padding : 0);
    const spare = timeline.clientHeight - contentEnd;
    const height = chat.getBoundingClientRect().height - spare + 2;
    (chat as HTMLElement).style.height = `${String(height)}px`;
  });
  // It fits: nothing scrolls, and the end is the start.
  await expect(async () => {
    const { distanceToEnd, scrollTop } = await rest(page);
    expect(scrollTop).toBe(0);
    expect(distanceToEnd).toBeLessThanOrEqual(0);
  }).toPass();
}

const composerHeight = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      document
        .querySelector('[data-testid="pinned-resize-chat"] .chat-input-area')
        ?.getBoundingClientRect().height ?? 0,
  );

test.describe('a pinned transcript whose box shrinks', () => {
  test.use({ viewport: { width: 320, height: 640 }, colorScheme: 'light' });

  test('a transcript that fits, then a reconnect notice takes room from it, rests at its end', async ({
    page,
  }) => {
    await open(page, 'fits');
    await sizeBoxToContent(page);
    const before = await composerHeight(page);
    await page.getByTestId('pinned-resize-drop').click();
    await expect(page.locator('.chat-connection-notice')).toBeVisible();
    // The notice took room from the transcript, which now overflows.
    expect(await composerHeight(page)).toBeGreaterThan(before);
    await expectRestsAtEnd(page);
  });

  test('a transcript scrolled to its end, then a reconnect notice takes room from it, rests at its end', async ({
    page,
  }) => {
    await open(page, 'long');
    await pinToEnd(page);
    const before = await composerHeight(page);
    await page.getByTestId('pinned-resize-drop').click();
    await expect(page.locator('.chat-connection-notice')).toBeVisible();
    expect(await composerHeight(page)).toBeGreaterThan(before);
    await expectRestsAtEnd(page);
  });

  test('a person who scrolled up is not moved when the notice appears', async ({ page }) => {
    await open(page, 'long');
    await pinToEnd(page);
    const timeline = page.getByTestId('pinned-resize-chat').locator('.chat-timeline');
    await timeline.evaluate((element) => {
      element.scrollTop -= 240;
    });
    const scrolled = await rest(page);
    await page.getByTestId('pinned-resize-drop').click();
    await expect(page.locator('.chat-connection-notice')).toBeVisible();
    await expect(async () => {
      const now = await rest(page);
      expect(Math.abs(now.scrollTop - scrolled.scrollTop)).toBeLessThanOrEqual(1);
      expect(now.distanceToEnd).toBeGreaterThan(100);
    }).toPass();
  });
});

test.describe('a pinned transcript whose window is made smaller', () => {
  test.use({ viewport: { width: 375, height: 812 }, colorScheme: 'light' });

  test('a transcript that fits at 375 and overflows at 320 rests at its end', async ({ page }) => {
    await open(page, 'fits');
    await sizeBoxToContent(page);
    await page.setViewportSize({ width: 320, height: 640 });
    await expectRestsAtEnd(page);
  });

  test('a transcript scrolled to its end at 375 rests at its end at 320', async ({ page }) => {
    await open(page, 'long');
    await pinToEnd(page);
    await page.setViewportSize({ width: 320, height: 640 });
    await expectRestsAtEnd(page);
  });
});
