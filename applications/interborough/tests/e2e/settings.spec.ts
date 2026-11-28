/**
 * `/settings` (COR-1711) against the real host: the page draws a control for every setting the
 * Bureau publishes but the model policy and the decisions, which have sections of their own (`settings-allowed-models.spec.ts` covers the first), shows the key the host locked read-only, and changes what the Bureau does.
 * `tools.humanInput` is the setting whose effect a person can see: with it off, a chat with
 * `request-human-input` asks nothing and leaves nothing to review; with it back on, the same chat
 * parks on its question and the question is waiting in Reviews.
 *
 * The settings are the deployment's and are kept in its database, so a case that changes one puts it
 * back whether it passed or not.
 */
import type { APIRequestContext, Page } from '@playwright/test';

import { HUMAN_INPUT_PROMPT } from '@lostgradient/plugin-demo';
import { SETTINGS_COPY } from '../../src/app/copy/settings.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_LOCKED_SETTING } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';
import { bureauCall, taskOfSession, waitingReviewOf } from './task-support.ts';

const WIDTHS = [375, 1280] as const;

const settingRow = (page: Page, key: string) => page.locator(`[data-setting="${key}"]`);
const humanInputSwitch = (page: Page) =>
  settingRow(page, 'tools.humanInput').getByRole('switch', { name: 'Human input' });

async function openAdvancedSettings(page: Page): Promise<void> {
  const disclosure = page.getByRole('button', { name: 'Advanced' });
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await disclosure.click();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
}

type Snapshot = { values: Record<string, unknown>; revision: number };

async function snapshotOf(request: APIRequestContext): Promise<Snapshot> {
  return (await bureauCall(request, 'bureau.settings.get', {})) as Snapshot;
}

/** What the Bureau holds for one key now. */
async function valueOf(request: APIRequestContext, key: string): Promise<unknown> {
  const snapshot = await snapshotOf(request);
  return snapshot.values[key];
}

/** The revision of the settings now. */
async function revisionOf(request: APIRequestContext): Promise<number> {
  const snapshot = await snapshotOf(request);
  return snapshot.revision;
}

/** Changes the humanInput switch through the page, which saves it as it changes, and waits for the Bureau's answer. */
async function saveHumanInput(page: Page, on: boolean): Promise<void> {
  await humanInputSwitch(page).click();
  await expect(humanInputSwitch(page)).toHaveAttribute('aria-checked', String(on));
  await expect(settingRow(page, 'tools.humanInput')).toContainText('Saved just now');
  // The form reads the settings back before it is edited again: nothing is left dirty.
  await expect(settingRow(page, 'tools.humanInput')).toHaveAttribute('data-dirty', 'false');
}

/** Starts a chat with the seeded question-asking agent and returns the session it became. */
async function startChat(page: Page): Promise<string> {
  await page.goto('/chats/new?agent=demo:request-human-input');
  const composer = page.getByRole('textbox');
  await composer.fill('Release it');
  await composer.press('Enter');
  await expect(page).toHaveURL(/\/chats\/(?!new)[^/?]+$/);
  return decodeURIComponent(new URL(page.url()).pathname.split('/').pop() ?? '');
}

/** The inbox row of the question a session is waiting on, once the Bureau lists it. */
async function reviewRowOf(page: Page, request: APIRequestContext, threadId: string) {
  const review = await waitingReviewOf(request, threadId);
  return page.locator(`[data-review-row="bureau:${review.id}"]`);
}

