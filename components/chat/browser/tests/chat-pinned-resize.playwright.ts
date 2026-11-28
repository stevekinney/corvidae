import { FIXTURE_ORIGIN } from '@lostgradient/testing/browser/fixture-port';
import { environmentConfiguration } from '@lostgradient/testing/environment-configuration';
import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { freezePageTimers } from '@lostgradient/testing/playwright/page-timers';
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
 * The `approval` cases are a waiting approval, which Chat places by its own rule while the pin
 * stands aside: the rows before the card take their final size after the card was placed (their
 * styles land a frame after they are drawn, as Interborough's do), and the card is placed again in
 * the frame they do, so no frame is painted with the rows settled and the card where the rows
 * before them had left it. The page's timers are stopped for those cases (`freezePageTimers`), as
 * a design-review capture's clock holds them: a placement that waited for an animation frame would
 * never come.
 *
 * The last cases are a reply that streams, chunk by chunk, after Jump to latest.
 *
 * The fixture is `fixtures/chat.svelte` behind `?pinnedResize=fits`, `long`, `empty`, `settles` or
 * `approval`.
 *
 * Run: `bun run --cwd components/chat test:browser --grep "pinned transcript"`
 */
async function open(
  page: Page,
  mode: 'fits' | 'long' | 'empty' | 'settles' | 'approval',
  surface: 'transparent' | 'default' = 'transparent',
  options: {
    readonly settled?: boolean;
    readonly box?: number;
    /** What each of the person's messages gains, in pixels, when the rows settle. */
    readonly grow?: number;
    /** A header laid over the transcript's start, in pixels, and what it becomes when the rows settle. */
    readonly inset?: number;
    readonly insetSettled?: number;
    /** The rows have their final size from the start. */
    readonly rowsSettled?: boolean;
    /** The run is still going, so the turn draws no outcome yet: a reply can stream after it. */
    readonly running?: boolean;
  } = {},
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
  if (options.grow !== undefined) url.searchParams.set('grow', String(options.grow));
  if (options.inset !== undefined) url.searchParams.set('inset', String(options.inset));
  if (options.insetSettled !== undefined) {
    url.searchParams.set('insetSettled', String(options.insetSettled));
  }
  if (options.rowsSettled === true) url.searchParams.set('rowsSettled', '1');
  if (options.running === true) url.searchParams.set('running', '1');
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

/**
 * What the `settles` fixture's last row (the panel in the trailing slot, with no padding of its own)
 * leaves between the rest and the true end. The true end is 45 past the row's end: the row gap of 8,
 * the sentinel of 1 and the transcript's end padding of 36 (12 and the fade's 24). The rest puts the
 * row's end on the reading box's end, 32 above the box's end (8 of scroll padding and the fade's 24).
 * So a transcript at its rest is 45 - 32 = 13 short of its true end, not at it.
 */
const SETTLES_DISTANCE_TO_END = 45 - 32;

/**
 * The transcript rests from its start with its last row clear: where the rule says, and no further.
 * `distanceToEnd` is how far short of its true end the rule's position is: at least 16 where the last
 * row is an outcome anchor or a tool row (they keep padding of their own, which the row's end
 * excludes), or the given number, within 2 pixels, where the layout says exactly.
 */
function expectStartSideRest(now: Painted, distanceToEnd?: number): void {
  expect(now.overflow, 'the setup must overflow').toBeGreaterThan(2);
  expect(now.inFade).toBeLessThanOrEqual(1);
  expect(now.scrollTop).toBeGreaterThan(0);
  // Not at its true end: that would push the start of the conversation out of view.
  if (distanceToEnd === undefined) {
    expect(now.distanceToEnd).toBeGreaterThanOrEqual(16);
  } else {
    expect(Math.abs(now.distanceToEnd - distanceToEnd)).toBeLessThanOrEqual(2);
  }
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
    expectStartSideRest(await painted(page), SETTLES_DISTANCE_TO_END);
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
      expectStartSideRest(now, SETTLES_DISTANCE_TO_END);
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

/**
 * Two frames laid out and painted, heard with a `ResizeObserver` and never with an animation frame:
 * the page's clock may own those, and be stopped. Each observation is its own evaluation, so the
 * second is never made inside the first's callback.
 */
async function paintedFrames(page: Page): Promise<void> {
  for (let frame = 0; frame < 2; frame += 1) {
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const observer = new ResizeObserver(() => {
            observer.disconnect();
            resolve();
          });
          observer.observe(document.documentElement);
        }),
    );
  }
}

