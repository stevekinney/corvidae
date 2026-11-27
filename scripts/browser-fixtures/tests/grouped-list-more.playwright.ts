import { expect, test } from '@playwright/test';
import { fixtureRoute } from './layout-fixture.ts';

// COR-2765 AC3 and AC4: a GroupedList's `more` link sits 8px under the group (or its footer), its
// text starts on the group's edge, as the header and footer do (COR-2768), and under touch its hit area reaches at least 20px above and
// below its centre without moving it.

type Measured = {
  groupBottom: number;
  footerBottom: number | null;
  linkTop: number;
  linkLeft: number;
  groupLeft: number;
  centerX: number;
  centerY: number;
};

const CASES = ['more-only', 'footer-and-more'] as const;

async function measure(page: import('@playwright/test').Page, testId: string): Promise<Measured> {
  return page.getByTestId(testId).evaluate((root): Measured => {
    const box = (selector: string) => {
      const element = root.querySelector<HTMLElement>(selector);
      if (element === null) throw new Error(`missing ${selector}`);
      return element.getBoundingClientRect();
    };
    const textBox = (selector: string) => {
      const element = root.querySelector<HTMLElement>(selector);
      if (element === null) throw new Error(`missing ${selector}`);
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const node = walker.nextNode();
      if (node === null) throw new Error(`no text in ${selector}`);
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect();
    };
    const footer = root.querySelector<HTMLElement>('.cinder-grouped-list__footer');
    const link = box('a.cinder-grouped-list__more');
    const linkText = textBox('a.cinder-grouped-list__more');
    return {
      groupBottom: box('.cinder-grouped-list__group').bottom,
      footerBottom: footer === null ? null : footer.getBoundingClientRect().bottom,
      linkTop: linkText.top,
      linkLeft: linkText.left,
      groupLeft: box('.cinder-grouped-list__group').left,
      centerX: link.left + link.width / 2,
      centerY: link.top + link.height / 2,
    };
  });
}

for (const width of [320, 1280] as const) {
  test(`the more link sits 8px under the group, on the group's edge, at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(fixtureRoute('grouped-list-more'), { waitUntil: 'load' });
    for (const testId of CASES) {
      const measured = await measure(page, testId);
      const above = measured.footerBottom ?? measured.groupBottom;
      expect(Math.abs(measured.linkTop - above - 8)).toBeLessThanOrEqual(2);
      expect(Math.abs(measured.linkLeft - measured.groupLeft)).toBeLessThanOrEqual(1);
    }
  });
}

test('under touch at 375px the more link keeps its gap and its hit area reaches 20px above and below its centre', async ({
  browser,
}) => {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 1,
    viewport: { width: 375, height: 900 },
  });
  try {
    const page = await context.newPage();
    await page.goto(fixtureRoute('grouped-list-more'), { waitUntil: 'load' });
    expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true);
    for (const testId of CASES) {
      const measured = await measure(page, testId);
      const above = measured.footerBottom ?? measured.groupBottom;
      expect(Math.abs(measured.linkTop - above - 8)).toBeLessThanOrEqual(2);
      expect(Math.abs(measured.linkLeft - measured.groupLeft)).toBeLessThanOrEqual(1);
      const hits = await page.evaluate(
        ({ x, y }) =>
          [y - 20, y, y + 20].map(
            (pointY) =>
              document.elementFromPoint(x, pointY)?.closest('a.cinder-grouped-list__more') != null,
          ),
        { x: measured.centerX, y: measured.centerY },
      );
      expect(hits).toEqual([true, true, true]);
    }
  } finally {
    await context.close();
  }
});
