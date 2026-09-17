import { expect, test } from '@playwright/test';
import {
  fixtureMarker,
  gotoHydrated,
  newFixtureMarker,
  uniqueTitle,
} from './server-owned-approval-focus-test-helpers';

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object.`);
  }
  return Object.fromEntries(Object.entries(value));
}

test('answering keeps focus inside the chat', async ({ page }) => {
  // Every path that clears the question removes the focused subtree, and a
  // browser then drops focus to `<body>` — outside the chat's tab context, at
  // the moment the turn resumes. Asserted on the RESULT rather than on the
  // handler, because three separate paths clear `pending` and only one of
  // them used to hand focus off.
  await gotoHydrated(page, '/server-owned');
  const title = uniqueTitle('Approval focus');
  await page.locator('[data-testid="server-owned-new-title"]').fill(title);
  await page.locator('[data-testid="server-owned-create"]').click();
  await page.getByRole('link', { name: new RegExp(title) }).click();
  await page.waitForSelector('body[data-hydrated="true"]');

  const marker = newFixtureMarker();
  const composer = page.getByRole('textbox');
  await composer.fill(fixtureMarker('approval', marker));
  await composer.press('Enter');

  const approve = page.locator('[data-testid="approval-approve"]');
  await expect(approve).toBeVisible();

  // FOCUSED BY KEYBOARD, not clicked — a click leaves focus wherever the
  // browser decides, which would let this pass without the handoff.
  await approve.focus();
  await expect(approve).toBeFocused();
  await approve.press('Enter');

  await expect(page.locator('[data-testid="server-owned-chat"]')).toHaveAttribute(
    'data-streaming',
    'false',
  );

  // NOT `<body>`. The visible transcript is where the consequence of the
  // decision is announced, so it is where focus belongs. It must remain a
  // real, visible focus target after the approval subtree is removed.
  const landed = page.getByRole('log', { name: 'Messages' });
  await expect(landed).toBeFocused();
  await expect(landed).toBeVisible();
  const landedGeometry = await landed.evaluate((element) => {
    const rectangle = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      width: rectangle.width,
      height: rectangle.height,
      focusIndicator:
        (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0) ||
        style.boxShadow !== 'none',
    };
  });
  expect(landedGeometry.width).toBeGreaterThan(1);
  expect(landedGeometry.height).toBeGreaterThan(1);
  expect(landedGeometry.focusIndicator).toBe(true);
});

test('a remote answer hands focus back when polling removes the controls', async ({
  page,
  request,
}) => {
  await gotoHydrated(page, '/server-owned');
  const title = uniqueTitle('Remote approval focus');
  await page.locator('[data-testid="server-owned-new-title"]').fill(title);
  await page.locator('[data-testid="server-owned-create"]').click();
  await page.getByRole('link', { name: new RegExp(title) }).click();
  await page.waitForSelector('body[data-hydrated="true"]');

  const composer = page.getByRole('textbox');
  await composer.fill(fixtureMarker('approval', newFixtureMarker()));
  await composer.press('Enter');
  const approve = page.locator('[data-testid="approval-approve"]');
  await expect(approve).toBeVisible();
  await approve.focus();

  // The detail page does not expose its id as an attribute; derive it from the
  // current URL so the second client answers the exact question being polled.
  const conversationId = new URL(page.url()).pathname.split('/').at(-1);
  if (conversationId === undefined) throw new Error('conversation id missing from detail URL');
  const pending = await request.get(
    `/api/server-owned/conversations/${conversationId}/elicitation`,
  );
  const body = objectRecord(await pending.json(), 'pending approval response');
  const pendingApproval = objectRecord(body['pending'], 'pending approval');
  const callId = pendingApproval['callId'];
  if (typeof callId !== 'string') throw new Error('Expected pending approval callId.');
  await request.post(`/api/server-owned/conversations/${conversationId}/elicitation`, {
    data: { approved: false, callId },
  });

  await expect(approve).toHaveCount(0);
  const landed = page.getByRole('log', { name: 'Messages' });
  await expect(landed).toBeFocused();
  await expect(landed).toBeVisible();
  const landedGeometry = await landed.evaluate((element) => {
    const rectangle = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      width: rectangle.width,
      height: rectangle.height,
      focusIndicator:
        (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0) ||
        style.boxShadow !== 'none',
    };
  });
  expect(landedGeometry.width).toBeGreaterThan(1);
  expect(landedGeometry.height).toBeGreaterThan(1);
  expect(landedGeometry.focusIndicator).toBe(true);
});

test('a remote replacement hands focus back when the pending call changes', async ({ page }) => {
  await gotoHydrated(page, '/server-owned');
  const title = uniqueTitle('Replacement approval focus');
  await page.locator('[data-testid="server-owned-new-title"]').fill(title);
  await page.locator('[data-testid="server-owned-create"]').click();
  await page.getByRole('link', { name: new RegExp(title) }).click();
  await page.waitForSelector('body[data-hydrated="true"]');
  await page.getByRole('textbox').fill(fixtureMarker('approval', newFixtureMarker()));
  await page.getByRole('textbox').press('Enter');

  const approve = page.locator('[data-testid="approval-approve"]');
  await expect(approve).toBeVisible();
  await approve.focus();
  await page.route('**/api/server-owned/conversations/*/elicitation', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        pending: {
          toolName: 'remember_note',
          callId: 'remote-call-b',
          message: 'Save the replacement note?',
          arguments: { text: 'replacement' },
        },
      }),
    });
  });

  await expect(page.locator('[data-testid="approval-question"]')).toContainText(
    'Save the replacement note?',
  );
  await expect(page.locator('[data-testid="approval-question"]')).toBeFocused();
});