interface Placed {
  readonly scrollTop: number;
  /** How far the transcript can scroll in all. */
  readonly overflow: number;
  /** How far it is from the end of its scrollable area. */
  readonly distanceToEnd: number;
  /** Where the waiting approval's card starts and ends, from the top of the transcript's box. */
  readonly cardTop: number;
  readonly cardBottom: number;
  /** The height of the chat, which a second page is given to reach the same box. */
  readonly chatHeight: number;
}

/** Reads where the waiting approval stands, from one layout. */
async function placed(page: Page): Promise<Placed> {
  return page.getByTestId('pinned-resize-chat').evaluate((chat) => {
    const timeline = chat.querySelector<HTMLElement>('.chat-timeline');
    const card = chat.querySelector<HTMLElement>(
      '.cinder-approval-card[data-cinder-state="pending"]',
    );
    if (timeline === null || card === null) throw new Error('No approval waits in the transcript.');
    const box = timeline.getBoundingClientRect();
    const cardBox = card.getBoundingClientRect();
    return {
      scrollTop: timeline.scrollTop,
      overflow: timeline.scrollHeight - timeline.clientHeight,
      distanceToEnd: timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop,
      cardTop: cardBox.top - box.top,
      cardBottom: cardBox.bottom - box.top,
      chatHeight: chat.getBoundingClientRect().height,
    };
  });
}

/** How far the transcript is from the end of its scrollable area, now. */
async function distanceToEnd(page: Page): Promise<number> {
  const now = await placed(page);
  return now.distanceToEnd;
}

/** How far the transcript is from its start, now. */
async function scrolledTo(page: Page): Promise<number> {
  const now = await placed(page);
  return now.scrollTop;
}

/**
 * The rows before the card take their final size: their styles land. Nothing is added to the
 * transcript or taken from it, and the press is made with no pointer, so nothing is the person's.
 */
async function settleRows(page: Page): Promise<void> {
  await page.getByTestId('pinned-resize-rows').dispatchEvent('click');
}

