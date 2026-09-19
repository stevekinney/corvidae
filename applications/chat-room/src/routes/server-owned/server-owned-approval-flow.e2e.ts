import { expect, test } from '@playwright/test';

import { newFixtureMarker } from '../fixture-probe';
import { APPROVAL_FOLLOW_UP_TEXT, fixtureMarker } from '../streaming-fixture';
import { gotoHydrated } from './server-owned-test-helpers';

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object.`);
  }
  return Object.fromEntries(Object.entries(value));
}

const uniqueTitle = (label: string): string =>
  `${label} ${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

test('approval stream completes in the browser', async ({ page }) => {
  await gotoHydrated(page, '/server-owned');
  const title = uniqueTitle('Cross-engine approval');
  await page.locator('[data-testid="server-owned-new-title"]').fill(title);
  await page.locator('[data-testid="server-owned-create"]').click();
  await page.getByRole('link', { name: new RegExp(title) }).click();
  await page.waitForSelector('body[data-hydrated="true"]');

  await page.getByRole('textbox').fill(fixtureMarker('approval', newFixtureMarker()));
  await page.getByRole('textbox').press('Enter');
  await expect(page.locator('[data-testid="approval-approve"]')).toBeVisible();
  const approvalRequest = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      request.url().includes('/api/server-owned/conversations/') &&
      request.url().endsWith('/elicitation'),
  );
  await page.locator('[data-testid="approval-approve"]').click();
  const approvalRequestEvent = await approvalRequest;
  const approvalPayload = objectRecord(
    JSON.parse(approvalRequestEvent.postData() ?? '{}'),
    'approval payload',
  );
  expect(approvalPayload['approved']).toBe(true);
  expect(typeof approvalPayload['callId']).toBe('string');

  await expect(page.locator('[data-testid="server-owned-chat"]')).toHaveAttribute(
    'data-streaming',
    'false',
  );
  await expect(page.locator('[data-testid="server-owned-chat"]')).toContainText(
    APPROVAL_FOLLOW_UP_TEXT,
  );
  await expect(page.locator('[data-testid="server-owned-turn-failure"]')).toBeEmpty();
});

test('approval denial settles the streamed tool row in the browser', async ({ page }) => {
  await gotoHydrated(page, '/server-owned');
  const title = uniqueTitle('Cross-engine denial');
  await page.locator('[data-testid="server-owned-new-title"]').fill(title);
  await page.locator('[data-testid="server-owned-create"]').click();
  await page.getByRole('link', { name: new RegExp(title) }).click();
  await page.waitForSelector('body[data-hydrated="true"]');

  await page.getByRole('textbox').fill(fixtureMarker('approval', newFixtureMarker()));
  await page.getByRole('textbox').press('Enter');
  await expect(page.locator('[data-testid="approval-deny"]')).toBeVisible();
  await page.locator('[data-testid="approval-deny"]').click();

  await expect(page.locator('[data-testid="server-owned-chat"]')).toHaveAttribute(
    'data-streaming',
    'false',
  );
  const chat = page.locator('[data-testid="server-owned-chat"]');
  await expect(chat).toContainText('remember_note');
  await expect(chat).toContainText('Failed');
  await expect(page.locator('[data-testid="server-owned-turn-failure"]')).toBeEmpty();
});
