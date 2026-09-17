import { expect, test } from '@playwright/test';
import {
  assertApprovedPost,
  fixtureMarker,
  gotoHydrated,
  newFixtureMarker,
  uniqueTitle,
} from './server-owned-approval-focus-test-helpers';

test('allows the replacement approval to submit while the first POST is stalled', async ({
  page,
}) => {
  await gotoHydrated(page, '/server-owned');
  const title = uniqueTitle('Approval replacement while pending');
  await page.locator('[data-testid="server-owned-new-title"]').fill(title);
  await page.locator('[data-testid="server-owned-create"]').click();
  await page.getByRole('link', { name: new RegExp(title) }).click();
  await page.waitForSelector('body[data-hydrated="true"]');
  await page.getByRole('textbox').fill(fixtureMarker('approval', newFixtureMarker()));
  await page.getByRole('textbox').press('Enter');

  const question = page.locator('[data-testid="approval-question"]');
  const approve = page.locator('[data-testid="approval-approve"]');
  await expect(approve).toBeVisible();
  let remoteState: 'server' | 'replaced' | 'removed' = 'server';
  let postNumber = 0;
  let releaseA!: () => void;
  let releaseB!: () => void;
  await page.route('**/api/server-owned/conversations/*/elicitation', async (route) => {
    if (route.request().method() === 'GET') {
      if (remoteState === 'removed') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: '{"pending":null}',
        });
        return;
      }
      if (remoteState === 'replaced') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            pending: {
              toolName: 'remember_note',
              callId: 'replacement-call',
              message: 'Save the replacement note?',
              arguments: { text: 'replacement' },
            },
          }),
        });
        return;
      }
      await route.continue();
      return;
    }
    postNumber += 1;
    assertApprovedPost(route, postNumber === 2 ? 'replacement-call' : undefined);
    await new Promise<void>((resolve) => {
      if (postNumber === 1) releaseA = resolve;
      else releaseB = resolve;
    });
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await approve.focus();
  await approve.press('Enter');
  await expect.poll(() => postNumber).toBe(1);
  remoteState = 'replaced';
  await expect(question).toContainText('replacement note');
  await expect(approve).toBeEnabled();
  await approve.press('Enter');
  await expect.poll(() => postNumber).toBe(2);
  releaseA();
  await expect(approve).toHaveAttribute('aria-disabled', 'true');
  remoteState = 'removed';
  releaseB();
  await expect(approve).toHaveCount(0);
});

test('clears a decision error when a remote answer removes its question', async ({ page }) => {
  await gotoHydrated(page, '/server-owned');
  const title = uniqueTitle('Approval remote error cleanup');
  await page.locator('[data-testid="server-owned-new-title"]').fill(title);
  await page.locator('[data-testid="server-owned-create"]').click();
  await page.getByRole('link', { name: new RegExp(title) }).click();
  await page.waitForSelector('body[data-hydrated="true"]');
  await page.getByRole('textbox').fill(fixtureMarker('approval', newFixtureMarker()));
  await page.getByRole('textbox').press('Enter');

  const approve = page.locator('[data-testid="approval-approve"]');
  const failure = page.locator('[data-testid="server-owned-turn-failure"]');
  await expect(approve).toBeVisible();
  let remoteAnswered = false;
  let releasePost!: () => void;
  await page.route('**/api/server-owned/conversations/*/elicitation', async (route) => {
    if (route.request().method() === 'GET') {
      if (remoteAnswered) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: '{"pending":null}',
        });
        return;
      }
      await route.continue();
      return;
    }
    assertApprovedPost(route);
    await new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'approval service unavailable' }),
    });
  });

  await approve.click();
  await expect.poll(() => releasePost !== undefined).toBe(true);
  releasePost();
  await expect(failure).toContainText('approval service unavailable');
  remoteAnswered = true;
  await expect(approve).toHaveCount(0);
  await expect(failure).toBeEmpty();
});

test('poll recovery preserves a decision failure until the answer succeeds', async ({ page }) => {
  await gotoHydrated(page, '/server-owned');
  const title = uniqueTitle('Approval poll error ownership');
  await page.locator('[data-testid="server-owned-new-title"]').fill(title);
  await page.locator('[data-testid="server-owned-create"]').click();
  await page.getByRole('link', { name: new RegExp(title) }).click();
  await page.waitForSelector('body[data-hydrated="true"]');
  await page.getByRole('textbox').fill(fixtureMarker('approval', newFixtureMarker()));
  await page.getByRole('textbox').press('Enter');

  const approve = page.locator('[data-testid="approval-approve"]');
  const failure = page.locator('[data-testid="server-owned-turn-failure"]');
  await expect(approve).toBeVisible();

  let postAttempts = 0;
  let pollFailures = 0;
  let pollSuccesses = 0;
  let exercisePollFailure = false;
  await page.route('**/api/server-owned/conversations/*/elicitation', async (route) => {
    if (route.request().method() === 'GET') {
      if (!exercisePollFailure) {
        await route.continue();
        return;
      }
      if (pollFailures === 0) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'poll service unavailable' }),
        });
        pollFailures += 1;
        return;
      }
      const response = await route.fetch();
      await route.fulfill({ response });
      pollSuccesses += 1;
      return;
    }

    assertApprovedPost(route);
    postAttempts += 1;
    if (postAttempts === 1) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'approval service unavailable' }),
      });
      return;
    }
    await route.continue();
  });

  await approve.click();
  await expect(failure).toContainText('approval service unavailable');
  // A failed poll must not replace the actionable POST failure, and the
  // subsequent successful poll must not clear it by accident.
  exercisePollFailure = true;
  await expect.poll(() => pollFailures).toBe(1);
  await expect.poll(() => pollSuccesses).toBeGreaterThanOrEqual(1);
  await expect(failure).toContainText('approval service unavailable');
  await expect(approve).toBeVisible();

  await approve.click();
  await expect(page.locator('[data-testid="server-owned-chat"]')).toHaveAttribute(
    'data-streaming',
    'false',
  );
  await expect(failure).toBeEmpty();
});
