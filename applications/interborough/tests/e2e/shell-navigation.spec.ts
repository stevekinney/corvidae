/**
 * The application shell as a person drives it (COR-1834): each `g` shortcut opens its
 * destination, `?` opens the map of every shortcut from the registry, including the keys
 * ListDetail handles itself, the sidebar's icon rail and the density are remembered across a
 * reload, and the top bar's breadcrumb trail follows the route.
 */
import { VIEW_COPY } from '../../src/app/copy.ts';
import { expect, test } from './fixtures.ts';

const DESKTOP = { width: 1280, height: 800 } as const;

/** Each `g` shortcut U1 registers: its letter, the address it opens, and the sidebar item's name. */
const SHORTCUTS = [
  { letter: 'c', path: '/chats', label: VIEW_COPY.chat.label },
  { letter: 'v', path: '/reviews', label: VIEW_COPY.reviews.label },
  { letter: 'a', path: '/agents', label: VIEW_COPY.agents.label },
  { letter: 'p', path: '/capabilities', label: VIEW_COPY.capabilities.label },
  { letter: 'w', path: '/workflows', label: VIEW_COPY.workflows.label },
  { letter: 'r', path: '/runs', label: VIEW_COPY.runs.label },
  { letter: 's', path: '/schedules', label: VIEW_COPY.schedules.label },
  { letter: 'l', path: '/goals', label: VIEW_COPY.goals.label },
  { letter: 'e', path: '/health', label: VIEW_COPY.health.label },
  { letter: 'n', path: '/settings', label: VIEW_COPY.settings.label },
] as const;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize(DESKTOP);
});

test('each g shortcut opens its destination, and the sidebar marks it current', async ({
  page,
}) => {
  await page.goto('/agents');
  const navigation = page.getByRole('navigation', { name: 'Views' });
  await expect(navigation).toBeVisible();
  for (const shortcut of SHORTCUTS) {
    await page.keyboard.press('g');
    await page.keyboard.press(shortcut.letter);
    await expect(page).toHaveURL(new RegExp(`${shortcut.path}$`));
    await expect(
      navigation.getByRole('link', { name: new RegExp(`^${shortcut.label}`) }),
    ).toHaveAttribute('aria-current', 'page');
  }
});

test('? opens the map of every shortcut, with ListDetail’s J and K', async ({ page }) => {
  await page.goto('/agents');
  await expect(page.getByRole('navigation', { name: 'Views' })).toBeVisible();
  await page.keyboard.press('?');
  const map = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(map).toBeVisible();
  await expect(map.getByText('Go to Agents')).toBeVisible();
  await expect(map.getByText('Next row')).toBeVisible();
  await expect(map.getByText('Previous row')).toBeVisible();
});

test('the sidebar folds to its icon rail and stays folded across a reload', async ({ page }) => {
  await page.goto('/agents');
  const sidebar = page.locator('aside.weft-shell-sidebar');
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(sidebar).toHaveAttribute('data-cinder-collapsed', '');
  await page.reload();
  await expect(sidebar).toHaveAttribute('data-cinder-collapsed', '');
  // Every destination is still one click away on the rail.
  await expect(page.getByRole('navigation', { name: 'Views' }).getByRole('link')).toHaveCount(
    SHORTCUTS.length,
  );
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect(sidebar).not.toHaveAttribute('data-cinder-collapsed', '');
  await page.reload();
  await expect(sidebar).not.toHaveAttribute('data-cinder-collapsed', '');
});

test('compact density from quick settings applies to every view and survives a reload', async ({
  page,
}) => {
  await page.goto('/agents');
  const outlet = page.locator('main.weft-shell-outlet');
  await expect(outlet).toHaveAttribute('data-density', 'comfortable');
  await page.getByRole('button', { name: 'Quick settings' }).click();
  await page.getByRole('radio', { name: 'Compact' }).click();
  await expect(outlet).toHaveAttribute('data-density', 'compact');
  await page.reload();
  await expect(outlet).toHaveAttribute('data-density', 'compact');

  // Comfortable gives each view its own density back.
  await page.getByRole('button', { name: 'Quick settings' }).click();
  await page.getByRole('radio', { name: 'Comfortable' }).click();
  await expect(outlet).toHaveAttribute('data-density', 'comfortable');
  await page.goto('/runs');
  await expect(outlet).toHaveAttribute('data-density', 'compact');
});

test('the breadcrumb trail follows the route, and its links open their pages', async ({ page }) => {
  await page.goto('/agents/assistant/memories');
  const trail = page.getByRole('banner').getByRole('navigation', { name: 'Breadcrumb' });
  await expect(trail.getByRole('link', { name: 'Agents' })).toBeVisible();
  await expect(trail.getByText('Memory')).toHaveAttribute('aria-current', 'page');
  await trail.getByRole('link', { name: 'Agents' }).click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(trail.getByText(VIEW_COPY.agents.label)).toHaveAttribute('aria-current', 'page');
});
