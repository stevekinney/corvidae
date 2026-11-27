import { FIXTURE_ORIGIN } from '@lostgradient/testing/browser/fixture-port';
import { environmentConfiguration } from '@lostgradient/testing/environment-configuration';
import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test, type Page } from '@playwright/test';

/**
 * COR-2725: a transcript pinned to its end stays at its end when its box shrinks with no message
 * arriving. Two sources of a shrink, one guard: a reconnect notice that grows the composer, and a
 * window made smaller (375 to 320 wide). After either settles, the last visible row ends at or
 * above the transcript's reading box (its box less `scroll-padding-block-end`, where the fade at
 * its end begins), and the transcript is scrolled to the end of its scrollable area. A person who
 * had scrolled up is the negative control: they are not moved.
 *
 * The fixture is `fixtures/chat.svelte` behind `?pinnedResize=1`.
 *
 * Run: `bun run --cwd components/chat test:browser --grep "pinned transcript"`
 */
async function open(page: Page): Promise<void> {
  const url = new URL(
    fixtureRoute('chat'),
    environmentConfiguration().browserFixtureUrl ?? FIXTURE_ORIGIN,
  );
  url.searchParams.set('pinnedResize', '1');
  await page.goto(url.href);
  await expect(page.getByTestId('pinned-resize-chat').locator('.chat-timeline')).toBeVisible();
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

test.describe('a pinned transcript whose box shrinks', () => {
  test.use({ viewport: { width: 320, height: 640 }, colorScheme: 'light' });

  test('a reconnect notice that appears in the composer leaves the last row clear of the end', async ({
    page,
  }) => {
    await open(page);
    await pinToEnd(page);
    const before = await page.evaluate(
      () =>
        document
          .querySelector('[data-testid="pinned-resize-chat"] .chat-input-area')
          ?.getBoundingClientRect().height ?? 0,
    );
    await page.getByTestId('pinned-resize-drop').click();
    await expect(page.locator('.chat-connection-notice')).toBeVisible();
    // The notice took room from the transcript: the box is shorter than it was.
    const after = await page.evaluate(
      () =>
        document
          .querySelector('[data-testid="pinned-resize-chat"] .chat-input-area')
          ?.getBoundingClientRect().height ?? 0,
    );
    expect(after).toBeGreaterThan(before);
    await expectRestsAtEnd(page);
  });

  test('a person who scrolled up is not moved when the notice appears', async ({ page }) => {
    await open(page);
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

  test('375 to 320 wide leaves the last row clear of the end', async ({ page }) => {
    await open(page);
    await pinToEnd(page);
    await page.setViewportSize({ width: 320, height: 640 });
    await expectRestsAtEnd(page);
  });
});
