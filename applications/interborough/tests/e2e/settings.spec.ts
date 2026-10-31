/**
 * `/settings` (COR-1711) against the real host: the page draws a control for every setting the
 * Bureau publishes but the model policy and the decisions, which have sections of their own, shows the key the host locked read-only, and changes what the Bureau does.
 * `tools.humanInput` is the setting whose effect a person can see: with it off, a chat with
 * `request-human-input` asks nothing and leaves nothing to review; with it back on, the same chat
 * parks on its question and the question is waiting in Reviews.
 *
 * The settings are the deployment's and are kept in its database, so a case that changes one puts it
 * back whether it passed or not.
 */
import type { APIRequestContext, Page } from '@playwright/test';

import { SETTINGS_COPY } from '../../src/app/copy.ts';
import { HUMAN_INPUT_PROMPT } from '../../src/host/seed.ts';
import { E2E_LOCKED_SETTING } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';
import { bureauCall, taskOfSession, waitingReviewOf } from './task-support.ts';

const WIDTHS = [375, 1280] as const;

const settingRow = (page: Page, key: string) => page.locator(`[data-setting="${key}"]`);
const humanInputSwitch = (page: Page) =>
  settingRow(page, 'tools.humanInput').getByRole('switch', { name: 'tools.humanInput' });
const saveButton = (page: Page) => page.getByRole('button', { name: SETTINGS_COPY.saveAction });

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

/** Saves the humanInput switch's new state through the page, and waits for the Bureau's answer. */
async function saveHumanInput(page: Page, on: boolean): Promise<void> {
  await humanInputSwitch(page).click();
  await expect(humanInputSwitch(page)).toHaveAttribute('aria-checked', String(on));
  await saveButton(page).click();
  await expect(page.getByText(SETTINGS_COPY.saved.title)).toBeVisible();
  // The form reads the settings back before it is edited again: nothing is left dirty.
  await expect(settingRow(page, 'tools.humanInput')).toHaveAttribute('data-dirty', 'false');
}

/** Starts a chat with the seeded question-asking agent and returns the session it became. */
async function startChat(page: Page): Promise<string> {
  await page.goto('/chats/new?agent=request-human-input');
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
    await page.goto('/settings');
    await expect(page.locator('[data-view="settings"]')).toHaveAttribute('data-state', 'ready');

    const published = (
      (await bureauCall(request, 'bureau.settings.schema', {})) as {
        schema: { properties: Record<string, unknown> };
      }
    ).schema.properties;
    // The model policy has a section of its own, and the decisions are on Settings › Models.
    const keys = Object.keys(published).filter(
      (key) => key !== 'modelPolicy' && !key.startsWith('decisions.'),
    );
    await expect(page.locator('[data-setting]')).toHaveCount(keys.length);
    for (const key of keys) {
      // A value that has none is Not set, with a button to set it; every other has a control.
      await expect(
        settingRow(page, key)
          .locator('button, input, select, textarea, [role="textbox"]')
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
    }
    await expect(page.getByText(/unsupported/i)).toHaveCount(0);
    await checkA11y(`settings at ${width}px`);
  });
}

