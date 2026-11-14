import type { Locator } from '@playwright/test';

export type CloseButtonMeasurement = {
  width: number;
  height: number;
  headerHeight: number;
  /** The sides on which a tap 21.5 pixels from the center still lands on the button. */
  reached: string[];
};

/**
 * Measures the LinkPopover close button under a touch screen: the painted face (its layout box),
 * the header it sits in, and which sides of its center a tap 21.5 pixels away (the edge of a 44px
 * hit area) still reaches the button. The hit area takes no layout, so it is probed, not measured.
 */
export async function measureCloseButton(close: Locator): Promise<CloseButtonMeasurement> {
  return close.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const header = element.closest('.link-popover-header')!.getBoundingClientRect();
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    const reached = (
      [
        ['left', centerX - 21.5, centerY],
        ['right', centerX + 21.5, centerY],
        ['above', centerX, centerY - 21.5],
        ['below', centerX, centerY + 21.5],
      ] as const
    ).filter(([, x, y]) => element.contains(document.elementFromPoint(x, y)));
    return {
      width: rect.width,
      height: rect.height,
      headerHeight: header.height,
      reached: reached.map(([side]) => side),
    };
  });
}
