import { expect, type Page } from '@playwright/test';

export const FIRST_INTERACTIVE = '.cinder-steps li.cinder-steps__item a.cinder-steps__interactive';
export type StepGeometry = {
  matchesFocusVisible: boolean;
  anchor: { top: number; bottom: number; left: number; right: number; width: number };
  marker: { top: number; bottom: number; left: number; right: number; centerX: number };
  connector: { top: number; bottom: number; left: number; right: number } | null;
  nav: { width: number };
  markerSizePx: number;
  ringOutsetPx: number;
};

function measureRingOutset(boxShadow: string): number {
  if (!boxShadow || boxShadow === 'none') return 0;
  return Math.max(
    0,
    ...boxShadow.split(/,(?![^(]*\))/).map((layer) => {
      if (/\binset\b/.test(layer)) return 0;
      const lengths = [...layer.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((match) =>
        Number.parseFloat(match[1] ?? '0'),
      );
      if (lengths.length < 2) return 0;
      return (lengths[3] ?? 0) + Math.max(Math.abs(lengths[0] ?? 0), Math.abs(lengths[1] ?? 0));
    }),
  );
}
/** Reset focus to the body so a subsequent Tab walk is deterministic. */
export async function resetFocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    document.body.focus();
  });
}

/**
 * Walk Tab (capped) until the first interactive step is the active element, then
 * read the geometry of the focused anchor, its sibling marker, and connector.
 */
export async function tabToFirstInteractiveStep(page: Page): Promise<StepGeometry> {
  await resetFocus(page);

  const isLanded = () =>
    page.evaluate((selector) => {
      const anchor = document.querySelector(selector);
      return anchor instanceof HTMLElement && anchor === document.activeElement;
    }, FIRST_INTERACTIVE);

  let landed = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await page.keyboard.press('Tab');
    if (await isLanded()) {
      landed = true;
      break;
    }
  }
  expect(landed, 'Tab walk never reached the first interactive step').toBe(true);

  const geometry = await page.evaluate((selector) => {
    const anchor = document.querySelector(selector);
    if (!(anchor instanceof HTMLElement)) throw new Error(`No anchor ${selector}`);
    const li = anchor.closest('li.cinder-steps__item');
    if (!(li instanceof HTMLElement)) throw new Error('No owning li');
    const marker = li.querySelector('.cinder-steps__marker');
    if (!(marker instanceof HTMLElement)) throw new Error('No marker in li');
    const nav = anchor.closest('nav.cinder-steps');
    if (!(nav instanceof HTMLElement)) throw new Error('No nav.cinder-steps');
    const connectorEl = li.querySelector('.cinder-steps__connector');

    const anchorRect = anchor.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    const navRect = nav.getBoundingClientRect();
    const connectorRect =
      connectorEl instanceof HTMLElement ? connectorEl.getBoundingClientRect() : null;

    const styles = getComputedStyle(anchor);
    const markerSizeRaw = getComputedStyle(nav).getPropertyValue('--_marker-size').trim();
    // --_marker-size is authored in rem; resolve to px via the root font size.
    const rootFontSize =
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const markerSizePx = markerSizeRaw.endsWith('rem')
      ? Number.parseFloat(markerSizeRaw) * rootFontSize
      : Number.parseFloat(markerSizeRaw);

    return {
      matchesFocusVisible: anchor.matches(':focus-visible'),
      anchor: {
        top: anchorRect.top,
        bottom: anchorRect.bottom,
        left: anchorRect.left,
        right: anchorRect.right,
        width: anchorRect.width,
      },
      marker: {
        top: markerRect.top,
        bottom: markerRect.bottom,
        left: markerRect.left,
        right: markerRect.right,
        centerX: markerRect.left + markerRect.width / 2,
      },
      connector: connectorRect
        ? {
            top: connectorRect.top,
            bottom: connectorRect.bottom,
            left: connectorRect.left,
            right: connectorRect.right,
          }
        : null,
      nav: { width: navRect.width },
      markerSizePx,
      boxShadow: styles.boxShadow,
    };
  }, FIRST_INTERACTIVE);
  return { ...geometry, ringOutsetPx: measureRingOutset(geometry.boxShadow) };
}
