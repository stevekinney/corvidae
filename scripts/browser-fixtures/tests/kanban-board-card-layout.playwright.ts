import { fixtureRoute } from '@lostgradient/testing/playwright/layout-fixture';
import { expect, test, type Locator } from '@playwright/test';
const KANBAN_ROUTE = fixtureRoute('kanban-board');

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return bounds!;
}

test.describe('KanbanBoard built-in card layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(KANBAN_ROUTE, { waitUntil: 'load' });
  });

  test('puts the title on top, then the avatar and full name with the priority at the inline end', async ({
    page,
  }) => {
    const card = page.locator('.cinder-kanban-board__card').filter({ hasText: 'Inventory alerts' });
    const title = card.locator('.cinder-kanban-board__card-title');
    const meta = card.locator('.cinder-kanban-board__card-meta');
    const avatar = meta.locator('.cinder-avatar');
    // The visible name, not the avatar's own hidden copy of it.
    const name = meta.locator('.cinder-kanban-board__card-meta-start > span:not(.cinder-avatar)');
    await expect(name).toHaveText('Mina Okafor');
    const badge = meta.locator('.cinder-kanban-board__card-trailing').getByText('High');
    await expect(title).toHaveText('Inventory alerts');
    const [titleBox, metaBox, avatarBox, nameBox, badgeBox] = await Promise.all([
      box(title),
      box(meta),
      box(avatar),
      box(name),
      box(badge),
    ]);
    // Title above the meta row; avatar, name and badge share the row's centre line.
    expect(titleBox.y + titleBox.height).toBeLessThanOrEqual(metaBox.y);
    const centre = (bounds: { y: number; height: number }) => bounds.y + bounds.height / 2;
    expect(Math.abs(centre(avatarBox) - centre(nameBox))).toBeLessThanOrEqual(1);
    expect(Math.abs(centre(badgeBox) - centre(nameBox))).toBeLessThanOrEqual(1);
    expect(nameBox.x).toBeGreaterThan(avatarBox.x + avatarBox.width);
    expect(badgeBox.x).toBeGreaterThan(nameBox.x + nameBox.width);
    expect(Math.abs(badgeBox.x + badgeBox.width - (metaBox.x + metaBox.width))).toBeLessThanOrEqual(
      1,
    );
    // The name is read once: the avatar is hidden from assistive technology.
    await expect(avatar).toHaveAttribute('aria-hidden', 'true');
  });
});
