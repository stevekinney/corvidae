import type { Locator, Page } from '@playwright/test';
import { expect, test } from './component-page-fixture.ts';
import { fixtureEntry } from './layout-fixture.ts';

const viewport = { name: 'desktop', width: 900, height: 900 } as const;

async function expectFocusIndicator(element: Locator): Promise<void> {
  await expect(element).toBeFocused();
  const indicator = await element.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      outlineVisible:
        Number.parseFloat(style.outlineWidth) > 0 &&
        style.outlineStyle !== 'none' &&
        style.outlineColor !== 'rgba(0, 0, 0, 0)' &&
        style.outlineColor !== 'transparent',
      shadowVisible: style.boxShadow !== 'none',
      focusVisible: node.matches(':focus-visible'),
    };
  });
  expect(indicator.focusVisible).toBe(true);
  expect(indicator.outlineVisible || indicator.shadowVisible).toBe(true);
}

async function expectNativeKeyboardScroll(page: Page, scroller: Locator): Promise<void> {
  // WebKit needs a held key until native scrolling begins; immediate keyup can cancel it.
  await page.keyboard.down('ArrowRight');
  try {
    await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  } finally {
    await page.keyboard.up('ArrowRight');
  }
}

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: carousel has one scroll entry and preserves focus before hiding slides`, async ({
    componentPage,
    browserName,
  }) => {
    const page = await componentPage.open({
      entry: fixtureEntry('carousel'),
      fixtureName: 'assertion',
      theme,
      viewport,
      onPage: async (target) => {
        await target.emulateMedia({ reducedMotion: 'no-preference' });
        await target.clock.install();
        await target.clock.pauseAt(new Date());
      },
    });
    const scope = page.locator('#example-mount-keyboard');
    const root = scope.locator('.cinder-carousel');
    const scroller = scope.locator('.cinder-carousel__viewport');
    await page.locator('#before-keyboard-carousel').focus();
    const tabKey = browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';
    await page.keyboard.press(tabKey);
    await expect(scope.locator('.cinder-carousel__control--pause')).toBeFocused();
    await page.keyboard.press(tabKey);
    await expectFocusIndicator(scroller);
    await expect(root).toHaveAttribute('tabindex', '-1');

    await page.keyboard.press('ArrowRight');
    await expect(scroller).toBeFocused();
    await expect(scope.locator('.cinder-carousel__dot').nth(1)).toHaveAttribute(
      'aria-current',
      'true',
    );
    const link = scope.getByRole('link', { name: 'Read Patterns' });
    await link.focus();
    await page.keyboard.press('ArrowRight');
    await expect(root).toBeFocused();
    await expect(scroller.locator('article').nth(1)).toHaveAttribute('inert', '');
    await expect(scope.locator('.cinder-carousel__dot').nth(2)).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  test(`${theme}: carousel focus stops autoplay until explicit keyboard restart`, async ({
    componentPage,
    browserName,
  }) => {
    const page = await componentPage.open({
      entry: fixtureEntry('carousel'),
      fixtureName: 'assertion',
      theme,
      viewport,
      onPage: async (target) => {
        await target.emulateMedia({ reducedMotion: 'no-preference' });
        await target.clock.install();
        await target.clock.pauseAt(new Date());
      },
    });
    const scope = page.locator('#example-mount-keyboard');
    const current = scope.locator('.cinder-carousel__dot[aria-current="true"]');
    const rotation = scope.locator('.cinder-carousel__control--pause');
    await page.locator('#before-keyboard-carousel').focus();
    const tabKey = browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';
    await page.keyboard.press(tabKey);
    await expect(rotation).toBeFocused();
    await expect(rotation).toHaveText('Play');
    await page.clock.runFor(3000);
    await expect(current).toHaveAttribute('aria-label', 'Go to Introduction');
    await page.locator('#after-keyboard-carousel').focus();
    await page.clock.runFor(3000);
    await expect(current).toHaveAttribute('aria-label', 'Go to Introduction');
    await rotation.focus();
    await rotation.press('Enter');
    await expect(rotation).toHaveText('Pause');
    await page.clock.runFor(1100);
    await expect(current).toHaveAttribute('aria-label', 'Go to Patterns');
    await expect(rotation).toBeFocused();
  });

  test(`${theme}: clicking Pause stops rotation through its focus transition`, async ({
    componentPage,
  }) => {
    const page = await componentPage.open({
      entry: fixtureEntry('carousel'),
      fixtureName: 'assertion',
      theme,
      viewport,
      onPage: async (target) => {
        await target.emulateMedia({ reducedMotion: 'no-preference' });
        await target.clock.install();
        await target.clock.pauseAt(new Date());
      },
    });
    const scope = page.locator('#example-mount-keyboard');
    const rotation = scope.locator('.cinder-carousel__control--pause');
    await expect(rotation).toHaveText('Pause');
    await rotation.click();
    await expect(rotation).toHaveText('Play');
    await page.mouse.move(0, 0);
    await page.clock.runFor(3000);
    await expect(scope.locator('.cinder-carousel__dot').first()).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  test(`${theme}: canceled pointer activation preserves focus pause and keyboard restart`, async ({
    componentPage,
    browserName,
  }) => {
    const page = await componentPage.open({
      entry: fixtureEntry('carousel'),
      fixtureName: 'assertion',
      theme,
      viewport,
      onPage: async (target) => {
        await target.emulateMedia({ reducedMotion: 'no-preference' });
        await target.clock.install();
        await target.clock.pauseAt(new Date());
      },
    });
    const scope = page.locator('#example-mount-keyboard');
    const rotation = scope.locator('.cinder-carousel__control--pause');
    await rotation.hover();
    await page.mouse.down();
    await page.mouse.move(0, 0);
    await page.mouse.up();
    await page.locator('#before-keyboard-carousel').focus();
    const tabKey = browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';
    await page.keyboard.press(tabKey);
    await expect(rotation).toBeFocused();
    await expect(rotation).toHaveText('Play');
    await page.clock.runFor(3000);
    await expect(scope.locator('.cinder-carousel__dot').first()).toHaveAttribute(
      'aria-current',
      'true',
    );
    await rotation.press('Enter');
    await page.clock.runFor(1100);
    await expect(scope.locator('.cinder-carousel__dot').nth(1)).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  test(`${theme}: slide inputs retain caret and range keyboard ownership`, async ({
    componentPage,
  }) => {
    const page = await componentPage.open({
      entry: fixtureEntry('carousel'),
      fixtureName: 'assertion',
      theme,
      viewport,
      onPage: async (target) => {
        await target.emulateMedia({ reducedMotion: 'no-preference' });
        await target.clock.install();
        await target.clock.pauseAt(new Date());
      },
    });
    const scope = page.locator('#example-mount-keyboard');
    const notes = scope.getByRole('textbox', { name: 'Introduction notes' });
    await notes.focus();
    await notes.evaluate((element) => {
      if (element instanceof HTMLInputElement) element.setSelectionRange(0, 0);
    });
    await notes.press('Home');
    await notes.press('ArrowRight');
    await expect(notes).toBeFocused();
    expect(
      await notes.evaluate(
        (element) => element instanceof HTMLInputElement && element.selectionStart,
      ),
    ).toBe(1);
    const volume = scope.getByRole('slider', { name: 'Introduction volume' });
    await volume.focus();
    await volume.press('ArrowRight');
    await expect(volume).toHaveValue('51');
    await expect(volume).toBeFocused();
    await expect(scope.locator('.cinder-carousel__dot').first()).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  test(`${theme}: reduced-motion marquee scrolls with the keyboard`, async ({ componentPage }) => {
    const page = await componentPage.open({
      entry: fixtureEntry('marquee'),
      fixtureName: 'assertion',
      theme,
      viewport,
      onPage: (target) => target.emulateMedia({ reducedMotion: 'reduce' }),
    });
    const scroller = page.locator('#example-mount-overflow .cinder-marquee__viewport');
    await page.locator('#before-scrolling-marquee').focus();
    await page.keyboard.press('Tab');
    await expectFocusIndicator(scroller);
    await expect(scroller).toHaveCSS('overflow-x', 'auto');
    await expect(
      page.locator('#example-mount-overflow .cinder-marquee__item[aria-hidden]'),
    ).toBeHidden();
    expect(await scroller.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
      true,
    );
    await expectNativeKeyboardScroll(page, scroller);
  });

  test(`${theme}: horizontal timeline keeps its list semantics and scrolls with the keyboard`, async ({
    componentPage,
  }) => {
    const page = await componentPage.open({
      entry: fixtureEntry('timeline'),
      fixtureName: 'assertion',
      theme,
      viewport,
    });
    const list = page.getByRole('list', { name: 'Horizontal incident timeline' });
    await expect(list.getByRole('listitem')).toHaveCount(3);
    await page.locator('#before-horizontal-timeline').focus();
    await page.keyboard.press('Tab');
    await expectFocusIndicator(list);
    await expect(list).toHaveJSProperty('tagName', 'OL');
    await expectNativeKeyboardScroll(page, list);
    await expect(
      page.getByRole('list', { name: 'Incident timeline', exact: true }),
    ).not.toHaveAttribute('tabindex');
  });
}
