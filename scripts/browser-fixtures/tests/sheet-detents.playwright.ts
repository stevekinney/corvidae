/**
 * COR-2322: the bottom sheet. Drawer's `placement="bottom"` rests at detents (peek, medium,
 * large), resizes by drag and by keyboard, keeps its footer on a real surface with a top fade, and
 * never shrinks the rows of a list inside it; Modal docks as a sheet below its `sheetBelow` width.
 *
 * happy-dom performs no layout, so the geometry these rules promise is asserted here, in a real
 * browser, at a phone viewport. The `sheet-detents` and `sheet-header-bar` Drawer fixtures draw the
 * same GroupedList on the page and in the sheet, so a row the sheet squeezes shows up against the
 * height the page gives it.
 */
import type { Viewport } from '@lostgradient/testing';
import type { Locator, Page } from '@playwright/test';
import { expect, test, type ComponentPageFixture } from './component-page-fixture.ts';
import { fixtureEntry } from './layout-fixture.ts';

const phone = { name: 'mobile', width: 390, height: 844 } as const satisfies Viewport;
const drawerEntry = fixtureEntry('drawer');
const modalEntry = fixtureEntry('modal');

/** A detent's height as a share of the viewport; drawer.css gives `medium` 50dvh and `large` 90dvh. */
const MEDIUM_HEIGHT = phone.height * 0.5;
const LARGE_HEIGHT = phone.height * 0.9;

async function heightOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  return box?.height ?? 0;
}

async function openSheet(componentPage: ComponentPageFixture, fixtureName: string): Promise<Page> {
  const page = await componentPage.open({
    entry: drawerEntry,
    theme: 'light',
    viewport: phone,
    fixtureName,
  });
  await expect(page.locator('.cinder-drawer__panel')).toBeVisible();
  return page;
}

test.describe('Drawer detents', () => {
  test('opens at the requested detent and the grabber reports it', async ({ componentPage }) => {
    const page = await openSheet(componentPage, 'sheet-detents');
    const panel = page.locator('.cinder-drawer__panel');
    const grabber = page.getByRole('separator', { name: 'Resize sheet' });

    await expect(panel).toHaveAttribute('data-cinder-detent', 'medium');
    await expect(grabber).toHaveAttribute('aria-valuenow', '1');
    await expect(grabber).toHaveAttribute('aria-valuetext', 'Half height');
    await expect.poll(() => heightOf(panel)).toBeCloseTo(MEDIUM_HEIGHT, -1);
  });

  test('ArrowUp and ArrowDown on the grabber step through every detent', async ({
    componentPage,
  }) => {
    const page = await openSheet(componentPage, 'sheet-detents');
    const panel = page.locator('.cinder-drawer__panel');
    const grabber = page.getByRole('separator', { name: 'Resize sheet' });
    await grabber.focus();

    await page.keyboard.press('ArrowUp');
    await expect(panel).toHaveAttribute('data-cinder-detent', 'large');
    await expect.poll(() => heightOf(panel)).toBeCloseTo(LARGE_HEIGHT, -1);

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(panel).toHaveAttribute('data-cinder-detent', 'peek');
    await expect(grabber).toHaveAttribute('aria-valuenow', '0');
    await expect.poll(() => heightOf(panel)).toBeLessThan(MEDIUM_HEIGHT / 2);
    await expect(grabber).toBeFocused();
  });

  test('dragging the grabber follows the pointer and snaps to the nearest detent', async ({
    componentPage,
  }) => {
    const page = await openSheet(componentPage, 'sheet-detents');
    const panel = page.locator('.cinder-drawer__panel');
    const grabber = page.getByRole('separator', { name: 'Resize sheet' });
    const box = await grabber.boundingBox();
    if (box === null) throw new Error('The grabber has no layout box.');
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 300, { steps: 10 });
    await expect(panel).toHaveAttribute('data-cinder-dragging', '');
    // The sheet tracks the pointer, so no transition runs on any property while it is dragged.
    await expect(panel).toHaveCSS('transition-property', 'none');
    await page.mouse.up();
    await expect(panel).toHaveAttribute('data-cinder-detent', 'large');
    await expect(panel).not.toHaveAttribute('data-cinder-dragging', '');
    await expect.poll(() => heightOf(panel)).toBeCloseTo(LARGE_HEIGHT, -1);

    const raised = await grabber.boundingBox();
    if (raised === null) throw new Error('The grabber has no layout box after the drag.');
    await page.mouse.move(raised.x + raised.width / 2, raised.y + raised.height / 2);
    await page.mouse.down();
    await page.mouse.move(raised.x + raised.width / 2, raised.y + 700, { steps: 10 });
    await page.mouse.up();
    await expect(panel).toHaveAttribute('data-cinder-detent', 'peek');
  });

  test('the peek bar shows the title and the live count, and a tap opens the sheet', async ({
    componentPage,
  }) => {
    const page = await openSheet(componentPage, 'sheet-detents');
    const panel = page.locator('.cinder-drawer__panel');
    const grabber = page.getByRole('separator', { name: 'Resize sheet' });
    await grabber.focus();
    await page.keyboard.press('Home');

    const peek = page.locator('.cinder-drawer__peek');
    await expect(peek).toBeVisible();
    await expect(peek.locator('.cinder-drawer__peek-title')).toHaveText('Runs');
    await expect(peek.locator('.cinder-drawer__peek-count')).toHaveText('12 results');
    await expect(peek.locator('.cinder-drawer__peek-count')).toHaveAttribute('aria-live', 'polite');
    await expect(page.locator('.cinder-drawer__header')).toBeHidden();
    await expect(page.locator('.cinder-drawer__footer')).toBeHidden();

    await peek.click();
    await expect(panel).toHaveAttribute('data-cinder-detent', 'medium');
    await expect(page.locator('.cinder-drawer__peek')).toHaveCount(0);
    await expect(grabber).toBeFocused();
    await expect(page.locator('.cinder-drawer__header')).toBeVisible();
  });
});

