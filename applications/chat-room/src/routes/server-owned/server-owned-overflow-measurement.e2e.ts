import { expect, test } from '@playwright/test';
import { hasStableOverflow } from './server-owned-test-helpers';

test('a transient overflowing frame cannot end the transcript fill loop', async ({ page }) => {
  await page.setContent(
    '<div id="viewport" style="height:100px;overflow:auto"><div id="content" style="height:200px"></div></div>',
  );
  const viewport = page.locator('#viewport');
  await viewport.evaluate((element) => {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
    const content = document.querySelector<HTMLElement>('#content');
    if (!descriptor?.get || !content) throw new Error('overflow fixture is missing');
    const readHeight = descriptor.get.bind(element);
    let firstRead = true;
    // Keep real browser geometry, but make its first observation schedule the
    // next layout. A one-shot oracle sees true; consecutive frames disagree.
    Object.defineProperty(element, 'scrollHeight', {
      configurable: true,
      get() {
        if (firstRead) {
          firstRead = false;
          requestAnimationFrame(() => {
            content.style.height = '50px';
          });
        }
        return readHeight();
      },
    });
  });

  expect(await hasStableOverflow(viewport)).toBe(false);
  expect(await viewport.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(
    true,
  );
});

test('stable overflow measurement returns true for an already-settled viewport', async ({
  page,
}) => {
  await page.setContent(
    '<div id="viewport" style="height:100px;overflow:auto"><div style="height:200px"></div></div>',
  );
  expect(await hasStableOverflow(page.locator('#viewport'))).toBe(true);
});
