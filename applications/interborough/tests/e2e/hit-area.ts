import type { Locator } from '@playwright/test';

/**
 * How tall a control is to a finger: the larger of its painted height and its hit area's. A compact
 * control paints small and carries an invisible 44px hit area, a positioned `::before` that takes no
 * space, and only a coarse pointer (a touch context) switches it on. Stacked controls' hit areas
 * overlap, so this reads the pseudo-element's own height instead of scanning for the points that
 * reach the control.
 */
export async function touchHeight(control: Locator): Promise<number> {
  return control.evaluate((element) => {
    const hitArea = getComputedStyle(element, '::before');
    const hitAreaHeight =
      hitArea.position === 'absolute' ? Number.parseFloat(hitArea.height) || 0 : 0;
    return Math.max(element.getBoundingClientRect().height, hitAreaHeight);
  });
}
