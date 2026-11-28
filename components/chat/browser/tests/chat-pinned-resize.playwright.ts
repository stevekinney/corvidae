import { FIXTURE_ORIGIN } from '@lostgradient/testing/browser/fixture-port';
import { environmentConfiguration } from '@lostgradient/testing/environment-configuration';
import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test, type Page } from '@playwright/test';

/**
 * COR-2725: where a transcript rests, whatever order its rows, its box and what it holds arrived in.
 * One rule, read from the layout as it is now: from its start, at the smallest scroll that puts the
 * end of its last row at the end of its reading box (its box less `scroll-padding-block-end`, where
 * the fade at its end begins), and 0 when the rows fit. The true end, with the clear space after the
 * last row, would push the start of a short conversation out of view. A transcript scrolled to its
 * true end is still followed, and rests there too at the next change. An empty welcome is never
 * scrolled. The default surface, whose fade is an overlay with no room kept clear, rests at its true
 * end.
 *
 * The `fits` cases draw the route's own sequence (Interborough chat states, "tool-only turn
 * reconnecting" at 320 by 640), on the surface Interborough draws: a turn that only called tools is
 * drawn, and its transcript fits its box, so it rests at scroll position 0. Then a notice mounts in
 * the composer and takes room from the transcript. No message arrives, and the notice changes
 * nothing in the transcript: the route's reconnect notice also stops an outcome row from being
 * drawn, which shrinks the content as the box shrinks, so the fixture's notice is a plain one. The
 * browser does not anchor a scroll position of 0, so only the box changing size can say the end
 * moved. A separate case keeps the default surface (an overlay fade, no room kept clear) at its
 * true end. The window made smaller (375 to 320 wide) is the same sequence with the content growing
 * instead. The `settles` cases are a row that grows after the last rest with no message and no change
 * to the box (a panel that sizes itself after it loads), and the same rows in the same box reached
 * four ways: they rest in one place whichever came first.
 *
 * A person who had scrolled up is the negative control: they are not moved.
 *
 * The fixture is `fixtures/chat.svelte` behind `?pinnedResize=fits`, `long`, `empty` or `settles`.
 *
 * Run: `bun run --cwd components/chat test:browser --grep "pinned transcript"`
 */
