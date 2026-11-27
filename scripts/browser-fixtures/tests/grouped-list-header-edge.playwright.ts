import { openFixture } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test, type Page } from '@playwright/test';
import { fixtureRoute } from './layout-fixture.ts';

// COR-2768 AC3 and AC4: a GroupedList's header and footer are outside its surface, so their text
// starts on the surface's edge, which is the page edge, while the rows keep their 16px inset. In a
// right-to-left column the header ends on the surface's right edge, so the fix is logical.

type Edges = {
  groupLeft: number;
  groupRight: number;
  headerLeft: number;
  headerRight: number;
  footerLeft: number;
  titleLeft: number;
  titleRight: number;
  pageHeadingLeft: number | null;
};

async function edges(page: Page, testId: string): Promise<Edges> {
  return page.getByTestId(testId).evaluate((root): Edges => {
    const textBox = (selector: string) => {
      const element = root.querySelector<HTMLElement>(selector);
      if (element === null) throw new Error(`missing ${selector}`);
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) =>
          (node.textContent ?? '').trim() === ''
            ? NodeFilter.FILTER_SKIP
            : NodeFilter.FILTER_ACCEPT,
      });
      const node = walker.nextNode();
      if (node === null) throw new Error(`no text in ${selector}`);
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect();
    };
    const group = root.querySelector<HTMLElement>('ul.cinder-grouped-list__group');
    if (group === null) throw new Error('missing group');
    const groupBox = group.getBoundingClientRect();
    const header = textBox('.cinder-grouped-list__header');
    const title = textBox('.cinder-grouped-list-item__title');
    const pageHeading = root.querySelector('.cinder-page-header__title');
    return {
      groupLeft: groupBox.left,
      groupRight: groupBox.right,
      headerLeft: header.left,
      headerRight: header.right,
      footerLeft: textBox('.cinder-grouped-list__footer').left,
      titleLeft: title.left,
      titleRight: title.right,
      pageHeadingLeft: pageHeading === null ? null : textBox('.cinder-page-header__title').left,
    };
  });
}

async function expectOnTheEdge(page: Page, width: number): Promise<void> {
  for (const testId of ['alone', 'in-page']) {
    const measured = await edges(page, testId);
    expect(Math.abs(measured.headerLeft - measured.groupLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs(measured.footerLeft - measured.groupLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs(measured.titleLeft - measured.groupLeft - 16)).toBeLessThanOrEqual(1);
    if (measured.pageHeadingLeft !== null) {
      expect(Math.abs(measured.headerLeft - measured.pageHeadingLeft)).toBeLessThanOrEqual(1);
    }
  }
  const rtl = await edges(page, 'rtl');
  expect(Math.abs(rtl.headerRight - rtl.groupRight)).toBeLessThanOrEqual(1);
  expect(Math.abs(rtl.groupRight - rtl.titleRight - 16)).toBeLessThanOrEqual(1);
  if (width === 320) {
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
}

for (const width of [320, 1280] as const) {
  test(`the header and footer sit on the group edge at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(fixtureRoute('grouped-list-header-edge'), { waitUntil: 'load' });
    await expectOnTheEdge(page, width);
  });
}

test('under touch at 375px the header and footer sit on the group edge', async ({ browser }) => {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 1,
    viewport: { width: 375, height: 900 },
  });
  try {
    const page = await context.newPage();
    await page.goto(fixtureRoute('grouped-list-header-edge'), { waitUntil: 'load' });
    expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true);
    await expectOnTheEdge(page, 375);
  } finally {
    await context.close();
  }
});

// In a modal drawer the body is the same raised surface as the group, so the group's edge is
// invisible; the drawer hands the labels the rows' inset, and the header lines up with the row
// titles instead of with nothing (COR-2768 design review).
for (const width of [375, 1280] as const) {
  test(`in a modal drawer sheet the header lines up with the row titles at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await openFixture(page, 'drawer', { fixtureName: 'sheet-header-bar' });
    const sheet = page.locator('.cinder-drawer__body .cinder-grouped-list');
    await expect(sheet).toBeVisible();
    const lefts = await sheet.evaluate((root) => {
      const textLeft = (selector: string) => {
        const element = root.querySelector<HTMLElement>(selector);
        if (element === null) throw new Error(`missing ${selector}`);
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getBoundingClientRect().left;
      };
      return {
        header: textLeft('.cinder-grouped-list__header'),
        title: textLeft('.cinder-grouped-list-item__title'),
      };
    });
    expect(Math.abs(lefts.header - lefts.title)).toBeLessThanOrEqual(1);
  });
}
