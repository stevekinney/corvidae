import { expect, test } from '@playwright/test';
import { fixtureRoute } from './layout-fixture.ts';

// COR-2443 AC4 and COR-2503 AC1, AC5 and AC6: a time-led row leads with its window, on one line,
// and the name leads: the meta shares the name's line only while the name keeps its room, and the
// subtitle takes the width under both.

const MINIMUM_NAME_WIDTH = 112; // 7rem

type RowMeasurement = {
  rowWidth: number;
  leadWidth: number;
  windowHeight: number;
  windowLineHeight: number;
  windowOverflow: number;
  nameWidth: number;
  subtitleWidth: number | null;
  trailingTop: number | null;
  nameTop: number;
  nameBottom: number;
  trailingWidth: number | null;
};

test.describe('Time-led row fit', () => {
  test('on a 390px phone the window stays on one line, the name keeps its room, and the subtitle takes the full text width', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(fixtureRoute('grouped-list'), { waitUntil: 'load' });
    for (const testId of ['timed-widest', 'timed-long-meta']) {
      // Both sides of every comparison are read in one evaluate, so they come from one layout.
      const measured = await page.getByTestId(testId).evaluate((row): RowMeasurement => {
        const box = (selector: string) =>
          row.querySelector<HTMLElement>(selector)?.getBoundingClientRect() ?? null;
        const windowElement = row.querySelector<HTMLElement>(
          '.cinder-grouped-list-item__lead-window',
        );
        if (windowElement === null) throw new Error('The row drew no time window');
        const name = box('.cinder-grouped-list-item__title');
        const trailing = box('.cinder-grouped-list-item__trailing');
        const subtitle = box('.cinder-grouped-list-item__subtitle');
        const lead = box('.cinder-grouped-list-item__lead');
        if (name === null || lead === null) throw new Error('The row drew no name or lead');
        return {
          rowWidth: row.getBoundingClientRect().width,
          leadWidth: lead.width,
          windowHeight: windowElement.getBoundingClientRect().height,
          windowLineHeight: Number.parseFloat(getComputedStyle(windowElement).lineHeight),
          windowOverflow: windowElement.scrollWidth - windowElement.clientWidth,
          nameWidth: name.width,
          subtitleWidth: subtitle?.width ?? null,
          trailingTop: trailing?.top ?? null,
          nameTop: name.top,
          nameBottom: name.bottom,
          trailingWidth: trailing?.width ?? null,
        };
      });
      // One line: the window is exactly one title line tall and does not overflow its lead.
      expect(measured.windowHeight, `${testId} window height`).toBeCloseTo(
        measured.windowLineHeight,
        0,
      );
      expect(measured.windowOverflow, `${testId} window overflow`).toBeLessThanOrEqual(0);
      // The name keeps its room, whether the meta shares its line or takes one of its own.
      expect(measured.nameWidth, `${testId} name width`).toBeGreaterThanOrEqual(MINIMUM_NAME_WIDTH);
      if (measured.trailingTop !== null) {
        const ownLine = measured.trailingTop >= measured.nameBottom - 1;
        const onNameLine = Math.abs(measured.trailingTop - measured.nameTop) <= 1;
        expect(ownLine || onNameLine, `${testId} meta is on the name's line or its own`).toBe(true);
      }
      // The title column, the name and the subtitle, keeps at least 60% of the row.
      expect(measured.subtitleWidth, `${testId} subtitle`).not.toBeNull();
      expect(measured.subtitleWidth! / measured.rowWidth, `${testId} text share`).toBeGreaterThan(
        0.6,
      );
    }
  });

  test('the lead holds the longest window without wrapping at the default and the comfortable density', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(fixtureRoute('grouped-list'), { waitUntil: 'load' });
    const row = page.getByTestId('timed-widest');
    for (const density of ['default', 'comfortable']) {
      await page.evaluate((value) => {
        document.documentElement.setAttribute('data-density', value);
      }, density);
      const fit = await row.evaluate((element) => {
        const lead = element.querySelector<HTMLElement>('.cinder-grouped-list-item__lead');
        const windowElement = element.querySelector<HTMLElement>(
          '.cinder-grouped-list-item__lead-window',
        );
        if (lead === null || windowElement === null) throw new Error('The row drew no lead');
        const range = document.createRange();
        range.selectNodeContents(windowElement);
        return {
          textWidth: range.getBoundingClientRect().width,
          leadWidth: lead.getBoundingClientRect().width,
          lines: range.getClientRects().length,
        };
      });
      expect(fit.lines, `${density} lines`).toBe(1);
      expect(fit.textWidth, `${density} width`).toBeLessThanOrEqual(fit.leadWidth);
    }
  });

  test('on a wide row the meta takes a line of its own before the name is squeezed', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(fixtureRoute('grouped-list'), { waitUntil: 'load' });
    const row = page.getByTestId('timed-long-meta');
    // A pane too narrow for the name's 10rem beside the lead and the meta, wide enough for a row
    // that is not the phone's grid: the row measures its own content box (the pane less its 16px
    // insets), which must reach 26rem (416px), so a 430px pane is still the phone's grid.
    await row.evaluate((element) => {
      (
        element.closest('[data-testid="grouped-list-timed-phone"]') as HTMLElement
      ).style.inlineSize = '460px';
    });
    // The wide form is in force: the row is not the phone's grid.
    await expect(row.locator('.cinder-grouped-list-item__content')).not.toHaveCSS(
      'display',
      'grid',
    );
    const measured = await row.evaluate((element) => {
      const name = element
        .querySelector('.cinder-grouped-list-item__title')!
        .getBoundingClientRect();
      const trailing = element
        .querySelector('.cinder-grouped-list-item__trailing')!
        .getBoundingClientRect();
      return { nameWidth: name.width, nameBottom: name.bottom, trailingTop: trailing.top };
    });
    // The name keeps its 10rem and the meta, which does not fit beside it, sits under it.
    expect(measured.nameWidth).toBeGreaterThanOrEqual(160);
    expect(measured.trailingTop).toBeGreaterThanOrEqual(measured.nameBottom - 1);
  });
});