for (const width of WIDTHS) {
  test(`draws a control for every setting at ${width} pixels, and passes axe`, async ({
    page,
    request,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });

    const published = (
      (await bureauCall(request, 'bureau.settings.schema', {})) as {
        schema: { properties: Record<string, unknown> };
      }
    ).schema.properties;
    // The model policy has a section of its own, the decisions are on Settings › Models, and the
    // A2A push settings are on Settings › A2A; every other key is on the General page.
    // The retention windows are on Data and retention, which has its own page.
    // The scorer settings have no control yet and are set through the Bureau's settings (COR-2202).
    const keys = Object.keys(published).filter(
      (key) =>
        key !== 'modelPolicy' &&
        !key.startsWith('decisions.') &&
        !key.startsWith('retention.') &&
        !key.startsWith('scorers.'),
    );
    const sections = [
      { path: '/settings', keys: keys.filter((key) => !key.startsWith('a2a.')) },
      { path: '/settings/a2a', keys: keys.filter((key) => key.startsWith('a2a.')) },
    ];
    // Every published key is drawn on exactly one of the pages checked.
    expect(sections.flatMap((section) => section.keys)).toEqual(keys);

    for (const section of sections) {
      await page.goto(section.path);
      await expect(page.locator('[data-view="settings"]')).toHaveAttribute('data-state', 'ready');
      if (section.path === '/settings') await openAdvancedSettings(page);
      for (const key of section.keys) {
        // A value that has none is Not set, with a button to set it; every other has a control.
        await expect(
          settingRow(page, key)
            .locator('button, input, select, textarea, [role="textbox"]')
            .filter({ visible: true })
            .first(),
        ).toBeVisible();
      }
      await expect(page.getByText(/unsupported/i)).toHaveCount(0);
      await checkA11y(`settings ${section.path} at ${width}px`);
    }
  });
}

test('shows the key the host locked read-only, with the reason', async ({ page, request }) => {
  const before = await revisionOf(request);
  await page.goto('/settings');
  await openAdvancedSettings(page);

  const row = settingRow(page, E2E_LOCKED_SETTING);
  await expect(row).toHaveAttribute('data-locked', 'true');
  await expect(row).toContainText(SETTINGS_COPY.lockedMessage);
  const field = row.getByRole('textbox', { name: 'Workflow version' });
  await expect(field).toBeDisabled();
  // Every other key stays editable.
  await expect(settingRow(page, 'tools.wakeup')).toHaveAttribute('data-locked', 'false');
  await expect(settingRow(page, 'tools.wakeup').getByRole('switch')).toBeEnabled();
  // Nothing was written by looking.
  expect(await revisionOf(request)).toBe(before);
});

test('turning tools.humanInput off leaves a chat with nothing to review, and turning it on brings the question back', async ({
  page,
  request,
}) => {
  const original = await valueOf(request, 'tools.humanInput');
  expect(original, 'human input is on to begin with').not.toBe(false);
  try {
    await page.goto('/settings');
    await saveHumanInput(page, false);
    expect(await valueOf(request, 'tools.humanInput'), 'the Bureau holds the change').toBe(false);

    // A chat started now is not offered `requestHumanInput`, so its run completes without asking.
    const without = await startChat(page);
    await expect
      .poll(async () => {
        const task = await taskOfSession(request, without);
        return task.status;
      })
      .toBe('completed');
    await page.goto('/reviews');
    await expect(page.getByRole('heading', { level: 1, name: 'Reviews' })).toBeVisible();
    const listed = (await bureauCall(request, 'bureau.reviews.list', {})) as {
      reviews: Array<{ sessionId?: string }>;
    };
    expect(listed.reviews.filter((review) => review.sessionId === without)).toEqual([]);

    // Turned back on, the same chat parks on its question, and the question is waiting in Reviews.
    await page.goto('/settings');
    await saveHumanInput(page, true);
    const withIt = await startChat(page);
    await page.goto('/reviews');
    await expect(await reviewRowOf(page, request, withIt)).toContainText(HUMAN_INPUT_PROMPT);
  } finally {
    const current = await snapshotOf(request);
    if (!Object.is(JSON.stringify(current.values['tools.humanInput']), JSON.stringify(original))) {
      await bureauCall(request, 'bureau.settings.update', {
        patch: { 'tools.humanInput': original },
        expectedRevision: current.revision,
      });
    }
  }
});

