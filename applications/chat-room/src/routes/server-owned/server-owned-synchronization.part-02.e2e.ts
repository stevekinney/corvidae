import { expect, test } from '@playwright/test';
import {
  gotoHydrated,
  latestUserMessageId,
  readCreatedConversation,
  readServerOwnedSnapshot,
  title,
} from './server-owned-synchronization-test-helpers';

test('keeps an own-endpoint rejection overlay through refresh until the next submission', async ({
  page,
  request,
}) => {
  const created = await request.post('/api/server-owned/conversations', {
    data: { title: `${title}-rejected-overlay` },
  });
  expect(created.status()).toBe(201);
  const conversation = await readCreatedConversation(created);
  await gotoHydrated(page, `/server-owned/${conversation.id}`);
  const rejected = 'Rejected endpoint turn';
  await page.route(`**/api/server-owned/conversations/${conversation.id}/stream`, (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'The endpoint rejected this turn.' }),
    }),
  );
  await page.getByRole('textbox', { name: 'Message' }).fill(rejected);
  await page.getByRole('button', { name: 'Send message' }).click();
  const rejectedRow = page.getByRole('article', { name: 'You' }).filter({ hasText: rejected });
  await expect(rejectedRow).toHaveCount(1);
  await expect(page.getByTestId('server-owned-turn-failure')).toHaveText(
    'The endpoint rejected this turn.',
  );
  const refresh = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/server-owned/conversations/${conversation.id}`) &&
      response.request().method() === 'GET',
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await refresh;
  await expect(rejectedRow).toHaveCount(1);
  await page.unroute(`**/api/server-owned/conversations/${conversation.id}/stream`);
  await page.getByRole('textbox', { name: 'Message' }).fill('Accepted replacement turn');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('article', { name: 'You' })).toContainText(
    'Accepted replacement turn',
  );
  await expect(rejectedRow).toHaveCount(0);
});
test('keeps an unsaved failure through canonical adoption and later turns until durable confirmation', async ({
  page,
  request,
}) => {
  const created = await request.post('/api/server-owned/conversations', {
    data: { title: `${title}-persistence-overlay` },
  });
  expect(created.status()).toBe(201);
  const conversation = await readCreatedConversation(created);
  const endpoint = `/api/server-owned/conversations/${conversation.id}`;
  await page.clock.install();
  await gotoHydrated(page, `/server-owned/${conversation.id}`);
  const emptyResponse = await request.get(endpoint);
  const emptySnapshot = await readServerOwnedSnapshot(emptyResponse);
  const text = 'Unsaved persistence failure';
  const failure = {
    kind: 'generate',
    code: 'UNKNOWN',
    message: 'The turn outcome could not be saved.',
    retryable: false,
  };
  let authoritativeId = '';
  await page.route(`**${endpoint}/stream`, async (route) => {
    // Run the real endpoint so subsequent GETs have its native, authoritative
    // user ID. Replace only the outcome frames to exercise the browser seam;
    // pump unit tests independently force the actual persistence rejection.
    const accepted = await route.fetch();
    expect(accepted.ok()).toBe(true);
    await accepted.body();
    const response = await request.get(endpoint);
    const snapshot = await readServerOwnedSnapshot(response);
    authoritativeId = latestUserMessageId(snapshot);
    expect(snapshot.turnFailures).toEqual({});
    await route.fulfill({
      status: 200,
      contentType: 'application/x-ndjson',
      body:
        [
          {
            type: 'stream:error',
            error: { source: 'server-owned-persistence', userMessageId: authoritativeId, failure },
            wireVersion: 2,
            sequence: 1,
          },
          { type: 'run.error', error: { name: 'Error', ...failure }, wireVersion: 2, sequence: 2 },
        ]
          .map((frame) => JSON.stringify(frame))
          .join('\n') + '\n',
    });
  });
  await page.getByRole('textbox', { name: 'Message' }).fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  const row = page.getByRole('article', { name: 'You' }).filter({ hasText: text });
  const status = page.getByTestId('server-owned-sync-status');
  await expect(row).toHaveCount(1);
  await expect(row.locator('xpath=..')).toHaveAttribute('data-failed', 'true');
  await expect(row.getByTestId('server-owned-turn-reason')).toHaveText(failure.message);
  const refresh = async (): Promise<void> => {
    const response = page.waitForResponse(
      (candidate) => candidate.url().endsWith(endpoint) && candidate.request().method() === 'GET',
    );
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await response;
  };
  await refresh();
  await expect(row).toHaveCount(1);
  await expect(row.locator('xpath=..')).toHaveAttribute('data-failed', 'true');
  await expect(status).toHaveText('');
  await page.unroute(`**${endpoint}/stream`);
  await page.getByRole('textbox', { name: 'Message' }).fill('A later accepted turn');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('article', { name: 'Assistant' })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
  await expect(row).toHaveCount(1);
  await expect(row.locator('xpath=..')).toHaveAttribute('data-failed', 'true');
  await expect(row.getByTestId('server-owned-turn-reason')).toHaveText(failure.message);
  await expect(status).toHaveText('');
  // The captured row remains recoverable even after canonical adoption.
  await page.route(`**${endpoint}`, (route) => route.fulfill({ json: emptySnapshot }));
  await refresh();
  await expect(page.getByRole('article', { name: 'You' })).toHaveCount(1);
  await expect(row.locator('xpath=..')).toHaveAttribute('data-failed', 'true');
  await page.unroute(`**${endpoint}`);
  await refresh();
  await expect(page.getByRole('article', { name: 'You' })).toHaveCount(2);
  await expect(row).toHaveCount(1);
  const canonicalResponse = await request.get(endpoint);
  const canonical = await readServerOwnedSnapshot(canonicalResponse);
  await page.route(`**${endpoint}`, (route) =>
    route.fulfill({
      json: {
        ...canonical,
        turnFailures: {
          [authoritativeId]: { ...failure, message: 'The assistant could not complete this turn.' },
        },
      },
    }),
  );
  await refresh();
  await expect(row.getByTestId('server-owned-turn-reason')).toHaveText(
    'The assistant could not complete this turn.',
  );
  await expect(status).toHaveText('1 failed turn is recorded in this conversation.');
  // Removing the synthetic durable record proves the local overlay was
  // retired, rather than merely hidden underneath that record.
  await page.unroute(`**${endpoint}`);
  await refresh();
  await expect(row.locator('xpath=..')).not.toHaveAttribute('data-failed', 'true');
  await expect(row.getByTestId('server-owned-turn-reason')).toHaveCount(0);
});
