import { runAxe, THEME_STORAGE_KEY } from '@lostgradient/testing';
import { expect, test, type Page } from '@playwright/test';
import { openFixture } from './overlay-fixture.ts';

test.use({ colorScheme: 'dark', reducedMotion: 'reduce', viewport: { width: 1280, height: 900 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, 'dark'), THEME_STORAGE_KEY);
});

const HARNESS = '[data-testid="lightbox-nested-overlay-harness"]';

async function openDrawerThenLightbox(page: Page) {
  const harness = page.locator(HARNESS);
  await harness.getByRole('button', { name: 'Open drawer' }).click();
  const drawer = page.locator('.cinder-drawer__panel');
  await expect(drawer).toBeVisible();

  await harness.locator('[data-testid="open-lightbox"]').click();
  const lightbox = page.locator('dialog.lightbox-modal[open]');
  await expect(lightbox).toBeVisible();

  return { drawer, lightbox };
}

test.describe('nested overlay — image lightbox inside a Drawer', () => {
  test('Escape dismisses only the lightbox, leaving the Drawer open', async ({ page }) => {
    await openFixture(page, 'chat', { fixtureName: 'private-lightbox-nested-overlay' });
    const { drawer, lightbox } = await openDrawerThenLightbox(page);

    await page.keyboard.press('Escape');
    await expect(lightbox).toBeHidden();
    await expect(drawer).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
  });

  test('scroll stays locked after the lightbox closes while the Drawer is still open (lightbox-then-drawer order)', async ({
    page,
  }) => {
    await openFixture(page, 'chat', { fixtureName: 'private-lightbox-nested-overlay' });
    const { drawer, lightbox } = await openDrawerThenLightbox(page);
    await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');

    await page.keyboard.press('Escape');
    await expect(lightbox).toBeHidden();
    await expect(drawer).toBeVisible();
    await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');

    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
  });

  test('closing the Drawer tears down the nested lightbox too, and scroll lock fully releases (drawer-then-lightbox joint teardown)', async ({
    page,
  }) => {
    await openFixture(page, 'chat', { fixtureName: 'private-lightbox-nested-overlay' });
    const { drawer, lightbox } = await openDrawerThenLightbox(page);
    await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');

    await page.locator('.cinder-drawer__close').dispatchEvent('click');
    await expect(drawer).toBeHidden();
    await expect(lightbox).toBeHidden();
    await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
  });

  test('the lightbox exposes role="dialog"/aria-modal from Modal\'s own markup, not a hand-rolled one', async ({
    page,
  }) => {
    await openFixture(page, 'chat', { fixtureName: 'private-lightbox-nested-overlay' });
    const { lightbox } = await openDrawerThenLightbox(page);

    await expect(lightbox).toHaveAttribute('role', 'dialog');
    await expect(lightbox).toHaveAttribute('aria-modal', 'true');
    await expect(lightbox).toHaveAttribute('aria-label', 'Image viewer');
  });

  test('has no critical/serious axe violations with the lightbox open over the Drawer', async ({
    page,
  }) => {
    await openFixture(page, 'chat', { fixtureName: 'private-lightbox-nested-overlay' });
    await openDrawerThenLightbox(page);
    const buckets = await runAxe(
      page,
      {
        slug: 'chat',
        theme: 'dark',
        viewport: 'desktop',
        fixture: 'private-lightbox-nested-overlay',
      },
      { include: HARNESS },
    );

    expect(buckets.critical, JSON.stringify(buckets.critical, null, 2)).toHaveLength(0);
    expect(buckets.serious, JSON.stringify(buckets.serious, null, 2)).toHaveLength(0);
  });
});

test('navigating then closing keeps the navigated image visible while data-cinder-closing is set', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openFixture(page, 'chat', {
    fixtureName: 'private-lightbox-nested-overlay',
    snapshot: false,
  });
  const { lightbox } = await openDrawerThenLightbox(page);

  await expect(lightbox.locator('img')).toHaveAttribute('alt', 'First image');
  await lightbox.getByRole('button', { name: 'Next image' }).click();
  await expect(lightbox.locator('img')).toHaveAttribute('alt', 'Second image');

  await lightbox.getByRole('button', { name: 'Close image viewer' }).click();
  const panel = page.locator('.cinder-modal__panel[data-cinder-closing]');
  await expect(panel).toBeVisible();
  await expect(panel.locator('img')).toHaveAttribute('alt', 'Second image');
  await expect(lightbox).toBeHidden();
});