test('a change made through the API shows on an open page without a reload or a focus change', async ({
  page,
  request,
}) => {
  const original = await valueOf(request, 'tools.wakeup');
  expect(original, 'wakeup is on to begin with').not.toBe(false);
  const wakeupSwitch = settingRow(page, 'tools.wakeup').getByRole('switch', { name: 'Wakeup' });
  try {
    await page.goto('/settings');
    await expect(wakeupSwitch).toHaveAttribute('aria-checked', 'true');

    // Another caller changes it. The page hears of it on its settings stream, not on a timer.
    const current = await snapshotOf(request);
    await bureauCall(request, 'bureau.settings.update', {
      patch: { 'tools.wakeup': false },
      expectedRevision: current.revision,
    });
    await expect(wakeupSwitch).toHaveAttribute('aria-checked', 'false');
  } finally {
    const latest = await snapshotOf(request);
    if (latest.values['tools.wakeup'] !== original) {
      await bureauCall(request, 'bureau.settings.update', {
        patch: { 'tools.wakeup': original },
        expectedRevision: latest.revision,
      });
    }
  }
});

test('saves a number as its field is left, and puts nothing else in the update', async ({
  page,
  request,
}) => {
  const original = await valueOf(request, 'logs.maximumLinesPerRun');
  try {
    await page.goto('/settings');
    await openAdvancedSettings(page);
    const row = settingRow(page, 'logs.maximumLinesPerRun');
    await expect(row).toBeVisible();
    const field = row.getByRole('spinbutton', { name: 'Maximum lines per run' });
    await field.fill('321');
    // Nothing is sent while the field is being typed in.
    await expect(row).not.toContainText('Saved just now');
    await settingRow(page, 'tools.wakeup').getByRole('switch').focus();
    await expect(row).toContainText('Saved just now');
    expect(await valueOf(request, 'logs.maximumLinesPerRun')).toBe(321);
    expect(await valueOf(request, 'tools.wakeup')).toBe(true);
  } finally {
    const current = await snapshotOf(request);
    if (current.values['logs.maximumLinesPerRun'] !== original) {
      await bureauCall(request, 'bureau.settings.update', {
        patch: { 'logs.maximumLinesPerRun': original },
        expectedRevision: current.revision,
      });
    }
  }
});

test('lists ⌘Enter among the shortcuts of a section that has a Save', async ({ page }) => {
  await page.goto('/settings/allowed-models');
  await expect(page.locator('[data-view="settings"]')).toHaveAttribute('data-state', 'ready');
  await expect(settingRow(page, 'preferences.prefer')).toBeVisible();
  await page.keyboard.press('?');
  const map = page.getByRole('dialog');
  await expect(map).toContainText(SETTINGS_COPY.saveAction);
  await expect(map).toContainText('⌘');
});

test('edits an object without JSON, and a model name from the catalog', async ({
  page,
  request,
}) => {
  const original = await valueOf(request, 'engine.history');
  try {
    await page.goto('/settings');
    await openAdvancedSettings(page);
    const receipts = settingRow(page, 'engine.history');
    await expect(receipts.locator('textarea')).toHaveCount(0);
    // The summarizer model is a choice of the catalog's rows, never a typed `provider/model`.
    const fallback = settingRow(page, 'context.summarizerModel');
    await expect(fallback.getByRole('combobox')).toBeVisible();
    await expect(fallback.getByRole('textbox')).toHaveCount(0);
    // A value the host has not set reads Not set, with a button that shows its fields.
    const set = receipts.getByRole('button', { name: SETTINGS_COPY.setAction });
    if ((await set.count()) > 0) await set.click();
    await expect(receipts.getByRole('spinbutton').first()).toBeVisible();
  } finally {
    const current = await snapshotOf(request);
    if (JSON.stringify(current.values['engine.history']) !== JSON.stringify(original)) {
      await bureauCall(request, 'bureau.settings.update', {
        patch: { 'engine.history': original },
        expectedRevision: current.revision,
      });
    }
  }
});

