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

  // COR-2503 AC3 and AC4: the colours a browser computes, not the stylesheet's text, so a later,
  // more specific rule that recoloured the window would fail here.
  test('urgent colours only the caption, soon mutes the window, and a plain row uses the defaults', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(fixtureRoute('grouped-list'), { waitUntil: 'load' });
    await expect(page.getByTestId('timed-plain')).toBeVisible();
    const colours = await page.evaluate(() => {
      const probe = (token: string) => {
        const element = document.createElement('span');
        element.style.color = `var(${token})`;
        document.body.append(element);
        const colour = getComputedStyle(element).color;
        element.remove();
        return colour;
      };
      const part = (testId: string, name: string) => {
        const element = document.querySelector(
          `[data-testid="${testId}"] .cinder-grouped-list-item__lead-${name}`,
        );
        return element === null ? null : getComputedStyle(element).color;
      };
      return {
        defaultText: probe('--cinder-text-default'),
        mutedText: probe('--cinder-text-muted'),
        warningText: probe('--cinder-status-warning-text'),
        urgentWindow: part('timed-urgent', 'window'),
        urgentCaption: part('timed-urgent', 'caption'),
        soonWindow: part('timed-soon', 'window'),
        soonCaption: part('timed-soon', 'caption'),
        plainWindow: part('timed-plain', 'window'),
        plainCaption: part('timed-plain', 'caption'),
      };
    });
    expect(colours.warningText).not.toBe(colours.defaultText);
    expect(colours.mutedText).not.toBe(colours.defaultText);
    expect(colours.urgentCaption).toBe(colours.warningText);
    expect(colours.urgentWindow).toBe(colours.defaultText);
    expect(colours.soonWindow).toBe(colours.mutedText);
    expect(colours.soonCaption).toBe(colours.mutedText);
    expect(colours.plainWindow).toBe(colours.defaultText);
    expect(colours.plainCaption).toBe(colours.mutedText);
  });

  // The window is the row's entry point: larger than the name in both forms, in a lead that still
  // holds the longest window on one line.
  test('the window is larger than the name, and the longest window fits its lead, on a wide row and on a narrow one', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(fixtureRoute('grouped-list'), { waitUntil: 'load' });
    for (const testId of ['timed-wide-stale', 'timed-widest']) {
      const row = page.getByTestId(testId);
      await expect(row).toBeVisible();
      const fit = await row.evaluate((element) => {
        const lead = element.querySelector<HTMLElement>('.cinder-grouped-list-item__lead');
        const windowElement = element.querySelector<HTMLElement>(
          '.cinder-grouped-list-item__lead-window',
        );
        const name = element.querySelector<HTMLElement>('.cinder-grouped-list-item__title');
        if (lead === null || windowElement === null || name === null) {
          throw new Error('The row drew no lead or name');
        }
        const range = document.createRange();
        range.selectNodeContents(windowElement);
        return {
          text: windowElement.textContent?.trim(),
          textWidth: range.getBoundingClientRect().width,
          lines: range.getClientRects().length,
          leadWidth: lead.getBoundingClientRect().width,
          windowSize: Number.parseFloat(getComputedStyle(windowElement).fontSize),
          nameSize: Number.parseFloat(getComputedStyle(name).fontSize),
        };
      });
      expect(fit.text, testId).toBe('11 pm–2 am');
      expect(fit.lines, `${testId} lines`).toBe(1);
      expect(fit.textWidth, `${testId} width`).toBeLessThanOrEqual(fit.leadWidth);
      expect(fit.windowSize, `${testId} window size`).toBeGreaterThan(fit.nameSize + 1);
    }
    // The wide row's lead is the wider of the two, and its window the larger.
    const sizes = await page.evaluate(() => {
      const read = (testId: string) => {
        const row = document.querySelector(`[data-testid="${testId}"]`);
        const lead = row?.querySelector('.cinder-grouped-list-item__lead');
        const windowElement = row?.querySelector('.cinder-grouped-list-item__lead-window');
        if (!lead || !windowElement) throw new Error(`No lead in ${testId}`);
        return {
          lead: lead.getBoundingClientRect().width,
          window: Number.parseFloat(getComputedStyle(windowElement).fontSize),
        };
      };
      return { wide: read('timed-wide-stale'), narrow: read('timed-widest') };
    });
    expect(sizes.wide.lead).toBeGreaterThan(sizes.narrow.lead);
    expect(sizes.wide.window).toBeGreaterThan(sizes.narrow.window);
  });

  // Board 11: a photo sits at the end of the row and nothing else moves.
  test('a photo is the last thing before the chevron, after the distance, and the subtitle stays on its line', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(fixtureRoute('grouped-list'), { waitUntil: 'load' });
    for (const testId of ['timed-photo-phone', 'timed-photo-wide']) {
      const row = page.getByTestId(testId);
      await expect(row).toBeVisible();
      const read = await row.evaluate((element) => {
        const box = (name: string) => {
          const part = element.querySelector(`.cinder-grouped-list-item__${name}`);
          if (part === null) throw new Error(`The row drew no ${name}`);
          return part.getBoundingClientRect();
        };
        const photo = box('photo');
        const trailing = box('trailing');
        const title = box('title');
        const subtitle = box('subtitle');
        return {
          photoLeft: photo.left,
          photoWidth: photo.width,
          trailingRight: trailing.right,
          trailingTop: trailing.top,
          titleTop: title.top,
          titleBottom: title.bottom,
          subtitleTop: subtitle.top,
          subtitleRight: subtitle.right,
        };
      });
      expect(read.photoWidth, `${testId} photo width`).toBeCloseTo(56, 0);
      // The distance comes before the photo, on the name's line.
      expect(read.trailingRight, `${testId} distance before photo`).toBeLessThanOrEqual(
        read.photoLeft + 1,
      );
      expect(
        Math.abs(read.trailingTop - read.titleTop),
        `${testId} distance line`,
      ).toBeLessThanOrEqual(4);
      // The subtitle follows the name directly: the photo does not push it down, and it ends
      // before the photo.
      expect(read.subtitleTop - read.titleBottom, `${testId} subtitle gap`).toBeLessThanOrEqual(8);
      expect(read.subtitleRight, `${testId} subtitle before photo`).toBeLessThanOrEqual(
        read.photoLeft + 1,
      );
    }
  });
});