async function open(
  page: Page,
  mode: 'fits' | 'long' | 'empty' | 'settles',
  surface: 'transparent' | 'default' = 'transparent',
  options: { readonly settled?: boolean; readonly box?: number } = {},
): Promise<void> {
  const url = new URL(
    fixtureRoute('chat'),
    environmentConfiguration().browserFixtureUrl ?? FIXTURE_ORIGIN,
  );
  url.searchParams.set('pinnedResize', mode);
  // Interborough draws the transparent surface; `default` is Chat's own, whose fade is an overlay.
  if (surface === 'default') url.searchParams.set('surface', 'default');
  // `settles`: the panel under the rows has its full size from the start, and the chat's height.
  if (options.settled === true) url.searchParams.set('settled', '1');
  if (options.box !== undefined) url.searchParams.set('box', String(options.box));
  await page.goto(url.href);
  const chat = page.getByTestId('pinned-resize-chat');
  await expect(chat.locator('.chat-timeline')).toBeVisible();
  if (mode === 'empty') await expect(chat.locator('.chat-empty')).toBeVisible();
  else await expect(chat.getByText('Look up order 4471')).toBeVisible();
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

interface Painted {
  readonly scrollTop: number;
  /** How far the transcript can scroll in all. */
  readonly overflow: number;
  /** How far it is from the end of its scrollable area. */
  readonly distanceToEnd: number;
  /** How far the lowest thing drawn ends below where the end fade starts; at most 0 when clear. */
  readonly inFade: number;
  /** Where the first row starts, from the top of the transcript's box. */
  readonly firstRowTop: number;
}

/** Reads what is drawn, from one layout: not the rule's own formula. */
async function painted(page: Page): Promise<Painted> {
  return page.evaluate(() => {
    const timeline = document.querySelector<HTMLElement>(
      '[data-testid="pinned-resize-chat"] .chat-timeline',
    );
    if (timeline === null) throw new Error('The transcript is not on the page.');
    const box = timeline.getBoundingClientRect();
    // What is drawn: every element with no element inside it that holds text or is a picture.
    const drawn = [...timeline.querySelectorAll<Element>('*')].filter(
      (element) =>
        element.childElementCount === 0 &&
        element.closest('.cinder-sr-only, .chat-timeline-focus-label') === null &&
        element.getClientRects().length > 0 &&
        getComputedStyle(element).visibility === 'visible' &&
        ((element.textContent ?? '').trim() !== '' || element instanceof SVGElement),
    );
    if (drawn.length === 0) throw new Error('The transcript draws nothing.');
    const lowest = Math.max(...drawn.map((element) => element.getBoundingClientRect().bottom));
    const firstRow = [...timeline.children].find(
      (row) =>
        !row.classList.contains('chat-timeline-focus-label') &&
        row.getBoundingClientRect().height >= 0.5,
    );
    if (firstRow === undefined) throw new Error('The transcript has no row.');
    // The end edge fades over 1.5rem.
    return {
      scrollTop: timeline.scrollTop,
      overflow: timeline.scrollHeight - timeline.clientHeight,
      distanceToEnd: timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop,
      inFade: lowest - (box.bottom - 24),
      firstRowTop: firstRow.getBoundingClientRect().top - box.top,
    };
  });
}

/** Two frames, so the pin has had its chance before a position is read. */
async function settled(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

/**
 * Sizes the chat so the transcript's box is `spare` pixels taller than everything it holds: with two
 * pixels, the transcript fits at scroll position 0 and the first change that takes room from it
 * overflows.
 */
async function sizeBox(page: Page, spare: number): Promise<void> {
  await page.getByTestId('pinned-resize-chat').evaluate((chat, room) => {
    const timeline = chat.querySelector<HTMLElement>('.chat-timeline');
    const sentinel = chat.querySelector<HTMLElement>('.chat-bottom-sentinel');
    if (timeline === null || sentinel === null) throw new Error('The transcript is not drawn.');
    const padding = Number.parseFloat(getComputedStyle(timeline).paddingBottom);
    const contentEnd =
      sentinel.getBoundingClientRect().bottom -
      timeline.getBoundingClientRect().top +
      timeline.scrollTop +
      (Number.isFinite(padding) ? padding : 0);
    const now = timeline.clientHeight - contentEnd;
    const height = chat.getBoundingClientRect().height - now + room;
    (chat as HTMLElement).style.height = `${String(height)}px`;
  }, spare);
  // It fits: nothing scrolls, and the end is the start.
  await expect(async () => {
    const { scrollTop, overflow } = await painted(page);
    expect(scrollTop).toBe(0);
    expect(overflow).toBeLessThanOrEqual(0);
  }).toPass();
}

const composerHeight = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      document
        .querySelector('[data-testid="pinned-resize-chat"] .chat-input-area')
        ?.getBoundingClientRect().height ?? 0,
  );

/**
 * Takes room from the composer with a notice that changes nothing in the transcript. The route's
 * reconnect notice also stops an outcome row from being drawn, so the content shrinks as the box
 * does, and what each took could not be told apart: the box shrinking is what these cases are about.
 */
async function showNotice(page: Page): Promise<void> {
  await page.getByTestId('pinned-resize-notice').click();
  await expect(page.getByTestId('pinned-resize-notice-text')).toBeVisible();
}

/**
 * The panel under the rows takes its full size: a row grows with no message arriving and no change
 * to the transcript's box, as a panel does that sizes itself after it loads.
 */
async function settlePanel(page: Page): Promise<void> {
  await page.getByTestId('pinned-resize-settle').click();
  await expect(page.getByTestId('pinned-resize-panel-end')).toBeVisible();
}

/** Makes the chat `height` pixels tall: the transcript's box changes and nothing else does. */
async function setBox(page: Page, height: number): Promise<void> {
  await page.getByTestId('pinned-resize-chat').evaluate((chat, pixels) => {
    (chat as HTMLElement).style.height = `${String(pixels)}px`;
  }, height);
}

/** The transcript rests from its start with its last row clear: where the rule says, and no further. */
function expectStartSideRest(now: Painted): void {
  expect(now.overflow, 'the setup must overflow').toBeGreaterThan(2);
  expect(now.inFade).toBeLessThanOrEqual(1);
  expect(now.scrollTop).toBeGreaterThan(0);
  // Not at its true end: that would push the start of the conversation out of view.
  expect(now.distanceToEnd).toBeGreaterThanOrEqual(16);
}

test.describe('a pinned transcript whose box shrinks', () => {
  test.use({ viewport: { width: 320, height: 640 }, colorScheme: 'light' });

  test('a transcript that fits, then a notice takes room from it, rests with its last row clear and goes no further', async ({
    page,
  }) => {
    await open(page, 'fits');
    await sizeBox(page, 2);
    const before = await composerHeight(page);
    await showNotice(page);
    // The notice took room from the transcript, which now overflows.
    expect(await composerHeight(page)).toBeGreaterThan(before);
    await settled(page);
    const now = await painted(page);
    expect(now.overflow, 'the setup must overflow once the notice is drawn').toBeGreaterThan(2);
    expect(now.inFade).toBeLessThanOrEqual(1);
    expect(now.scrollTop).toBeGreaterThan(0);
    // Not at its true end: that would push the start of the conversation out of view.
    expect(now.distanceToEnd).toBeGreaterThanOrEqual(16);
  });

  test('a transcript whose rows still fit after the notice stays at its start', async ({
    page,
  }) => {
    // First pass: how much room the notice takes.
    await open(page, 'fits');
    const before = await composerHeight(page);
    await showNotice(page);
    const notice = (await composerHeight(page)) - before;
    expect(notice).toBeGreaterThan(24);

    // Second pass: the box holds the rows with the notice drawn, and only the end space overflows.
    await open(page, 'fits');
    await sizeBox(page, notice - 10);
    const start = await painted(page);
    await showNotice(page);
    await settled(page);
    const now = await painted(page);
    expect(
      now.overflow,
      'the setup must overflow by the 8 to 10 pixels the case assumes',
    ).toBeGreaterThanOrEqual(8);
    expect(now.scrollTop).toBe(0);
    expect(now.inFade).toBeLessThanOrEqual(1);
    expect(Math.abs(now.firstRowTop - start.firstRowTop)).toBeLessThanOrEqual(1);
  });

  test('on the default surface, whose fade is an overlay, a transcript that fits rests at its true end', async ({
    page,
  }) => {
    await open(page, 'fits', 'default');
    await sizeBox(page, 2);
    await showNotice(page);
    await settled(page);
    const now = await painted(page);
    expect(now.overflow, 'the setup must overflow once the notice is drawn').toBeGreaterThan(2);
    // The overlay leaves no room kept clear, so the last row rests where the overlay is off.
    expect(now.scrollTop).toBeGreaterThan(0);
    expect(now.distanceToEnd).toBeLessThanOrEqual(1);
  });

  test('an empty welcome whose box shrinks stays at its start', async ({ page }) => {
    await open(page, 'empty');
    const welcome = await painted(page);
    expect(welcome.overflow).toBeLessThanOrEqual(0);
    await page.getByTestId('pinned-resize-chat').evaluate((chat) => {
      const composer = chat.querySelector('.chat-input-area');
      if (composer === null) throw new Error('No composer.');
      (chat as HTMLElement).style.height =
        `${String(composer.getBoundingClientRect().height + 120)}px`;
    });
    await settled(page);
    const now = await painted(page);
    // The welcome no longer fits, and it is still shown from its start.
    expect(now.overflow).toBeGreaterThanOrEqual(16);
    expect(now.scrollTop).toBe(0);
  });

  test('a panel that sizes itself after the last rest is rested again, with no message and no change to the box', async ({
    page,
  }) => {
    await open(page, 'settles');
    await sizeBox(page, 2);
    await settlePanel(page);
    await settled(page);
    expectStartSideRest(await painted(page));
  });

  test('the same rows in the same box rest in one place, whichever arrived first', async ({
    page,
  }) => {
    // The box: 120 pixels shorter than everything the transcript holds once the panel has its size.
    await open(page, 'settles', 'transparent', { settled: true });
    const box = await page.getByTestId('pinned-resize-chat').evaluate((chat) => {
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
      return Math.round(chat.getBoundingClientRect().height - spare - 120);
    });
    const rests: number[] = [];
    const rested = async (): Promise<void> => {
      await settled(page);
      const now = await painted(page);
      expectStartSideRest(now);
      rests.push(now.scrollTop);
    };

    // The rows and the box are there from the start.
    await open(page, 'settles', 'transparent', { settled: true, box });
    await rested();

    // The panel sizes itself after the transcript was first rested, in the same box.
    await open(page, 'settles', 'transparent', { box });
    await settled(page);
    await settlePanel(page);
    await rested();

    // The box shrinks while the panel has not sized itself, and it sizes itself after.
    await open(page, 'settles');
    await setBox(page, box);
    await settled(page);
    await settlePanel(page);
    await rested();

    // The panel sizes itself, and then the box shrinks.
    await open(page, 'settles');
    await settlePanel(page);
    await settled(page);
    await setBox(page, box);
    await rested();

    expect(Math.max(...rests) - Math.min(...rests)).toBeLessThanOrEqual(1);
  });

  test('a transcript scrolled to its end, then a reconnect notice takes room from it, rests with its last row clear', async ({
    page,
  }) => {
    await open(page, 'long');
    await pinToEnd(page);
    const before = await composerHeight(page);
    await page.getByTestId('pinned-resize-drop').click();
    await expect(page.locator('.chat-connection-notice')).toBeVisible();
    expect(await composerHeight(page)).toBeGreaterThan(before);
    // Nothing remembers that it was scrolled to its true end: it rests where every transcript does.
    await settled(page);
    expectStartSideRest(await painted(page));
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

  test('a transcript that fits at 375 and overflows at 320 rests with its last row clear and goes no further', async ({
    page,
  }) => {
    await open(page, 'fits');
    await sizeBox(page, 2);
    await page.setViewportSize({ width: 320, height: 640 });
    await settled(page);
    const now = await painted(page);
    expect(now.overflow).toBeGreaterThan(2);
    expect(now.inFade).toBeLessThanOrEqual(1);
    expect(now.scrollTop === 0 || now.distanceToEnd >= 16).toBe(true);
  });

  test('a transcript scrolled to its end at 375 rests with its last row clear at 320', async ({
    page,
  }) => {
    await open(page, 'long');
    await pinToEnd(page);
    await page.setViewportSize({ width: 320, height: 640 });
    await settled(page);
    expectStartSideRest(await painted(page));
  });
});