test.describe('Drawer footer bar and content', () => {
  test('the footer is a surface-coloured bar with a 24px top fade and no click catching', async ({
    componentPage,
  }) => {
    const page = await openSheet(componentPage, 'sheet-detents');
    const footer = page.locator('.cinder-drawer__footer');
    await expect(footer).toBeVisible();

    const style = await footer.evaluate((element) => {
      const body = document.querySelector('.cinder-drawer__body');
      if (!(body instanceof HTMLElement)) throw new Error('The sheet has no body.');
      const bar = getComputedStyle(element);
      const fade = getComputedStyle(element, '::before');
      return {
        background: bar.backgroundColor,
        bodyBackground: getComputedStyle(body).backgroundColor,
        borderTopWidth: bar.borderTopWidth,
        paddingBottom: bar.paddingBottom,
        fadeHeight: fade.height,
        fadePosition: fade.position,
        fadeEvents: fade.pointerEvents,
        fadeImage: fade.backgroundImage,
      };
    });

    expect(style.background).toBe(style.bodyBackground);
    expect(style.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(style.borderTopWidth).toBe('0px');
    expect(Number.parseFloat(style.paddingBottom)).toBeGreaterThanOrEqual(12);
    expect(style.fadeHeight).toBe('24px');
    expect(style.fadePosition).toBe('absolute');
    expect(style.fadeEvents).toBe('none');
    expect(style.fadeImage).toContain('linear-gradient');
  });

  test('a GroupedList in a tall sheet keeps every row at the height the page gives it', async ({
    componentPage,
  }) => {
    const page = await openSheet(componentPage, 'sheet-detents');

    for (const detent of ['medium', 'large'] as const) {
      if (detent === 'large') {
        await page.getByRole('separator', { name: 'Resize sheet' }).press('End');
        await expect
          .poll(() => heightOf(page.locator('.cinder-drawer__panel')))
          .toBeCloseTo(LARGE_HEIGHT, -1);
      }
      const measured = await page.evaluate(() => {
        const rowHeights = (root: Element | null) =>
          Array.from(
            root?.querySelectorAll('.cinder-grouped-list-item') ?? [],
            (row) => row.getBoundingClientRect().height,
          );
        const body = document.querySelector('.cinder-drawer__body');
        return {
          reference: rowHeights(document.querySelector('[data-testid="reference-list"]')),
          sheet: rowHeights(body),
          scrolls: body instanceof HTMLElement && body.scrollHeight > body.clientHeight,
        };
      });

      expect(measured.sheet, detent).toHaveLength(12);
      expect(measured.reference, detent).toHaveLength(12);
      measured.sheet.forEach((height, index) => {
        const reference = measured.reference[index] ?? 0;
        expect(reference, `row ${index + 1} on the page`).toBeGreaterThan(0);
        // Squeezed rows come out shorter than the page's; a wrapped title would only make them taller.
        expect(height, `${detent}: row ${index + 1}`).toBeGreaterThanOrEqual(reference - 0.5);
      });
      if (detent === 'medium') {
        // The rows did not shrink to fit the sheet: the body scrolls instead.
        expect(measured.scrolls).toBe(true);
      }
    }
  });
});

test.describe('Drawer header bar', () => {
  test('is Cancel, a centred 14px semibold title, then the action', async ({ componentPage }) => {
    const page = await openSheet(componentPage, 'sheet-header-bar');
    const header = page.locator('.cinder-drawer__header');
    const cancel = header.getByRole('button', { name: 'Cancel' });
    const title = header.locator('.cinder-drawer__title');
    const apply = header.getByRole('button', { name: 'Apply' });

    await expect(header).toHaveCSS('display', 'grid');
    await expect(title).toHaveCSS('font-size', '14px');
    await expect(title).toHaveCSS('font-weight', '600');

    const [headerBox, cancelBox, titleBox, applyBox] = await Promise.all([
      header.boundingBox(),
      cancel.boundingBox(),
      title.boundingBox(),
      apply.boundingBox(),
    ]);
    if (headerBox === null || cancelBox === null || titleBox === null || applyBox === null) {
      throw new Error('A header part has no layout box.');
    }
    expect(cancelBox.x).toBeLessThan(titleBox.x);
    expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(applyBox.x + 0.5);
    const titleCentre = titleBox.x + titleBox.width / 2;
    const headerCentre = headerBox.x + headerBox.width / 2;
    expect(Math.abs(titleCentre - headerCentre)).toBeLessThanOrEqual(1);
  });
});

test.describe('Modal as a bottom sheet', () => {
  async function openModalSheet(componentPage: ComponentPageFixture): Promise<Page> {
    const page = await componentPage.open({
      entry: modalEntry,
      theme: 'light',
      viewport: phone,
      fixtureName: 'sheet',
    });
    await expect(
      page.locator('dialog[data-cinder-sheet="docked"] .cinder-modal__panel'),
    ).toBeVisible();
    return page;
  }

  test('docks with a 20px top radius, a square bottom, an upward shadow and 32px under the content', async ({
    componentPage,
  }) => {
    const page = await openModalSheet(componentPage);
    const panel = page.locator('.cinder-modal__panel');

    await expect(panel).toHaveCSS('border-top-left-radius', '20px');
    await expect(panel).toHaveCSS('border-top-right-radius', '20px');
    await expect(panel).toHaveCSS('border-bottom-left-radius', '0px');
    await expect(panel).toHaveCSS('border-bottom-right-radius', '0px');
    const shadow = await panel.evaluate((element) => getComputedStyle(element).boxShadow);
    expect(shadow).toMatch(/0px -\d+px \d+px/);
    const paddingBottom = await panel.evaluate(
      (element) => getComputedStyle(element).paddingBottom,
    );
    expect(Number.parseFloat(paddingBottom)).toBeGreaterThanOrEqual(32);
    await expect(page.locator('.cinder-modal__grabber')).toBeVisible();

    const dialogBox = await page.locator('dialog[data-cinder-sheet="docked"]').boundingBox();
    const panelBox = await panel.boundingBox();
    if (dialogBox === null || panelBox === null) throw new Error('The sheet has no layout box.');
    expect(Math.abs(panelBox.y + panelBox.height - phone.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(panelBox.width - phone.width)).toBeLessThanOrEqual(1);
  });

  test('the close control is a 36px icon button named Close with a "Close (Esc)" tooltip', async ({
    componentPage,
  }) => {
    const page = await openModalSheet(componentPage);
    const close = page.getByRole('button', { name: 'Close', exact: true });

    await expect(close).toBeVisible();
    const box = await close.boundingBox();
    if (box === null) throw new Error('The close button has no layout box.');
    expect(box.width).toBeCloseTo(36, 0);
    expect(box.height).toBeCloseTo(36, 0);
    await expect(close).toHaveText('');
    await expect(close.locator('kbd')).toHaveCount(0);

    await close.hover();
    await expect(page.getByRole('tooltip')).toHaveText('Close (Esc)');
  });
});