test('shows the key the host locked read-only, with the reason', async ({ page, request }) => {
  const before = await revisionOf(request);
  await page.goto('/settings');

  const row = settingRow(page, E2E_LOCKED_SETTING);
  await expect(row).toHaveAttribute('data-locked', 'true');
  await expect(row).toContainText(SETTINGS_COPY.locked);
  await expect(row).toContainText(SETTINGS_COPY.lockedNote.deployment);
  const field = row.getByRole('textbox', { name: E2E_LOCKED_SETTING });
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
  const wakeupSwitch = settingRow(page, 'tools.wakeup').getByRole('switch', {
    name: 'tools.wakeup',
  });
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

test('saves on ⌘Enter from a field, and puts nothing else in the update', async ({
  page,
  request,
}) => {
  const original = await valueOf(request, 'tools.wakeup');
  expect(original, 'wakeup is on to begin with').toBe(true);
  try {
    await page.goto('/settings');
    await expect(settingRow(page, 'tools.wakeup')).toBeVisible();
    const wakeup = settingRow(page, 'tools.wakeup').getByRole('switch', { name: 'tools.wakeup' });
    await wakeup.click();
    await expect(settingRow(page, 'tools.wakeup')).toHaveAttribute('data-dirty', 'true');
    // The shortcut acts with focus in a field, which is where a person is when they want to save.
    await page.getByRole('spinbutton', { name: 'logs.maximumLinesPerRun' }).focus();
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(page.getByText(SETTINGS_COPY.saved.title)).toBeVisible();
    await expect(settingRow(page, 'tools.wakeup')).toHaveAttribute('data-dirty', 'false');
    expect(await valueOf(request, 'tools.wakeup')).toBe(false);
  } finally {
    const current = await snapshotOf(request);
    if (current.values['tools.wakeup'] !== original) {
      await bureauCall(request, 'bureau.settings.update', {
        patch: { 'tools.wakeup': original },
        expectedRevision: current.revision,
      });
    }
  }
});

test('lists ⌘Enter among the shortcuts', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.locator('[data-view="settings"]')).toHaveAttribute('data-state', 'ready');
  await expect(settingRow(page, 'tools.wakeup')).toBeVisible();
  await page.keyboard.press('?');
  const map = page.getByRole('dialog');
  await expect(map).toContainText(SETTINGS_COPY.saveAction);
  await expect(map).toContainText('⌘');
});

test('edits an object without JSON, and a model name from the catalog', async ({
  page,
  request,
}) => {
  const original = await valueOf(request, 'retention.receipts');
  try {
    await page.goto('/settings');
    const receipts = settingRow(page, 'retention.receipts');
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
    if (JSON.stringify(current.values['retention.receipts']) !== JSON.stringify(original)) {
      await bureauCall(request, 'bureau.settings.update', {
        patch: { 'retention.receipts': original },
        expectedRevision: current.revision,
      });
    }
  }
});

test('changes the model policy in plain words, and raises its revision when saved', async ({
  page,
  request,
}) => {
  const original = await valueOf(request, 'modelPolicy');
  try {
    await page.goto('/settings/model-policy');
    await expect(page.getByRole('heading', { name: 'Allowed models', level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your preferences', level: 2 })).toBeVisible();
    await expect(page.locator('textarea')).toHaveCount(0);

    await page.getByLabel('Default effort').selectOption('high');
    // A list of providers is a field of its own, and no provider is in use under this name.
    const never = page.getByRole('textbox', { name: 'Never these providers' });
    await never.fill('unused-provider');
    await never.press('Enter');
    await expect(page.locator('[data-setting="modelPolicy"]')).toHaveAttribute(
      'data-dirty',
      'true',
    );
    await saveButton(page).click();
    await expect(page.getByText(SETTINGS_COPY.saved.title)).toBeVisible();

    const policy = (await valueOf(request, 'modelPolicy')) as {
      policyRevision: number;
      users?: Record<string, { defaultEffort?: string; deniedProviders?: string[] }>;
    };
    expect(policy.users?.['anonymous:local']?.defaultEffort).toBe('high');
    expect(policy.users?.['anonymous:local']?.deniedProviders).toEqual(['unused-provider']);
    expect(policy.policyRevision).toBe(
      ((original as { policyRevision?: number })?.policyRevision ?? 0) + 1,
    );
  } finally {
    const current = await snapshotOf(request);
    await bureauCall(request, 'bureau.settings.update', {
      patch: {
        modelPolicy: {
          ...(original as object),
          policyRevision:
            ((current.values['modelPolicy'] as { policyRevision?: number })?.policyRevision ?? 0) +
            1,
        },
      },
      expectedRevision: current.revision,
    });
  }
});