test.describe('a waiting approval whose rows settle after it was placed', () => {
  test.use({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });

  test('rows and the header inset that settle late place the card again in that frame, with the clock stopped (thirty tool calls, 1280)', async ({
    page,
  }) => {
    // What the route's log shows at 1280 by 1100: the transcript overflows when the card is first
    // placed (by 47 there), and then the rows above the card and the room the header takes grow
    // (by 70 there: the header inset by 32 and the rows by 39).
    const layout = { box: 480, inset: 28, insetSettled: 60, grow: 39 } as const;
    // What the page reports as an error: a placement made in an observer's callback must not
    // change the layout the observer is being told about (a ResizeObserver loop).
    await page.addInitScript(() => {
      const reported: string[] = [];
      (globalThis as unknown as { pinnedErrors: string[] }).pinnedErrors = reported;
      window.addEventListener('error', (event) => {
        reported.push(event.message);
      });
    });
    const reportedErrors = (): Promise<string[]> =>
      page.evaluate(() => (globalThis as unknown as { pinnedErrors: string[] }).pinnedErrors);
    await open(page, 'approval', 'transparent', layout);
    // Placed at the transcript's end, which comes before the card's top reaches the header's line.
    await expect.poll(() => distanceToEnd(page)).toBeLessThanOrEqual(1);
    const first = await placed(page);
    expect(first.overflow, 'the setup must overflow before the rows settle').toBeGreaterThan(2);
    expect(first.scrollTop).toBeGreaterThan(0);

    // No animation frame runs from here on.
    await freezePageTimers(page);
    await settleRows(page);
    await paintedFrames(page);
    const late = await placed(page);
    expect(
      late.overflow - first.overflow,
      'the rows and the inset must have grown',
    ).toBeGreaterThan(60);
    // At the rule's position, the new end, in the frames painted since: not where the rows before
    // them had left it, the whole growth short of the end.
    expect(late.distanceToEnd).toBeLessThanOrEqual(1);
    expect(await reportedErrors()).toEqual([]);

    // The same rows, there in full before the card was first placed, rest in the same place.
    await page.clock.resume();
    await open(page, 'approval', 'transparent', { ...layout, rowsSettled: true });
    await expect.poll(() => distanceToEnd(page)).toBeLessThanOrEqual(1);
    const settledFirst = await placed(page);
    expect(Math.abs(late.scrollTop - settledFirst.scrollTop)).toBeLessThanOrEqual(1);
    expect(Math.abs(late.cardTop - settledFirst.cardTop)).toBeLessThanOrEqual(1);
  });

  test('rows that only gain border, with nothing else changing, place the card again', async ({
    page,
  }) => {
    // Nothing the placement watches changes: not the transcript's box, not the card, no node. Only
    // the border box of a row before the card does, which the pin watches and tells it of.
    const layout = { box: 440, grow: 70 } as const;
    await open(page, 'approval', 'transparent', layout);
    await expect.poll(() => distanceToEnd(page)).toBeLessThanOrEqual(1);
    const first = await placed(page);
    expect(first.overflow, 'the setup must overflow before the rows settle').toBeGreaterThan(2);
    await settleRows(page);
    await paintedFrames(page);
    await settled(page);
    const late = await placed(page);
    expect(Math.abs(late.overflow - first.overflow - 70)).toBeLessThanOrEqual(1);
    expect(late.distanceToEnd).toBeLessThanOrEqual(1);
  });

  test('a person who scrolled up is not moved when the rows settle', async ({ page }) => {
    // A shorter box, so the card rests well away from the transcript's start.
    const layout = { box: 330, inset: 28, insetSettled: 60, grow: 39 } as const;
    await open(page, 'approval', 'transparent', layout);
    await expect.poll(() => scrolledTo(page)).toBeGreaterThan(150);
    await settled(page);
    const first = await placed(page);
    const timeline = page.getByTestId('pinned-resize-chat').locator('.chat-timeline');
    await timeline.hover();
    await page.mouse.wheel(0, -120);
    await expect.poll(() => scrolledTo(page)).toBeLessThanOrEqual(first.scrollTop - 100);
    await settled(page);
    const taken = await placed(page);
    // Neither the transcript's start nor its end: somewhere only a person would leave it.
    expect(taken.scrollTop).toBeGreaterThan(20);
    expect(taken.distanceToEnd).toBeGreaterThan(100);
    await settleRows(page);
    await paintedFrames(page);
    await settled(page);
    expect(Math.abs((await scrolledTo(page)) - taken.scrollTop)).toBeLessThanOrEqual(1);
  });
});

test.describe('a waiting approval in a transcript that fitted whole when it was placed', () => {
  test.use({ viewport: { width: 768, height: 900 }, colorScheme: 'light' });

  test("rows that settle late and make it overflow by a few pixels rest it at the rule's position, with the clock stopped (list beside the chat, 768)", async ({
    page,
  }) => {
    // What the route's log shows at 768 by 900: everything fits when the card is first placed, so
    // it rests at 0; then the rows grow by 55 and the header inset shrinks by 10, and the
    // transcript holds 11 more than its box.
    const layout = { inset: 40, insetSettled: 30, grow: 55 } as const;
    await open(page, 'approval', 'transparent', layout);
    // 34 to spare: the 45 the rows and the inset come to leaves 11 over.
    await sizeBox(page, 34);
    const first = await placed(page);
    expect(first.scrollTop).toBe(0);

    await freezePageTimers(page);
    await settleRows(page);
    await paintedFrames(page);
    const late = await placed(page);
    expect(Math.abs(late.overflow - 11), 'the setup must overflow by 11').toBeLessThanOrEqual(1);
    // The end is 11 away and the card is whole there: it rests 11 from its start, not at 0.
    expect(Math.abs(late.scrollTop - 11)).toBeLessThanOrEqual(1);

    await page.clock.resume();
    await open(page, 'approval', 'transparent', {
      ...layout,
      rowsSettled: true,
      box: Math.round(first.chatHeight),
    });
    await expect.poll(() => distanceToEnd(page)).toBeLessThanOrEqual(1);
    const settledFirst = await placed(page);
    expect(Math.abs(late.scrollTop - settledFirst.scrollTop)).toBeLessThanOrEqual(1);
    expect(Math.abs(late.cardTop - settledFirst.cardTop)).toBeLessThanOrEqual(1);
  });
});