test('opens Settings API keys from desktop and clears an issued secret after dismissal and reload (/settings/api-keys)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/settings');
  await page.getByRole('link', { name: 'API keys', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/api-keys$/);
  await expect(page.getByRole('heading', { name: 'API keys', exact: true })).toHaveCount(1);
  const label = 'API keys browser check';
  const issue = page.getByRole('button', { name: 'Issue key' });
  await expect(issue).toBeVisible();
  await captureForDesignReview(page, {
    route: '/settings/api-keys',
    state: 'ready',
    source: 'settings',
  });
  await page.getByLabel('Label', { exact: true }).fill(label);
  await page.getByLabel('Target', { exact: true }).selectOption('a2a');
  await page.getByLabel('bureau.assets:read', { exact: true }).check();
  await issue.click();
  const newKey = page.getByRole('region', { name: 'New API key' });
  await expect(newKey).toBeVisible();
  const secret = await newKey.locator('code').innerText();
  expect(secret.startsWith('lgk_')).toBe(true);
  await newKey.getByRole('button', { name: 'Dismiss' }).click();
  await expect(newKey).toHaveCount(0);
  await page.reload();
  const row = page.getByRole('listitem').filter({ hasText: label });
  await expect(row).toBeVisible();
  const pageText = await page.locator('body').innerText();
  expect(pageText.includes(secret)).toBe(false);
  await row.getByRole('button', { name: 'Revoke' }).click();
  await page.getByRole('button', { name: 'Revoke key', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Revoke' })).toHaveCount(0);
});

test.describe('Settings API keys on touch', () => {
  test.use({ hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
  for (const width of [320, 375]) {
    test(`opens Settings API keys through the complete section selector at ${width}px (/settings/api-keys)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 320 ? 640 : 812 });
      await page.goto('/settings/mcp');
      await page.getByLabel('Section', { exact: true }).selectOption('/settings/api-keys');
      await expect(page).toHaveURL(/\/settings\/api-keys$/);
      await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
      const section = page.getByLabel('Section', { exact: true });
      await expect(section).toHaveValue('/settings/api-keys');
      const visible = await section.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(bounds.left + bounds.width / 2, bounds.bottom - 1),
        );
      });
      expect(visible).toBe(true);
      const calendar = page.getByRole('button', { name: 'Open Expires at calendar' });
      const target = await calendar.evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        const x = bounds.left + bounds.width / 2;
        const y = bounds.top + bounds.height / 2;
        const inset = 21.5;
        const points = [
          [x - inset, y - inset],
          [x + inset, y - inset],
          [x - inset, y + inset],
          [x + inset, y + inset],
        ] as const;
        return {
          x: x + inset,
          y,
          fits: points.every(([horizontal, vertical]) =>
            button.contains(document.elementFromPoint(horizontal, vertical)),
          ),
        };
      });
      expect(target.fits).toBe(true);
      await page.touchscreen.tap(target.x, target.y);
      const dialog = page.getByRole('dialog', { name: 'Expires at calendar' });
      await expect(dialog).toBeVisible();
      const dayAndMonthTargets = await dialog
        .locator('.cinder-calendar__day:not([aria-disabled="true"]), .cinder-calendar__nav:enabled')
        .evaluateAll((buttons) =>
          buttons
            .filter((button) => {
              const bounds = button.getBoundingClientRect();
              const x = bounds.left + bounds.width / 2;
              const y = bounds.top + bounds.height / 2;
              const face = getComputedStyle(button, '::before');
              const edgeCenters = [
                [x - 21, y],
                [x + 21, y],
                [x, y - 21],
                [x, y + 21],
              ] as const;
              return (
                bounds.width < 44 ||
                bounds.height < 44 ||
                face.content === 'none' ||
                !(Number.parseFloat(face.blockSize) <= 36) ||
                edgeCenters.some(
                  ([horizontal, vertical]) =>
                    !button.contains(document.elementFromPoint(horizontal, vertical)),
                )
              );
            })
            .map((button) => button.getAttribute('aria-label')),
        );
      expect(dayAndMonthTargets).toEqual([]);
      const calendarRowPitch = await dialog
        .locator('.cinder-calendar__grid-row')
        .evaluateAll(([first, second]) => {
          if (!first || !second) throw new Error('Calendar has fewer than two weeks');
          return second.getBoundingClientRect().top - first.getBoundingClientRect().top;
        });
      expect(calendarRowPitch).toBe(44);
      if (width === 375) {
        await captureForDesignReview(page, {
          route: '/settings/api-keys',
          state: 'expiration calendar open',
          source: 'settings',
        });
      }
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).not.toBeVisible();
      if (width === 375) {
        await captureForDesignReview(page, {
          route: '/settings/api-keys',
          state: 'section selector',
          source: 'settings',
        });
      }
      await section.selectOption('/settings/mcp');
      await expect(page).toHaveURL(/\/settings\/mcp$/);
    });
  }
});

test('opens Connected apps from desktop MCP setup and explains a disabled issuer (/settings/mcp, /settings/connected-apps)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/settings/mcp');
  const navigation = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(navigation.getByRole('link', { name: 'MCP', exact: true })).toBeVisible();
  const labels = await navigation.getByRole('link').allTextContents();
  const mcp = labels.findIndex((entry) => entry.trim() === 'MCP');
  expect(labels.slice(mcp, mcp + 4).map((entry) => entry.trim())).toEqual([
    'MCP',
    'API keys',
    'Connected apps',
    'Plugins',
  ]);
  const setup = page.getByRole('group', { name: 'MCP connection' });
  await expect(setup).toBeVisible();
  const connectedApps = setup.getByRole('link', { name: 'Connected apps', exact: true });
  expect(await connectedApps.count()).toBe(1);
  await captureForDesignReview(page, {
    route: '/settings/mcp',
    state: 'connected apps link',
    source: 'settings',
  });
  await connectedApps.click();
  await expect(page).toHaveURL(/\/settings\/connected-apps$/);
  await expect(page.getByRole('heading', { name: 'Connected apps', exact: true })).toHaveCount(1);
  await expect(page.getByText('Connector sign-in is disabled', { exact: true })).toBeVisible();
  await captureForDesignReview(page, {
    route: '/settings/connected-apps',
    state: 'disabled issuer',
    source: 'settings',
  });
});

test.describe('Connected apps on touch', () => {
  test.use({ hasTouch: true, isMobile: true });
  for (const width of [320, 375]) {
    test(`opens Connected apps through MCP setup and the complete Section selector at ${width}px (/settings/mcp, /settings/connected-apps)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 320 ? 640 : 812 });
      await page.goto('/settings/mcp');
      const setup = page.getByRole('group', { name: 'MCP connection' });
      await expect(setup).toBeVisible();
      const connectedApps = setup.getByRole('link', { name: 'Connected apps', exact: true });
      expect(await connectedApps.count()).toBe(1);
      if (width === 375) {
        await captureForDesignReview(page, {
          route: '/settings/mcp',
          state: 'connected apps link',
          source: 'settings',
        });
      }
      await connectedApps.click();
      await expect(page).toHaveURL(/\/settings\/connected-apps$/);
      const section = page.getByLabel('Section', { exact: true });
      await expect(section).toHaveValue('/settings/connected-apps');
      const bottom = await section.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          visible: element.contains(
            document.elementFromPoint(bounds.left + bounds.width / 2, bounds.bottom - 1),
          ),
          viewport: window.innerWidth,
        };
      });
      expect(bottom).toEqual({ visible: true, viewport: width });
      if (width === 375) {
        await captureForDesignReview(page, {
          route: '/settings/connected-apps',
          state: 'section selector',
          source: 'settings',
        });
      }
      await section.selectOption('/settings/mcp');
      await expect(page).toHaveURL(/\/settings\/mcp$/);
      await page.getByLabel('Section', { exact: true }).selectOption('/settings/connected-apps');
      await expect(page).toHaveURL(/\/settings\/connected-apps$/);
    });
  }
});
