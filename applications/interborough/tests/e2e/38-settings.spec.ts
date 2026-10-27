/**
 * `/settings` (COR-1711) against the real host: the page draws a control for every setting the
 * Bureau publishes, shows the key the host locked read-only, and changes what the Bureau does.
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
import { bureauCall, taskOfSession } from './task-support.ts';

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
  await page.goto('/chat/new?agent=request-human-input');
  const composer = page.getByRole('textbox');
  await composer.fill('Release it');
  await composer.press('Enter');
  await expect(page).toHaveURL(/\/chat\/(?!new)[^/?]+$/);
  return decodeURIComponent(new URL(page.url()).pathname.split('/').pop() ?? '');
}

const reviewOf = (page: Page, threadId: string) =>
  page.locator('.ib-review').filter({ has: page.locator(`a[href="/chat/${threadId}"]`) });

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
    const keys = Object.keys(published);
    await expect(page.locator('[data-setting]')).toHaveCount(keys.length);
    for (const key of keys) {
      await expect(
        settingRow(page, key).locator('button[role="switch"], input, select, textarea').first(),
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
  await expect(row).toContainText(SETTINGS_COPY.lockedNote);
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

    // A chat started now is not offered `requestHumanInput`, so its run settles without asking.
    const without = await startChat(page);
    await expect
      .poll(async () => {
        const task = await taskOfSession(request, without);
        return task.status;
      })
      .not.toMatch(/^(pending|queued|running|waiting)/);
    await page.goto('/reviews');
    await expect(page.getByRole('heading', { level: 1, name: 'Reviews' })).toBeVisible();
    await expect(reviewOf(page, without)).toHaveCount(0);
    const listed = (await bureauCall(request, 'bureau.reviews.list', {})) as {
      reviews: Array<{ sessionId?: string }>;
    };
    expect(listed.reviews.filter((review) => review.sessionId === without)).toEqual([]);

    // Turned back on, the same chat parks on its question, and the question is waiting in Reviews.
    await page.goto('/settings');
    await saveHumanInput(page, true);
    const withIt = await startChat(page);
    await page.goto('/reviews');
    await expect(reviewOf(page, withIt)).toContainText(HUMAN_INPUT_PROMPT);
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
