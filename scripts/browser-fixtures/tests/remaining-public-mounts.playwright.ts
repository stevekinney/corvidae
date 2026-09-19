import { loadManifest, type ComponentEntry, type Theme, type Viewport } from '@corvidae/testing';
import type { Page } from '@playwright/test';
import { expect, test } from './component-page-fixture.ts';
import { productOracles, type ProductOracle } from './remaining-public-mount-oracles.ts';

type InteractiveBehavior = NonNullable<ProductOracle['behavior']>;

const interactiveBehaviors = {
  'alert-dialog': async (page) => {
    await page.getByRole('button', { name: 'Open alert dialog' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('Session requires attention');
  },
  backdrop: async (page) => {
    await page.getByRole('button', { name: 'Show dimmed backdrop' }).click();
    const content = page.getByText('Loading… click anywhere to dismiss');
    await expect(content).toBeVisible();
    await page.locator('.cinder-backdrop').click({ position: { x: 8, y: 8 } });
    await expect(content).toBeHidden();
  },
  'command-palette': async (page) => {
    await page.getByRole('button', { name: 'Open palette' }).click();
    await expect(page.getByRole('dialog')).toContainText('New file');
  },
  'confirm-dialog': async (page) => {
    await page.getByRole('button', { name: 'Delete item' }).click();
    await expect(page.getByRole('dialog')).toContainText('Delete item?');
  },
  drawer: async (page) => {
    await page.getByRole('button', { name: 'Open drawer' }).click();
    await expect(page.getByRole('dialog')).toContainText('Drawer panel');
  },
  'focus-trap': async (page) => {
    await page.getByRole('button', { name: 'Open focus trap' }).click();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeFocused();
  },
  portal: async (page) => {
    await page.getByRole('button', { name: 'Show portal' }).click();
    const portaledContent = page.getByText('Portaled content');
    await expect(portaledContent).toBeVisible();
    const isPortaled = await portaledContent.evaluate(
      (element) => document.body.contains(element) && element.closest('#app') === null,
    );
    expect(isPortaled).toBe(true);
  },
  sidebar: async (page) => {
    const sidebarTrigger = page.getByRole('button', { name: /sidebar/ });
    const sidebarText = await sidebarTrigger.innerText();
    if (sidebarText.startsWith('Expand')) await sidebarTrigger.click();
    await expect(page.getByRole('navigation', { name: 'Workspace sections' })).toBeVisible();
  },
  'toast-region': async (page) => {
    await page.getByRole('button', { name: 'Dismiss-after-action' }).click();
    await expect(page.getByText('Item moved to trash.')).toBeVisible();
  },
} satisfies Record<InteractiveBehavior, (page: Page) => Promise<void>>;

const entries = new Map(loadManifest().map((entry) => [entry.slug, entry] as const));
const themes: Theme[] = ['light', 'dark'];
const viewports: Viewport[] = [
  { name: 'mobile', width: 375, height: 900 },
  { name: 'tablet', width: 768, height: 900 },
  { name: 'desktop', width: 1280, height: 900 },
];
const remainingSlugs = [
  'action-row',
  'alert',
  'alert-dialog',
  'approval-card',
  'aspect-ratio',
  'autocomplete',
  'avatar',
  'backdrop',
  'badge',
  'breadcrumbs',
  'button-group',
  'calendar',
  'callout',
  'capability-gate',
  'checkbox',
  'chip',
  'choice-grid',
  'click-away-listener',
  'code-block',
  'collapsible',
  'color-field',
  'color-swatch-picker',
  'command-palette',
  'confirm-dialog',
  'connection-indicator',
  'container',
  'context-menu',
  'copy-button',
  'data-list',
  'description-list',
  'diff-statistics',
  'divider',
  'drawer',
  'empty-state',
  'feed',
  'feed-boundary',
  'file-upload',
  'filter-bar',
  'focus-trap',
  'form-field',
  'form-section',
  'grid-list',
  'image',
  'inline-loading',
  'invocation-rule-builder',
  'json-editor',
  'json-viewer',
  'kanban-board',
  'kbd',
  'link',
  'load-more',
  'matrix-chart',
  'media-controls',
  'message',
  'page-header',
  'pagination',
  'payload-inspector',
  'permission-matrix',
  'portal',
  'pricing-card',
  'qr-code',
  'radio-group',
  'resizable-panels',
  'run-step-timeline',
  'schedule-builder',
  'scroll-area',
  'search-field',
  'secret-value-field',
  'share-card',
  'shortcut-hint',
  'sidebar',
  'skeleton',
  'skip-link',
  'slider',
  'source-diff-viewer',
  'sparkbar',
  'spectrogram',
  'spectrum-chart',
  'spinner',
  'stacked-list-item',
  'statistic-group',
  'status-dot',
  'surface',
  'table-of-contents',
  'tag-input',
  'textarea',
  'time-field',
  'timeline',
  'toast-region',
  'toolbar',
  'transfer-list',
  'waveform',
  'label',
  'locale-provider',
  'chat-composer-popover',
  'chat-conversation-header',
  'chat-conversation-list',
  'diff-viewer',
];

function fixtureEntry(slug: string): ComponentEntry {
  const entry = entries.get(slug);
  if (entry === undefined) throw new Error(`Missing remaining mount entry: ${slug}`);
  return entry;
}

for (const slug of remainingSlugs) {
  for (const theme of themes) {
    for (const viewport of viewports) {
      test(`${slug} renders a source-derived mount in ${theme}/${viewport.name}`, async ({
        componentPage,
      }) => {
        const entry = fixtureEntry(slug);
        const fixture = entry.fixtures?.find((candidate) => candidate.name === 'assertion');
        if (fixture === undefined) throw new Error(`Missing assertion fixture for ${slug}`);
        const pageErrors: string[] = [];
        const consoleErrors: string[] = [];
        const page = await componentPage.open({
          entry,
          theme,
          viewport,
          fixtureName: fixture.name,
          fixtureContentHash: fixture.fixtureContentHash,
          onPage: (nextPage) => {
            nextPage.on('pageerror', (error) => pageErrors.push(error.message));
            nextPage.on('console', (message) => {
              if (message.type() === 'error') consoleErrors.push(message.text());
            });
          },
        });
        const oracle = productOracles[slug];
        if (oracle === undefined) throw new Error(`Missing product oracle for ${slug}`);
        const componentRoot = page.locator(oracle.selector).first();
        if (oracle.visibility === 'attached') {
          await expect(componentRoot, `${slug} must render its component root`).toBeAttached();
        } else {
          await expect(componentRoot, `${slug} must render its component root`).toBeVisible();
        }
        if (oracle.text !== undefined) {
          await expect(componentRoot, `${slug} must render ${oracle.text}`).toContainText(
            oracle.text,
          );
        } else if (oracle.attribute !== undefined) {
          await expect(
            componentRoot,
            `${slug} must expose ${oracle.attribute.name}`,
          ).toHaveAttribute(oracle.attribute.name, oracle.attribute.value);
        } else if (oracle.descendant !== undefined) {
          await expect(
            componentRoot.locator(oracle.descendant).first(),
            `${slug} must render ${oracle.descendant}`,
          ).toBeVisible();
        }
        if (oracle.behavior !== undefined) await interactiveBehaviors[oracle.behavior](page);
        expect(pageErrors, `${slug} must not raise page errors`).toEqual([]);
        expect(consoleErrors, `${slug} must not log browser errors`).toEqual([]);
      });
    }
  }
}
