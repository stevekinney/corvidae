import { expect, test, type Page } from '@playwright/test';
import { fixtureRoute } from './layout-fixture.ts';

const FOOTER_ROUTE = fixtureRoute('footer');
const containerWidths = [20, 40, 43, 48, 64, 90] as const;
type FooterBoxes = {
  brand: NonNullable<Awaited<ReturnType<import('@playwright/test').Locator['boundingBox']>>>;
  groups: NonNullable<Awaited<ReturnType<import('@playwright/test').Locator['boundingBox']>>>;
  product: NonNullable<Awaited<ReturnType<import('@playwright/test').Locator['boundingBox']>>>;
  company: NonNullable<Awaited<ReturnType<import('@playwright/test').Locator['boundingBox']>>>;
};

async function setFooterWidth(page: Page, width: number): Promise<void> {
  await page.locator('.cinder-footer').evaluate((element, value) => {
    if (!(element instanceof HTMLElement)) throw new Error('Missing footer');
    element.style.inlineSize = `${value}rem`;
  }, width);
}
async function readFooterBoxes(page: Page): Promise<FooterBoxes> {
  const boxes = await Promise.all([
    page.locator('.cinder-footer__brand').boundingBox(),
    page.locator('.cinder-footer__groups').boundingBox(),
    page.getByRole('navigation', { name: 'Product' }).boundingBox(),
    page.getByRole('navigation', { name: 'Company' }).boundingBox(),
  ]);
  if (boxes.some((box) => box === null)) throw new Error('Footer layout region has no box.');
  return { brand: boxes[0]!, groups: boxes[1]!, product: boxes[2]!, company: boxes[3]! };
}
async function assertFooterSpacing(page: Page): Promise<void> {
  const spacing = await page.locator('.cinder-footer').evaluate((element) => {
    const main = element.querySelector<HTMLElement>('.cinder-footer__main');
    const groups = element.querySelector<HTMLElement>('.cinder-footer__groups');
    const list = element.querySelector<HTMLElement>('.cinder-footer__list');
    const legal = element.querySelector<HTMLElement>('.cinder-footer__legal');
    if (!main || !groups || !list || !legal)
      throw new Error('Footer fixture is missing a layout region.');
    return {
      outer: getComputedStyle(element).rowGap,
      main: getComputedStyle(main).gap,
      groups: getComputedStyle(groups).gap,
      list: getComputedStyle(list).gap,
      legal: getComputedStyle(legal).gap,
      legalPadding: getComputedStyle(legal).paddingTop,
    };
  });
  expect(spacing).toEqual({
    outer: '32px',
    main: '24px',
    groups: '16px',
    list: '8px',
    legal: '16px',
    legalPadding: '8px',
  });
}
function assertResponsivePositions(boxes: FooterBoxes, width: number): void {
  if (width < 48) {
    expect(boxes.groups.x).toBeCloseTo(boxes.brand.x, 0);
    expect(boxes.groups.y).toBeGreaterThan(boxes.brand.y + boxes.brand.height);
  } else {
    expect(boxes.groups.x).toBeGreaterThan(boxes.brand.x + boxes.brand.width);
    expect(boxes.groups.y).toBeCloseTo(boxes.brand.y, 0);
  }
  if (width === 20) expect(boxes.company.y).toBeGreaterThan(boxes.product.y + boxes.product.height);
  else {
    expect(boxes.company.y).toBeCloseTo(boxes.product.y, 0);
    expect(boxes.product.width).toBeLessThanOrEqual(192);
    expect(boxes.company.width).toBeLessThanOrEqual(192);
    expect(boxes.company.x - boxes.product.x).toBeLessThanOrEqual(208);
  }
}
async function exerciseBreakpoint(page: Page, width: number): Promise<void> {
  const groups = page.locator('.cinder-footer__groups');
  const brand = page.locator('.cinder-footer__brand');
  if (width === 48) {
    await groups.evaluate((element) => element.remove());
    await expect(brand).toHaveCSS('grid-column', '1 / -1');
  }
  if (width === 43) {
    await groups.evaluate((element) =>
      element.insertAdjacentHTML(
        'beforeend',
        '<nav aria-label="Support"><h3>Support</h3></nav><nav aria-label="Resources"><h3>Resources</h3></nav>',
      ),
    );
    const rows = await groups
      .getByRole('navigation')
      .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().y));
    expect(rows).toHaveLength(4);
    expect(new Set(rows).size).toBe(1);
  }
}

test.describe('Footer responsive layout', () => {
  for (const width of containerWidths)
    test(`${width}rem container keeps sparse link groups compact`, async ({ page }) => {
      await page.goto(FOOTER_ROUTE, { waitUntil: 'load' });
      await setFooterWidth(page, width);
      const boxes = await readFooterBoxes(page);
      await assertFooterSpacing(page);
      assertResponsivePositions(boxes, width);
      await exerciseBreakpoint(page, width);
    });
  test('long group link labels wrap inside capped navigation columns', async ({ page }) => {
    await page.goto(FOOTER_ROUTE, { waitUntil: 'load' });
    const footer = page.locator('.cinder-footer');
    const product = page.getByRole('navigation', { name: 'Product' });
    await product.locator('.cinder-footer__group-title').evaluate((title) => {
      title.textContent = 'AcmeInternationalizationResources';
    });
    await product
      .locator('.cinder-footer__link')
      .first()
      .evaluate((link) => {
        link.textContent = 'AcmeInternationalizationDocumentation';
      });
    const [productBox, linkBox, titleBox] = await Promise.all([
      product.boundingBox(),
      product.getByRole('link').first().boundingBox(),
      product.getByRole('heading').boundingBox(),
    ]);
    expect(productBox).not.toBeNull();
    expect(linkBox).not.toBeNull();
    expect(titleBox).not.toBeNull();
    expect(linkBox!.x + linkBox!.width).toBeLessThanOrEqual(productBox!.x + productBox!.width);
    expect(titleBox!.x + titleBox!.width).toBeLessThanOrEqual(productBox!.x + productBox!.width);
    expect(
      await product
        .getByRole('heading')
        .evaluate((title) => title.scrollWidth <= title.clientWidth),
    ).toBe(true);
    await setFooterWidth(page, 48);
    const brandTitle = page.locator('.cinder-footer__brand-title');
    await brandTitle.evaluate((title) => {
      title.textContent = 'AcmeInternationalizationDocumentation';
    });
    expect(await brandTitle.evaluate((title) => title.scrollWidth <= title.clientWidth)).toBe(true);
    await expect(footer).toBeVisible();
  });
});
