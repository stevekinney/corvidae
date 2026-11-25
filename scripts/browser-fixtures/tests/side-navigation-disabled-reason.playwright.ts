/// <reference lib="dom" />
/**
 * COR-2665: a disabled side navigation row reads as disabled by more than colour (a regular
 * weight against the enabled rows' medium), and with a `disabledReason` it says why on a second
 * line under its label, never louder than the name it explains (COR-2680), at the extra-small size, starting where the
 * label's text starts (past an icon, or at the row's own start without one), with no hover, at a
 * phone's width and a desktop's, in both themes. The row is named by its label and described by
 * its reason. Measured on the `side-navigation` assertion fixture with `?disabled=1`, which leaves
 * the default fixture's baselines alone.
 */

import { THEME_STORAGE_KEY, themeContextOptions } from '@lostgradient/testing';
import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test } from '@playwright/test';

import { toneOf } from './reason-tone-support.ts';

type RowGeometry = {
  name: string;
  height: number;
  fontWeight: string;
  textLeft: number;
  labelBottom: number;
  reason: null | {
    top: number;
    textLeft: number;
    height: number;
    color: string;
    fontSize: string;
    extraSmall: string;
  };
};

for (const theme of ['light', 'dark'] as const) {
  test.describe(`${theme} theme`, () => {
    test.use(themeContextOptions(theme));

    for (const width of [375, 1280]) {
      test(`at ${width}px a disabled row is set apart and its reason is a second line under its label`, async ({
        page,
      }) => {
        await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [
          THEME_STORAGE_KEY,
          theme,
        ] as const);
        await page.setViewportSize({ width, height: 800 });
        await page.goto(`${fixtureRoute('side-navigation')}&disabled=1`, { waitUntil: 'load' });
        const navigation = page.getByRole('navigation', { name: 'Temporal pages' });
        await expect(navigation).toBeVisible();

        const taskQueue = navigation.getByRole('button', { name: 'Task queue', exact: true });
        await expect(taskQueue).toHaveAccessibleDescription('Open a task queue first');
        await expect(taskQueue).toBeDisabled();

        const rows: RowGeometry[] = await page.evaluate(() => {
          const root = document.querySelector(
            '#example-mount-disabled nav[aria-label="Temporal pages"]',
          )!;
          const items = Array.from(
            root.querySelectorAll<HTMLElement>('[data-cinder-navigation-item]'),
          );
          const firstText = (scope: Element, skip: Element | null) => {
            const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
              acceptNode: (node) =>
                node.textContent?.trim() && !(skip?.contains(node) ?? false)
                  ? NodeFilter.FILTER_ACCEPT
                  : NodeFilter.FILTER_SKIP,
            });
            const range = document.createRange();
            range.selectNodeContents(walker.nextNode()!);
            return range.getClientRects()[0]!;
          };
          return items.map((item) => {
            const reason = item.querySelector<HTMLElement>('.cinder-side-navigation-item__reason');
            const label = firstText(item, reason);
            let reasonGeometry: RowGeometry['reason'] = null;
            if (reason !== null) {
              const probe = document.createElement('span');
              probe.style.fontSize = 'var(--cinder-text-xs)';
              item.append(probe);
              const probeStyle = getComputedStyle(probe);
              const extraSmall = probeStyle.fontSize;
              probe.remove();
              const box = reason.getBoundingClientRect();
              reasonGeometry = {
                top: box.top,
                textLeft: firstText(reason, null).left,
                height: box.height,
                color: getComputedStyle(reason).color,
                fontSize: getComputedStyle(reason).fontSize,
                extraSmall,
              };
            }
            const labelElement = reason?.previousElementSibling ?? item;
            return {
              name: item.getAttribute('aria-label') ?? item.textContent?.trim() ?? '',
              height: item.getBoundingClientRect().height,
              fontWeight: getComputedStyle(labelElement).fontWeight,
              textLeft: label.left,
              labelBottom: label.bottom,
              reason: reasonGeometry,
            };
          });
        });

        // Workflows (enabled), Task queue (reason), Schedules (no reason), Deployments (enabled,
        // icon), Workers (reason, icon).
        expect(rows).toHaveLength(5);
        const [workflows, taskQueueRow, schedules, deployments, workers] = rows as [
          RowGeometry,
          RowGeometry,
          RowGeometry,
          RowGeometry,
          RowGeometry,
        ];

        // Not by colour alone: every disabled row is set in a different weight.
        expect(Number(workflows.fontWeight)).toBeGreaterThan(Number(taskQueueRow.fontWeight));
        expect(schedules.fontWeight).toBe(taskQueueRow.fontWeight);
        expect(workers.fontWeight).toBe(taskQueueRow.fontWeight);
        expect(deployments.fontWeight).toBe(workflows.fontWeight);

        // A disabled row with no reason keeps an enabled row's height.
        expect(Math.abs(schedules.height - workflows.height)).toBeLessThan(1);
        expect(schedules.reason).toBeNull();

        for (const row of [taskQueueRow, workers]) {
          const reason = row.reason!;
          expect(reason.height).toBeGreaterThan(0);
          expect(reason.top).toBeGreaterThanOrEqual(row.labelBottom - 0.5);
          expect(Math.abs(reason.textLeft - row.textLeft)).toBeLessThan(1);
          expect(reason.fontSize).toBe(reason.extraSmall);
        }
        // With an icon the reason starts past it, where the label's text starts.
        expect(workers.textLeft).toBeGreaterThan(taskQueueRow.textLeft + 10);
        expect(Math.abs(workers.textLeft - deployments.textLeft)).toBeLessThan(1);

        // A disabled link loses its `href`, so it is found by its name, not by the link role.
        const workersRow = navigation.locator(
          '[data-cinder-navigation-item][aria-label="Workers"]',
        );
        await expect(workersRow).toHaveAccessibleDescription(
          'Open a task queue to see the workers polling it',
        );

        // COR-2680: a reason never reads louder than the name it explains: no more contrast, and
        // smaller.
        for (const name of ['Task queue', 'Workers']) {
          const row = navigation.locator(`[data-cinder-navigation-item][aria-label="${name}"]`);
          const nameTone = await row.evaluate(toneOf);
          const reasonTone = await row
            .locator('.cinder-side-navigation-item__reason')
            .evaluate(toneOf);
          expect(reasonTone.contrast).toBeLessThanOrEqual(nameTone.contrast + 0.01);
          expect(reasonTone.fontSize).toBeLessThan(nameTone.fontSize);
        }

        // A group that states one reason draws it once and is the description of its disabled
        // rows, which draw none of their own; it is quieter than the rows it covers.
        const shared = page.getByRole('navigation', { name: 'Shared reason' });
        const groupReasons = shared.locator('.cinder-side-navigation-group__reason');
        await expect(groupReasons).toHaveCount(1);
        await expect(groupReasons).toBeVisible();
        for (const name of ['Namespaces', 'Workflows']) {
          const row = shared.getByRole('button', { name, exact: true });
          await expect(row).toHaveAccessibleDescription('Choose a connection first');
          await expect(row.locator('.cinder-side-navigation-item__reason')).toHaveCount(0);
          const rowTone = await row.evaluate(toneOf);
          const groupTone = await groupReasons.evaluate(toneOf);
          expect(groupTone.contrast).toBeLessThanOrEqual(rowTone.contrast + 0.01);
          expect(groupTone.fontSize).toBeLessThan(rowTone.fontSize);
        }
        // The group reason starts where its rows' text starts.
        const firstTextLeft = (element: Element) => {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) =>
              node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
          });
          const range = document.createRange();
          range.selectNodeContents(walker.nextNode()!);
          return range.getClientRects()[0]!.left;
        };
        const reasonLeft = await groupReasons.evaluate(firstTextLeft);
        const rowLeft = await shared
          .getByRole('button', { name: 'Namespaces', exact: true })
          .evaluate(firstTextLeft);
        expect(Math.abs(reasonLeft - rowLeft)).toBeLessThan(1);
      });
    }
  });
}
