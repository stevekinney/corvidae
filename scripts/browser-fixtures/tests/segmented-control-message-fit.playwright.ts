/// <reference lib="dom" />
/**
 * A SegmentedControl with a description or an error keeps to the room it has. In a 280px container
 * on a 320px phone the options do not fit, so the control stacks as a radio list, and its message
 * wraps inside the container: nothing runs past the container's box or is cut off. (The frame drawn
 * around a control with a message once had an automatic minimum width in a grid cell, grew to the
 * options' unwrapped width, and so measured room it did not have and never stacked.)
 */

import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test } from '@playwright/test';

for (const fixtureName of ['described-narrow', 'error-narrow'] as const) {
  test(`${fixtureName}: the control stacks and the message stays inside a 280px container at 320px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(fixtureRoute('segmented-control', { fixtureName }), { waitUntil: 'load' });
    await page.locator('[data-testid="narrow-container"]').waitFor({ state: 'visible' });
    const read = await page.evaluate(() => {
      const box = (element: Element | null) => {
        if (element === null) return null;
        const { left, right, top, bottom } = element.getBoundingClientRect();
        return { left, right, top, bottom };
      };
      const root = document.querySelector('[data-testid="narrow-container"]');
      const control = root?.querySelector('.cinder-segmented-control-container') ?? null;
      const message = root?.querySelector(
        '.cinder-form-field__error[data-cinder-error], .cinder-form-field__description',
      );
      const group = root?.querySelector('[role="radiogroup"]') ?? null;
      return {
        container: box(root ?? null),
        control: box(control),
        group: box(group),
        message: box(message ?? null),
        stacked: control?.hasAttribute('data-cinder-stacked') ?? false,
        messageText: message?.textContent?.trim() ?? '',
        groupOverflow: group === null ? 0 : group.scrollWidth - group.clientWidth,
        messageOverflow:
          message === null || message === undefined ? 0 : message.scrollWidth - message.clientWidth,
      };
    });
    expect(read.stacked).toBe(true);
    // The control keeps room for its focus ring and hands it straight back with a negative margin
    // (COR-2312), so its box may stand a ring's width (2px) outside the container's; the message
    // has no such room and stays inside.
    const RING = 3;
    for (const [inside, room] of [
      [read.control, RING],
      [read.group, RING],
      [read.message, 1],
    ] as const) {
      expect(inside).not.toBeNull();
      expect(inside!.left).toBeGreaterThanOrEqual(read.container!.left - room);
      expect(inside!.right).toBeLessThanOrEqual(read.container!.right + room);
    }
    expect(read.groupOverflow).toBeLessThanOrEqual(1);
    expect(read.messageOverflow).toBeLessThanOrEqual(1);
    // The message is whole, and it wraps onto more than one line in 280px.
    expect(read.messageText.length).toBeGreaterThan(40);
    expect(read.message!.bottom - read.message!.top).toBeGreaterThan(20);
  });
}
