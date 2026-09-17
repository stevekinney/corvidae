import { expect, test } from '@playwright/test';
import { gotoHydrated, readCreatedConversation, uniqueTitle } from './server-owned-test-helpers';

test('a failed recovery check says so in its alert', async ({ page, request }) => {
  // THE INJECTION HALF. `error-live-regions.e2e.ts` pins that this region is
  // mounted and empty before anything fails; nothing covered what happens
  // when something does, so deleting both failure assignments in the panel
  // left every test green.
  //
  // The failure is produced by intercepting the request rather than by
  // breaking the server, because the panel's contract is about what it does
  // with a response it cannot use — and a 503 is the shape this route family
  // actually returns while shutting down.
  const created = await request.post('/api/server-owned/conversations', {
    data: { title: uniqueTitle('Recovery failure') },
  });
  const conversation = await readCreatedConversation(created);

  await page.setViewportSize({ width: 844, height: 390 });
  await gotoHydrated(page, `/server-owned/${conversation.id}`);
  await page.locator('summary', { hasText: 'Durable recovery' }).click({ force: true });

  const alert = page.locator('[data-testid="recovery-error"]');
  await expect(alert).toBeEmpty();

  await page.route(`**/api/server-owned/conversations/${conversation.id}/recovery`, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'The server is shutting down. Try again in a moment.' }),
    }),
  );

  await page.locator('[data-testid="recovery-check"]').evaluate((button) => {
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('Expected recovery check control to be a button.');
    }
    button.click();
  });

  // THE SERVER'S SENTENCE, not the JSON envelope — the same rule the
  // streaming surface follows.
  await expect(alert).toContainText('shutting down');
  await expect(alert).not.toContainText('{');
  // And the outcome regions stay empty, because nothing was classified.
  await expect(page.locator('[data-testid="recovery-status"]')).toBeEmpty();
  // A populated recovery failure is part of the page's exceptional-height
  // states. The transcript keeps its usable floor and the page owns the extra
  // height instead of squeezing the chat below it.
  const failureLayout = await page.evaluate(() => ({
    chat:
      document.querySelector('[data-testid="server-owned-chat"]')?.getBoundingClientRect().height ??
      0,
    page: document.querySelector('main')?.scrollHeight ?? 0,
    viewport: window.innerHeight,
  }));
  expect(failureLayout.chat).toBeGreaterThanOrEqual(128);
  expect(failureLayout.page).toBeGreaterThan(failureLayout.viewport);

  // A network failure reaches the same region with its own sentence, which is
  // the second assignment the old coverage could not see.
  await page.unroute(`**/api/server-owned/conversations/${conversation.id}/recovery`);
  await page.route(`**/api/server-owned/conversations/${conversation.id}/recovery`, (route) =>
    route.abort('failed'),
  );

  await page.locator('[data-testid="recovery-check"]').evaluate((button) => {
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('Expected recovery check control to be a button.');
    }
    button.click();
  });
  await expect(alert).toContainText('could not reach the server');
});

test('keeps a recovered report as a point-in-time result while a later recovery check fails', async ({
  page,
  request,
}) => {
  const created = await request.post('/api/server-owned/conversations', {
    data: { title: uniqueTitle('Recovery recovered snapshot') },
  });
  const conversation = await readCreatedConversation(created);

  await gotoHydrated(page, `/server-owned/${conversation.id}`);
  await page.locator('summary', { hasText: 'Durable recovery' }).click({ force: true });

  const status = page.locator('[data-testid="recovery-status"]');
  const alert = page.locator('[data-testid="recovery-error"]');
  await expect(status).toHaveAttribute('role', 'status');
  await expect(status).toBeEmpty();
  await expect(alert).toBeEmpty();

  let requests = 0;
  await page.route(`**/api/server-owned/conversations/${conversation.id}/recovery`, (route) => {
    requests += 1;
    if (requests === 1) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          kind: 'recovered',
          durability: 'on-disk',
          progress: 'step-level',
          note: 'Progress advances a step at a time.',
        }),
      });
    }
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'The server is shutting down. Try again in a moment.' }),
    });
  });

  const check = page.locator('[data-testid="recovery-check"]');
  await check.click();
  await expect(status).toContainText(
    'The last successful recovery check re-attached to a run in flight',
  );
  await expect(status).toContainText('Progress was step-level');
  await expect(status).not.toContainText('Progress is');

  await check.click();
  await expect(alert).toContainText('shutting down');
  await expect(status).toContainText(
    'The last successful recovery check re-attached to a run in flight',
  );
  await expect(status).not.toContainText('Progress is');
});

test('keeps an orphan report while a later recovery check fails', async ({ page, request }) => {
  const created = await request.post('/api/server-owned/conversations', {
    data: { title: uniqueTitle('Recovery recheck') },
  });
  const conversation = await readCreatedConversation(created);

  await gotoHydrated(page, `/server-owned/${conversation.id}`);
  await page.locator('summary', { hasText: 'Durable recovery' }).click({ force: true });

  // The announcement target must already be mounted before the response that
  // supplies an outcome. Otherwise a screen reader can miss the warning when
  // the panel inserts populated markup after the request completes.
  const status = page.locator('[data-testid="recovery-status"]');
  await expect(status).toHaveCount(1);
  await expect(status).toHaveAttribute('role', 'status');
  await expect(status).toBeEmpty();

  let requests = 0;
  let secondStarted!: () => void;
  const secondRequest = new Promise<void>((resolve) => {
    secondStarted = resolve;
  });
  let releaseSecond!: () => void;
  const secondResponse = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  await page.route(
    `**/api/server-owned/conversations/${conversation.id}/recovery`,
    async (route) => {
      requests += 1;
      if (requests === 1) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            kind: 'orphaned',
            durability: 'on-disk',
            failures: [{ runId: 'run-orphaned', reason: 'Provider details are withheld.' }],
            note: 'Reported once. The orphan diagnosis could not be saved for later checks.',
          }),
        });
        return;
      }
      secondStarted();
      await secondResponse;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'The server is shutting down. Try again in a moment.' }),
      });
    },
  );

  const check = page.locator('[data-testid="recovery-check"]');
  await check.click();
  await expect(status).toContainText('The last successful recovery check found an orphaned run');
  await expect(status).toContainText('The orphan diagnosis could not be saved for later checks.');
  await expect(page.locator('[data-testid="recovery-failures"]')).toContainText('run-orphaned');

  await check.click();
  await secondRequest;
  await expect(page.locator('[data-testid="recovery-status"]')).toContainText(
    'The last successful recovery check found an orphaned run',
  );
  await expect(page.locator('[data-testid="recovery-failures"]')).toContainText('run-orphaned');

  releaseSecond();
  await expect(page.locator('[data-testid="recovery-error"]')).toContainText('shutting down');
  await expect(status).toContainText('The last successful recovery check found an orphaned run');
  await expect(status).toContainText('The orphan diagnosis could not be saved for later checks.');
  await expect(page.locator('[data-testid="recovery-failures"]')).toContainText('run-orphaned');
});
