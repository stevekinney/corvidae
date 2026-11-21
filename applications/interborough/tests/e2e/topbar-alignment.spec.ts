/**
 * The top bar's items share one centre line, and its single-line words are not clipped (COR-2438,
 * owner review 2026-11-19). On a plain title page (/chats, /agents) the title's words and the search
 * field's words sit on one centre line, measured on the text's own line box; on an open chat the
 * breadcrumb select is as tall as the search field and centres with it and the bell. The search
 * field's words ("Search everything") are not cut: the label's line box holds the descender.
 * Checked at 1280 and 1920 pixels.
 */
import type { Page } from '@playwright/test';

import { openStatesChat } from './chat-states-support.ts';
import { expect, test } from './fixtures.ts';

/** Every centre and size the cases compare, read in one pass. */
async function readTopbar(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector('.weft-shell-topbar');
    if (bar === null) return undefined;
    /** The centre of the first line box of `element`'s words. */
    const textCentre = (element: Element | null): number | undefined => {
      if (element === null) return undefined;
      const range = document.createRange();
      range.selectNodeContents(element);
      const first = [...range.getClientRects()].find((rect) => rect.height > 0);
      return first === undefined ? undefined : first.top + first.height / 2;
    };
    const boxOf = (element: Element | null) => {
      if (element === null) return undefined;
      const box = element.getBoundingClientRect();
      return { centre: box.top + box.height / 2, height: box.height };
    };
    const search = bar.querySelector('.weft-shell-search-trigger');
    const searchLabel = bar.querySelector('.weft-shell-search-trigger__label');
    const select = bar.querySelector('.cinder-breadcrumbs__trigger');
    const plainTitle = bar.querySelector('.cinder-breadcrumbs__current:not(button)');
    const icons = [...bar.querySelectorAll('button.weft-shell-topbar-control')]
      .filter((button) => !button.classList.contains('weft-shell-search-trigger'))
      .map((button) => ({
        name: button.getAttribute('aria-label') ?? '',
        ...boxOf(button)!,
      }));
    // Every clipping single-line box in the bar: its scroll height is not past its client height,
    // and its words' line box is inside it (a descender cut by `overflow: hidden` fails this).
    const clipped = [...bar.querySelectorAll<HTMLElement>('*')]
      .filter((element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        // Words kept only for a screen reader are a 1px box by design, not clipped words.
        return (
          box.height > 1 &&
          box.width > 1 &&
          style.whiteSpace === 'nowrap' &&
          (style.overflowY === 'hidden' || style.overflowY === 'clip') &&
          [...element.childNodes].some(
            (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim() !== '',
          )
        );
      })
      .flatMap((element) => {
        const box = element.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(element);
        const words = [...range.getClientRects()].filter((rect) => rect.height > 0);
        const top = Math.min(...words.map((rect) => rect.top));
        const bottom = Math.max(...words.map((rect) => rect.bottom));
        const style = getComputedStyle(element);
        // Two Cinder boxes clip on purpose past their line box, so their line box and scroll
        // height say nothing about the words: a crumb link clips at its hit area's overhang
        // (`overflow-clip-margin`, the pseudo-element's 24px target past its 20px line), and a
        // `text-box-trim`med label is trimmed to its capitals, with block padding for the
        // ascenders and descenders that its negative margin hands back.
        const clipsPastItsBox = style.getPropertyValue('overflow-clip-margin') !== '0px';
        const trimmed = !['', 'none', 'normal'].includes(style.getPropertyValue('text-box-trim'));
        const cut =
          (!clipsPastItsBox && !trimmed && element.scrollHeight > element.clientHeight) ||
          (!trimmed && (top < box.top - 0.5 || bottom > box.bottom + 0.5));
        return cut
          ? [
              `${element.className}: words ${top}-${bottom}, box ${box.top}-${box.bottom}, scroll ${element.scrollHeight} of ${element.clientHeight}`,
            ]
          : [];
      });
    return {
      search: boxOf(search),
      searchWords: textCentre(searchLabel),
      select: boxOf(select),
      selectWords: textCentre(select?.querySelector('.cinder-breadcrumbs__trigger-label') ?? null),
      titleWords: textCentre(plainTitle),
      icons,
      clipped,
    };
  });
}

for (const width of [1280, 1920]) {
  for (const path of ['/chats', '/agents']) {
    test(`centres a plain title's words on the search field's words on ${path}, at ${width} pixels`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(path);
      await expect(page.locator('.weft-shell-topbar .cinder-breadcrumbs__current')).toBeVisible();
      const read = await readTopbar(page);
      expect(read).toBeDefined();
      expect(read!.titleWords).toBeDefined();
      expect(read!.searchWords).toBeDefined();
      expect(Math.abs(read!.titleWords! - read!.searchWords!)).toBeLessThanOrEqual(1);
      for (const icon of read!.icons) {
        expect(Math.abs(icon.centre - read!.search!.centre), icon.name).toBeLessThanOrEqual(1);
      }
      expect(read!.clipped).toEqual([]);
    });
  }

  test(`centres the breadcrumb select, the search field and the bell, the select as tall as the field, at ${width} pixels`, async ({
    page,
    request,
  }) => {
    await openStatesChat(page, request, 'discover-agents');
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator('.weft-shell-topbar .cinder-breadcrumbs__trigger')).toBeVisible();
    const read = await readTopbar(page);
    expect(read).toBeDefined();
    expect(read!.select).toBeDefined();
    expect(read!.search).toBeDefined();
    expect(Math.abs(read!.select!.centre - read!.search!.centre)).toBeLessThanOrEqual(1);
    expect(Math.abs(read!.select!.height - read!.search!.height)).toBeLessThanOrEqual(0.5);
    const bell = read!.icons.find((icon) => icon.name.startsWith('Notifications'));
    expect(bell).toBeDefined();
    expect(Math.abs(bell!.centre - read!.search!.centre)).toBeLessThanOrEqual(1);
    expect(Math.abs(read!.selectWords! - read!.searchWords!)).toBeLessThanOrEqual(1);
    expect(read!.clipped).toEqual([]);
  });
}
