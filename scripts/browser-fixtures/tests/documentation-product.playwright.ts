import { loadManifest, runAxe, type ComponentEntry, type Viewport } from '@lostgradient/testing';
import type { Page } from '@playwright/test';
import { expect, test } from './component-page-fixture.ts';

const entries = new Map(loadManifest().map((entry) => [entry.slug, entry] as const));
const desktop = { name: 'desktop', width: 1440, height: 1080 } as const;
const mobile = { name: 'mobile', width: 390, height: 844 } as const;

type FixturePage = {
  open(args: {
    entry: ComponentEntry;
    theme: 'light' | 'dark';
    viewport: Viewport;
    fixtureName: string;
    fixtureContentHash: string;
  }): Promise<Page>;
};

function getEntry(slug: string): ComponentEntry {
  const found = entries.get(slug);
  if (found === undefined) throw new Error(`Missing documentation fixture: ${slug}`);
  return found;
}

async function open(
  componentPage: FixturePage,
  slug: string,
  theme: 'light' | 'dark',
  viewport: Viewport,
) {
  const component = getEntry(slug);
  const fixture = component.fixtures?.find((candidate) => candidate.name === 'assertion');
  if (fixture === undefined) throw new Error(`Missing assertion fixture: ${slug}`);
  return componentPage.open({
    entry: component,
    theme,
    viewport,
    fixtureName: 'assertion',
    fixtureContentHash: fixture.fixtureContentHash,
  });
}

function expectNoAxeViolations(buckets: Awaited<ReturnType<typeof runAxe>>) {
  expect(Object.values(buckets).flat()).toHaveLength(0);
}

test.describe('documentation product contracts', () => {
  test('banner can be dismissed and reports the resulting state', async ({ componentPage }) => {
    const page = await open(componentPage, 'banner', 'light', desktop);
    await expect(page.locator('body')).toContainText('Scheduled maintenance is planned.');
    await expect(page.locator('.cinder-banner')).toHaveCount(1);
    await page.getByRole('button', { name: /dismiss/i }).click();
    await expect(page.locator('body')).toContainText('Banner dismissed.');
    await expect(page.locator('.cinder-banner')).toHaveCount(0);
  });

  test('toggle updates live state and accepts a disabled prop update', async ({
    componentPage,
  }) => {
    const page = await open(componentPage, 'toggle', 'light', desktop);
    const toggle = page.getByRole('switch', { name: 'Email notifications' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: 'Disable toggle' }).click();
    await expect(toggle).toBeDisabled();
    await expect(page.locator('body')).toContainText('Notifications are enabled.');
  });

  for (const slug of [
    'floating-action',
    'meter',
    'phone-input',
    'pin-input',
    'progress',
    'rating',
  ]) {
    for (const viewport of [desktop, mobile]) {
      test(`${slug} has no critical accessibility violations at ${viewport.name}`, async ({
        componentPage,
      }) => {
        const page = await open(componentPage, slug, 'light', viewport);
        const buckets = await runAxe(
          page,
          { slug, theme: 'light', viewport: viewport.name, fixture: 'assertion' },
          { include: '#app' },
        );
        expectNoAxeViolations(buckets);
      });
    }
  }

  test('chart, table, and keyboard shortcut contracts mount', async ({ componentPage }) => {
    const chart = await open(componentPage, 'bar-chart', 'light', desktop);
    await expect(chart.locator('.cinder-bar-chart')).toHaveCount(3);
    const table = await open(componentPage, 'data-table', 'light', desktop);
    await expect(table.locator('.cinder-data-table')).toHaveCount(1);
    const shortcuts = await open(componentPage, 'keyboard-shortcuts', 'light', desktop);
    await expect(shortcuts.locator('.cinder-keyboard-shortcuts')).toContainText(
      'Open command palette',
    );
    await expect(shortcuts.locator('.cinder-keyboard-shortcuts')).toContainText('Undo');
  });

  test('marquee, masonry, and visually hidden preserve their product semantics', async ({
    componentPage,
  }) => {
    const marquee = await open(componentPage, 'marquee', 'light', desktop);
    const labelledMarquee = marquee.locator('#example-mount-label');
    await expect(labelledMarquee.getByRole('region', { name: 'Announcements' })).toContainText(
      'Scheduled maintenance',
    );
    await labelledMarquee.getByLabel('label').fill('Release notes');
    await expect(labelledMarquee.getByRole('region', { name: 'Release notes' })).toContainText(
      'Scheduled maintenance',
    );
    await labelledMarquee.getByLabel('label').fill('');
    await expect(labelledMarquee.locator('.cinder-marquee')).toBeVisible();
    await expect(labelledMarquee.locator('[role="region"]')).toHaveCount(0);
    const masonry = await open(componentPage, 'masonry', 'light', desktop);
    await expect(masonry.locator('.cinder-masonry')).toHaveCount(1);
    await expect(masonry.locator('.cinder-masonry > article')).toHaveCount(3);
    await expect(masonry.locator('.cinder-masonry')).toContainText('Item 1');
    const hidden = await open(componentPage, 'visually-hidden', 'light', desktop);
    await expect(hidden.getByRole('button', { name: /copy code to clipboard/i })).toHaveCount(1);
    const dynamicHidden = hidden.getByTestId('dynamic-visually-hidden');
    await expect(dynamicHidden.locator('span.cinder-sr-only')).toHaveText('Copy code to clipboard');
    await hidden.getByLabel('as').selectOption('textarea');
    await expect(dynamicHidden.locator('textarea.cinder-sr-only')).toHaveText(
      'Copy code to clipboard',
    );
    await expect(dynamicHidden.locator('textarea.cinder-sr-only span')).toHaveCount(0);
    const hiddenText = dynamicHidden.getByText('Copy code to clipboard', { exact: true });
    await expect(hiddenText).toBeAttached();
    await expect(hiddenText).toHaveCSS('position', 'absolute');
  });

  for (const slug of ['checkbox-group', 'pin-input', 'sortable-list', 'data-table']) {
    test(`${slug} fits narrow component widths`, async ({ componentPage }) => {
      const page = await open(componentPage, slug, 'light', {
        name: 'mobile',
        width: 320,
        height: 844,
      });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      );
      expect(overflow).toBe(true);
    });
  }
});
