/**
 * Settings › Allowed models (board PageSettingsSections, "Allowed models, /settings/allowed-models")
 * and the Settings shell at the three widths (board ResponsiveAndDark, "Settings", "Phone" and
 * "Tablet"). The sample world has no provider connected, so its page is the empty one; the main
 * host has Anthropic connected, so its page lists models, takes an edit and saves it. The sample
 * world's page also carries the restart banner, which is what the phone and tablet checks read.
 *
 * Each captioned state is captured for the design review (`design-review-capture.ts`) at the widths
 * the design draws it at.
 */
import type { APIRequestContext, Locator, Page } from '@playwright/test';

import { ALLOWED_MODELS_COPY } from '../../src/app/copy.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_BASE_URL, E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';
import { withSampleCatalog } from './sample-catalog.ts';
import { bureauCall } from './task-support.ts';

const SOURCE = 'settings-allowed-models.spec.ts';
const ROUTE = '/settings/allowed-models';

/** Captures the screen at the three widths Settings is drawn at: desktop, tablet and phone. */
async function captureAtEveryWidth(page: Page, state: string, route = ROUTE) {
  for (const width of [1280, 768, 375] as const) {
    await page.setViewportSize({ width, height: 900 });
    await captureForDesignReview(page, { route, state, source: SOURCE });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function open(page: Page, origin: string, width = 1280, route = ROUTE) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${origin}${route}`);
  await expect(page.locator('[data-view="settings"]')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

const preferRow = (page: Page) => page.locator('[data-setting="preferences.prefer"]');
const effortRow = (page: Page) => page.locator('[data-setting="preferences.effort"]');
const actionsBar = (page: Page) => page.getByRole('group', { name: 'Form actions' });

type Snapshot = { values: Record<string, unknown>; revision: number };

async function snapshotOf(request: APIRequestContext): Promise<Snapshot> {
  return (await bureauCall(request, 'bureau.settings.get', {})) as Snapshot;
}

/** The model policy the Bureau holds now. */
async function policyOf(request: APIRequestContext): Promise<unknown> {
  const snapshot = await snapshotOf(request);
  return snapshot.values['modelPolicy'];
}

/** The width of an element, rounded to a whole pixel. */
async function widthOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  return Math.round(box?.width ?? 0);
}

/** Puts the model policy back to what it held, one revision on, as a person's own save would. */
async function restorePolicy(request: APIRequestContext, original: unknown) {
  const current = await snapshotOf(request);
  const revision = (current.values['modelPolicy'] as { policyRevision?: number } | undefined)
    ?.policyRevision;
  if (revision === (original as { policyRevision?: number } | undefined)?.policyRevision) return;
  await bureauCall(request, 'bureau.settings.update', {
    patch: {
      modelPolicy: {
        ...(original as object | undefined),
        policyRevision: (revision ?? 0) + 1,
      },
    },
    expectedRevision: current.revision,
  });
}

test.describe('Settings › Allowed models, no provider connected', () => {
  test('is the empty page: a muted line with a link to Providers, then the preferences', async ({
    page,
    checkA11y,
  }) => {
    await open(page, E2E_SHOWCASE_URL);
    await expect(page.getByRole('heading', { level: 1, name: 'Allowed models' })).toBeVisible();
    await expect(page.getByText(ALLOWED_MODELS_COPY.intro)).toBeVisible();
    await expect(page.locator('main h2')).toHaveText(['Models', 'Preferences']);
    await expect(page.getByText(ALLOWED_MODELS_COPY.models.description)).toBeVisible();
    const empty = page.getByTestId('allowed-models-empty');
    await expect(empty).toContainText(ALLOWED_MODELS_COPY.models.empty);
    await expect(empty.getByRole('link', { name: 'Go to Providers' })).toHaveAttribute(
      'href',
      '/settings/models',
    );
    // No warning box and no checkboxes, and nothing beside the title until something changes.
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(page.locator('main .cinder-alert')).toHaveCount(0);
    await expect(actionsBar(page)).toHaveCount(0);

    await expect(page.getByText(ALLOWED_MODELS_COPY.preferences.description)).toBeVisible();
    await expect(preferRow(page)).toContainText('Prefer');
    await expect(preferRow(page)).toContainText('preferences.prefer');
    await expect(preferRow(page).getByRole('combobox')).toHaveValue('neither');
    await expect(effortRow(page)).toContainText('Default effort');
    await expect(effortRow(page)).toContainText('preferences.effort');
    await expect(effortRow(page).getByRole('combobox')).toHaveValue('high');
    await expect(page.getByText(ALLOWED_MODELS_COPY.note)).toBeVisible();

    // The shell: breadcrumb, Settings active, and the section navigation as a 170px column.
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Settings');
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(
      'Allowed models',
    );
    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    await expect(nav.getByRole('link')).toHaveText([
      'General',
      'Models',
      'Allowed models',
      'A2A',
      'Plugins',
      'Data and retention',
      'API reference',
    ]);
    await expect(nav.getByRole('link', { name: 'Allowed models' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(await widthOf(nav)).toBe(170);
    await checkA11y('allowed models, no provider, at 1280px');
    await captureAtEveryWidth(page, 'no-provider');
  });

  test('carries the restart banner of the sample world, with Revert and Restart now', async ({
    page,
  }) => {
    await open(page, E2E_SHOWCASE_URL);
    const banner = page.getByTestId('settings-restart-summary');
    await expect(banner).toContainText('1 change waits for a restart');
    await expect(banner).toContainText('Workflow claim renew interval');
    await expect(banner.getByRole('button', { name: 'Revert 1 change' })).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Restart now' })).toBeVisible();
    // A persistent notice has no dismiss.
    await expect(banner.getByRole('button', { name: 'Dismiss banner' })).toHaveCount(0);
  });
});

/**
 * Gives the policy the sample world's default effort (High), as the showcase seed does, so the main
 * host reads as the board draws "Provider connected". Returns the policy it left, one revision on.
 */
async function withDefaultEffort(request: APIRequestContext, original: unknown) {
  const current = await snapshotOf(request);
  const policy = (original ?? { policyRevision: 0 }) as {
    policyRevision?: number;
    users?: Record<string, Record<string, unknown>>;
  };
  await bureauCall(request, 'bureau.settings.update', {
    patch: {
      modelPolicy: {
        ...policy,
        users: {
          ...policy.users,
          'anonymous:local': { ...policy.users?.['anonymous:local'], defaultEffort: 'high' },
        },
        policyRevision:
          ((current.values['modelPolicy'] as { policyRevision?: number } | undefined)
            ?.policyRevision ?? 0) + 1,
      },
    },
    expectedRevision: current.revision,
  });
  return (await policyOf(request)) as { policyRevision: number };
}

test.describe('Settings › Allowed models, provider connected', () => {
  test('lists the connected provider’s models, each allowed, and saves an edit with one Save', async ({
    page,
    request,
    checkA11y,
  }) => {
    const original = await policyOf(request);
    try {
      // The board draws the sample world's catalog and its default effort, not this host's own.
      const seeded = await withDefaultEffort(request, original);
      await withSampleCatalog(page);
      await open(page, E2E_BASE_URL);
      await expect(page.getByRole('heading', { level: 3, name: 'Anthropic' })).toBeVisible();
      const models = page.locator('[data-model]');
      await expect(models).toHaveCount(3);
      for (const row of await models.all()) {
        await expect(row.getByRole('checkbox')).toBeChecked();
        await expect(row.locator('code')).toBeVisible();
      }
      const expected = [
        ['claude-opus-5-5', 'Claude Opus 5.5', 'Tools, images'],
        ['claude-sonnet-5-5', 'Claude Sonnet 5.5', 'Tools, images'],
        ['claude-haiku-5-5', 'Claude Haiku 5.5', 'Tools'],
      ] as const;
      for (const [identifier, name, abilities] of expected) {
        const row = page.locator(`[data-model="anthropic/${identifier}"]`);
        await expect(row).toContainText(name);
        await expect(row.locator('code')).toHaveText(identifier);
        await expect(row).toContainText(abilities);
      }
      const sonnet = page.locator('[data-model="anthropic/claude-sonnet-5-5"]');
      await expect(page.locator('[data-model="anthropic/claude-haiku-5-5"]')).not.toContainText(
        'images',
      );
      await expect(preferRow(page).getByRole('combobox')).toHaveValue('neither');
      await expect(effortRow(page).getByRole('combobox')).toHaveValue('high');
      await expect(page.getByTestId('allowed-models-empty')).toHaveCount(0);
      await expect(actionsBar(page)).toHaveCount(0);
      await checkA11y('allowed models with a provider, at 1280px');
      await captureAtEveryWidth(page, 'provider-connected');

      // Two edits are two unsaved changes, and the bar names what saving does.
      await sonnet.getByRole('checkbox').uncheck();
      await preferRow(page).getByRole('combobox').selectOption('speed');
      await expect(actionsBar(page)).toContainText('2 unsaved changes');
      await expect(actionsBar(page)).toContainText(ALLOWED_MODELS_COPY.effect);
      await expect(effortRow(page).getByRole('combobox')).toHaveValue('high');
      await expect(page.getByText(ALLOWED_MODELS_COPY.note)).toBeVisible();
      await checkA11y('allowed models with unsaved changes, at 1280px');
      await captureAtEveryWidth(page, 'unsaved-changes');

      await actionsBar(page).getByRole('button', { name: 'Save' }).click();
      await expect(actionsBar(page)).toHaveCount(0);
      const stored = (await policyOf(request)) as {
        policyRevision: number;
        deployment?: { deniedModels?: string[] };
        users?: Record<string, { latencyPreference?: string }>;
      };
      expect(stored.deployment?.deniedModels).toEqual(['claude-sonnet-5-5']);
      expect(stored.users?.['anonymous:local']?.latencyPreference).toBe('lowest-latency');
      expect(stored.policyRevision).toBe(seeded.policyRevision + 1);
      await page.reload();
      await expect(
        page.locator('[data-model="anthropic/claude-sonnet-5-5"]').getByRole('checkbox'),
      ).not.toBeChecked();
      await expect(preferRow(page).getByRole('combobox')).toHaveValue('speed');
    } finally {
      await restorePolicy(request, original);
    }
  });

  test('Reset to default puts the unsaved choices back and sends nothing', async ({
    page,
    request,
  }) => {
    const before = await snapshotOf(request);
    await open(page, E2E_BASE_URL);
    const haiku = page.locator('[data-model="anthropic/claude-haiku-4-5"]').getByRole('checkbox');
    await haiku.uncheck();
    await expect(actionsBar(page)).toContainText('1 unsaved change');
    await actionsBar(page).getByRole('button', { name: ALLOWED_MODELS_COPY.reset }).click();
    await expect(haiku).toBeChecked();
    await expect(actionsBar(page)).toHaveCount(0);
    const after = await snapshotOf(request);
    expect(after.revision).toBe(before.revision);
  });

  test('save failed: the choices stay as ticked, a danger alert says what happened, and Save is the retry', async ({
    page,
    pageErrors,
    request,
  }) => {
    pageErrors.expectEvery({
      pattern: /Failed to load resource|ERR_CONNECTION_FAILED|status of 5\d\d/,
      reason: 'the test refuses the save, so the request fails',
    });
    const original = await policyOf(request);
    try {
      await open(page, E2E_BASE_URL);
      await page.route('**/bureau/jsonrpc', async (route) => {
        const body = route.request().postDataJSON() as { method?: string } | null;
        if (body?.method === 'bureau.settings.update') {
          await route.abort('connectionfailed');
          return;
        }
        await route.continue();
      });
      const sonnet = page.locator('[data-model="anthropic/claude-sonnet-5"]').getByRole('checkbox');
      await sonnet.uncheck();
      await actionsBar(page).getByRole('button', { name: 'Save' }).click();
      await expect(actionsBar(page)).toContainText(ALLOWED_MODELS_COPY.saveFailed.title);
      await expect(actionsBar(page)).toContainText(ALLOWED_MODELS_COPY.saveFailed.didNotAnswer);
      await expect(actionsBar(page)).toContainText(ALLOWED_MODELS_COPY.saveFailed.stillHere);
      await expect(sonnet).not.toBeChecked();
      await expect(actionsBar(page).getByRole('button', { name: 'Save' })).toBeEnabled();
      await captureAtEveryWidth(page, 'save-failed');
    } finally {
      await restorePolicy(request, original);
    }
  });
});

test.describe('Settings at the three widths', () => {
  test('phone: the section nav is a Section select above the content, and Restart now is a full-width 44px button', async ({
    page,
    checkA11y,
  }) => {
    await open(page, E2E_SHOWCASE_URL, 375, '/settings');
    // The label shows, the select reads the open section, and it lists every section.
    await expect(page.getByText('Section', { exact: true })).toBeVisible();
    const select = page.getByRole('combobox', { name: 'Section' });
    await expect(select).toHaveValue('/settings');
    await expect(select.locator('option')).toHaveText([
      'General',
      'Models',
      'Allowed models',
      'A2A',
      'Plugins',
      'Data and retention',
      'API reference',
    ]);
    await expect(page.getByRole('navigation', { name: 'Settings sections' })).toHaveCount(0);
    // The General content lists Human input and Wakeup with their descriptions.
    await expect(page.locator('[data-setting="tools.humanInput"]')).toContainText('Human input');
    await expect(page.locator('[data-setting="tools.wakeup"]')).toContainText(
      'Let agents schedule themselves to continue later.',
    );

    // The banner stacks its buttons, each as wide as the banner's words and 44px tall.
    const banner = page.getByTestId('settings-restart-summary');
    await expect(banner).toContainText('1 change waits for a restart');
    const bannerBox = await banner.boundingBox();
    for (const name of ['Revert 1 change', 'Restart now']) {
      const box = await banner.getByRole('button', { name }).boundingBox();
      expect(Math.round(box?.height ?? 0), `${name} is 44px tall`).toBe(44);
      // The banner has 16px of padding on each side and no side border.
      expect(Math.round(box?.width ?? 0), `${name} is full width`).toBe(
        Math.round((bannerBox?.width ?? 0) - 32),
      );
    }

    // The question before a restart opens as a bottom sheet with the same sentence.
    await banner.getByRole('button', { name: 'Restart now' }).click();
    const dialog = page.getByRole('dialog', { name: 'Restart Interborough now?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      'Running work picks up where it stopped; reviews stay waiting.',
    );
    const sheet = await dialog.boundingBox();
    expect(Math.round((sheet?.y ?? 0) + (sheet?.height ?? 0))).toBe(900);
    expect(Math.round(sheet?.width ?? 0)).toBe(375);
    await checkA11y('settings restart question as a sheet at 375px');
    await captureForDesignReview(page, {
      route: '/settings',
      state: 'restart-sheet',
      source: SOURCE,
    });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('tablet: a 170px section nav sits beside the content, and Restart now stays a secondary button', async ({
    page,
    checkA11y,
  }) => {
    await open(page, E2E_SHOWCASE_URL, 768, '/settings');
    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    await expect(nav.getByRole('link')).toHaveText([
      'General',
      'Models',
      'Allowed models',
      'A2A',
      'Plugins',
      'Data and retention',
      'API reference',
    ]);
    const navBox = await nav.boundingBox();
    expect(Math.round(navBox?.width ?? 0)).toBe(170);
    const content = await page.locator('[data-setting="tools.humanInput"]').boundingBox();
    // Beside the content, not above it.
    expect(content?.x ?? 0).toBeGreaterThan((navBox?.x ?? 0) + (navBox?.width ?? 0));
    await expect(page.getByRole('combobox', { name: 'Section' })).toHaveCount(0);
    const banner = page.getByTestId('settings-restart-summary');
    const restart = banner.getByRole('button', { name: 'Restart now' });
    await expect(restart).toHaveAttribute('data-cinder-variant', 'secondary');
    const bannerBox = await banner.boundingBox();
    expect(await widthOf(restart)).toBeLessThan((bannerBox?.width ?? 0) / 2);
    await checkA11y('settings at 768px');
    await captureForDesignReview(page, { route: '/settings', state: 'tablet', source: SOURCE });
  });

  test('the section select opens another section', async ({ page }) => {
    await open(page, E2E_SHOWCASE_URL, 375, '/settings');
    await page.getByRole('combobox', { name: 'Section' }).selectOption('/settings/allowed-models');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
    await expect(page).toHaveURL(/\/settings\/allowed-models$/);
    await expect(page.getByRole('combobox', { name: 'Section' })).toHaveValue(
      '/settings/allowed-models',
    );
  });
});