/** How far the last drawn row's end is from the end of the reading box: 0 where a transcript rests. */
async function lastRowEndFromReadingEnd(page: Page): Promise<number> {
  return page
    .getByTestId('pinned-resize-chat')
    .locator('.chat-timeline')
    .evaluate((element) => {
      let row = element.lastElementChild;
      while (
        row !== null &&
        (row.classList.contains('chat-bottom-sentinel') || row.getBoundingClientRect().height < 0.5)
      ) {
        row = row.previousElementSibling;
      }
      if (row === null) throw new Error('The transcript has no row.');
      const padding = Number.parseFloat(getComputedStyle(row).paddingBottom);
      const rowEnd = row.getBoundingClientRect().bottom - (Number.isFinite(padding) ? padding : 0);
      const scrollPadding = Number.parseFloat(getComputedStyle(element).scrollPaddingBottom);
      const readingEnd =
        element.getBoundingClientRect().bottom -
        (Number.isFinite(scrollPadding) ? scrollPadding : 0);
      return rowEnd - readingEnd;
    });
}

for (const viewport of [
  { width: 320, height: 640 },
  { width: 1280, height: 800 },
]) {
  test.describe(`a reply that streams after Jump to latest, at ${String(viewport.width)} by ${String(viewport.height)}`, () => {
    test.use({ viewport, colorScheme: 'light' });

    test('moves the transcript on and never back, and its last row ends on the end of the reading box', async ({
      page,
    }) => {
      await open(page, 'long', 'transparent', { running: true });
      const chat = page.getByTestId('pinned-resize-chat');
      const timeline = chat.locator('.chat-timeline');
      await expect
        .poll(async () => Math.abs(await lastRowEndFromReadingEnd(page)))
        .toBeLessThanOrEqual(1);

      // The person wheels up to read what came before, and Jump to latest is offered.
      await timeline.hover();
      await page.mouse.wheel(0, -600);
      const jump = chat.locator('.chat-jump-button');
      await expect(jump).toBeVisible();
      await jump.click();
      // It lands on the rest. The band the control floated in goes back to the transcript, which
      // is rested once more in the taller box: the series starts from there.
      await expect(jump).toBeHidden();
      await expect
        .poll(async () => Math.abs(await lastRowEndFromReadingEnd(page)))
        .toBeLessThanOrEqual(1);
      await settled(page);
      const landed = await painted(page);
      const start = landed.scrollTop;
      expect(start).toBeGreaterThan(0);

      // Every position the transcript takes from here on, as the browser reports each scroll.
      await timeline.evaluate((element) => {
        const tops: number[] = [element.scrollTop];
        element.addEventListener('scroll', () => tops.push(element.scrollTop), { passive: true });
        (globalThis as unknown as { pinnedTops: number[] }).pinnedTops = tops;
      });

      const rests: number[] = [start];
      for (let chunk = 1; chunk <= 5; chunk += 1) {
        await page.getByTestId('pinned-resize-stream').click();
        await expect(chat.getByText(`Part ${String(chunk)}:`)).toBeVisible();
        await settled(page);
        const now = await painted(page);
        // The reply's end is on the end of the reading box, clear of the fade, after every chunk.
        expect(
          Math.abs(await lastRowEndFromReadingEnd(page)),
          `chunk ${String(chunk)}`,
        ).toBeLessThanOrEqual(1);
        expect(now.inFade, `chunk ${String(chunk)}`).toBeLessThanOrEqual(1);
        // Not at its true end: Jump to latest claimed nothing for the person.
        expect(now.distanceToEnd, `chunk ${String(chunk)}`).toBeGreaterThanOrEqual(8);
        rests.push(now.scrollTop);
      }
      // The reply streamed past the end of the box: every chunk moved the transcript on.
      for (let index = 1; index < rests.length; index += 1) {
        expect(rests[index]!, `chunk ${String(index)}`).toBeGreaterThan(rests[index - 1]!);
      }
      // And it never went back, at any scroll in between.
      const tops = await page.evaluate(
        () => (globalThis as unknown as { pinnedTops: number[] }).pinnedTops,
      );
      expect(tops.length).toBeGreaterThan(5);
      for (let index = 1; index < tops.length; index += 1) {
        expect(tops[index]!, `scroll ${String(index)}`).toBeGreaterThanOrEqual(tops[index - 1]!);
      }
    });
  });
}
