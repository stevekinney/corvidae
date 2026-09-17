import type { Page } from '@playwright/test';
import { loadManifest, type ComponentEntry, type Viewport } from '@repo/testing';
import { expect, test } from './component-page-fixture.ts';

const entries = new Map(loadManifest().map((entry) => [entry.slug, entry] as const));
const themes = ['light', 'dark'] as const;
const viewports = [
  { name: 'mobile', width: 375, height: 900 },
  { name: 'tablet', width: 768, height: 900 },
  { name: 'desktop', width: 1280, height: 900 },
] as const satisfies readonly Viewport[];
const missingComponents = [
  'chat-navigation-rail',
  'chat-sub-session',
  'citation',
  'code-location',
  'donut-chart',
  'find-bar',
  'form',
  'guidance-region',
  'host-provider',
  'inline-confirm',
  'key-value-editor',
  'modal-region',
  'parameter-field',
  'policy-lock',
  'preview-panel',
  'quota-meter',
  'relative-time',
  'setting-row',
  'shortcut-field',
  'stack',
  'terminal-frame',
  'terminal-output',
  'zoom-pan-viewer',
] as const;

function entryFor(slug: string): ComponentEntry {
  const entry = entries.get(slug);
  if (entry === undefined) throw new Error(`Missing fixture entry for ${slug}`);
  return entry;
}

type ComponentPage = {
  open(args: {
    entry: ComponentEntry;
    theme: (typeof themes)[number];
    viewport: Viewport;
    fixtureName: string;
    fixtureContentHash: string;
  }): Promise<Page>;
};

async function open(
  componentPage: ComponentPage,
  slug: string,
  theme: (typeof themes)[number],
  viewport: Viewport,
) {
  const entry = entryFor(slug);
  const fixture = entry.fixtures?.find((candidate) => candidate.name === 'assertion');
  if (fixture === undefined) throw new Error(`Missing assertion fixture for ${slug}`);
  return componentPage.open({
    entry,
    theme,
    viewport,
    fixtureName: fixture.name,
    fixtureContentHash: fixture.fixtureContentHash,
  });
}

type Oracle = (page: Page) => Promise<void>;

const oracles: Record<(typeof missingComponents)[number], Oracle> = {
  'chat-navigation-rail': async (page) => {
    await expect(page.locator('.chat-navigation-rail')).toHaveAttribute(
      'aria-label',
      'Release messages',
    );
    await expect(page.locator('.chat-navigation-rail-description')).toContainText(
      'Review the release checklist',
    );
  },
  'chat-sub-session': async (page) => {
    await expect(page.getByRole('log', { name: 'Delegated task transcript' })).toContainText(
      'Inspect the delegated task',
    );
  },
  citation: async (page) => {
    await expect(page.locator('.cinder-citation')).toContainText('Source');
  },
  'code-location': async (page) => {
    await expect(page.locator('.cinder-code-location')).toContainText(
      'src/routes/+page.svelte:42:7',
    );
  },
  'donut-chart': async (page) => {
    await expect(page.locator('.cinder-donut-chart figure')).toHaveAttribute(
      'aria-label',
      'Workload',
    );
    await expect(page.locator('.cinder-donut-chart')).toContainText('Build');
  },
  'find-bar': async (page) => {
    await expect(page.locator('.cinder-find-bar input[type="search"]')).toHaveValue('terminal');
  },
  form: async (page) => {
    await expect(page.locator('.cinder-form input')).toHaveValue('Ada Lovelace');
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
  },
  'guidance-region': async (page) => {
    await expect(page.getByRole('button', { name: 'Show welcome guidance' })).toBeVisible();
  },
  'host-provider': async (page) => {
    await expect(page.locator('.cinder-host-provider')).toContainText(
      'Desktop-aware application surface',
    );
  },
  'inline-confirm': async (page) => {
    await expect(page.locator('.cinder-inline-confirm')).toContainText('Remove this workspace?');
    await expect(page.getByRole('button', { name: 'Remove workspace' })).toBeVisible();
  },
  'key-value-editor': async (page) => {
    await expect(page.locator('.cinder-key-value-editor input').nth(0)).toHaveValue('HOST');
    await expect(page.locator('.cinder-key-value-editor input').nth(1)).toHaveValue('localhost');
  },
  'modal-region': async (page) => {
    await expect(page.getByRole('button', { name: 'Open confirmation' })).toBeVisible();
  },
  'parameter-field': async (page) => {
    await expect(page.locator('.cinder-parameter-field')).toContainText('Timeout');
    await expect(page.locator('.cinder-parameter-field')).toContainText('30 seconds');
  },
  'policy-lock': async (page) => {
    await expect(page.locator('.cinder-policy-lock')).toContainText('Managed by your organization');
  },
  'preview-panel': async (page) => {
    await expect(page.locator('.cinder-preview-panel')).toContainText('Artifact preview');
    await expect(page.locator('.cinder-preview-panel')).toContainText('Preview content is ready.');
  },
  'quota-meter': async (page) => {
    await expect(page.locator('.cinder-quota-meter [role="meter"]')).toHaveAttribute(
      'aria-valuetext',
      '72 of 100 used',
    );
  },
  'relative-time': async (page) => {
    await expect(page.locator('time.cinder-relative-time')).toHaveAttribute(
      'datetime',
      '2026-09-15T12:00:00.000Z',
    );
  },
  'setting-row': async (page) => {
    await expect(page.locator('.cinder-setting-row')).toContainText('Display name');
    await expect(page.locator('.cinder-setting-row input')).toHaveValue('Ada Lovelace');
  },
  'shortcut-field': async (page) => {
    await expect(page.locator('.cinder-shortcut-field [role="textbox"]')).toHaveAttribute(
      'aria-label',
      'Open command palette',
    );
    await expect(page.locator('.cinder-shortcut-field kbd')).toHaveText(['Meta', 'K']);
  },
  stack: async (page) => {
    await expect(page.locator('.cinder-stack')).toContainText('Account settings');
    await expect(page.locator('.cinder-stack')).toContainText(
      'Manage your profile and preferences.',
    );
  },
  'terminal-frame': async (page) => {
    await expect(page.locator('.cinder-terminal-frame')).toContainText('Build shell');
    await expect(page.locator('.cinder-terminal-frame')).toContainText('Build complete.');
  },
  'terminal-output': async (page) => {
    await expect(page.locator('.cinder-terminal-output')).toContainText('PASS');
    await expect(page.locator('.cinder-terminal-output')).toContainText('WARN');
  },
  'zoom-pan-viewer': async (page) => {
    await expect(page.locator('.cinder-zoom-pan-viewer')).toContainText('Architecture diagram');
  },
};

test.describe('missing standalone defaults', () => {
  for (const slug of missingComponents) {
    for (const theme of themes) {
      for (const viewport of viewports) {
        test(`${slug} renders authored content in ${theme}/${viewport.name}`, async ({
          componentPage,
        }) => {
          const page = await open(componentPage, slug, theme, viewport);
          await oracles[slug](page);
        });
      }
    }
  }
});
