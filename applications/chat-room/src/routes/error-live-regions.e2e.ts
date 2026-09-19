import { expect, test } from '@playwright/test';
import { gotoHydrated } from './page.svelte-test-helpers';
import { readCreatedConversation } from './server-owned/server-owned-test-helpers';

const ERROR_REGIONS = [
  { route: '/', testId: 'demo-error' },
  { route: '/server-owned', testId: 'server-owned-failure' },
] as const;

for (const { route, testId } of ERROR_REGIONS) {
  test(`${route} mounts ${testId} before anything can fail`, async ({ page }) => {
    await gotoHydrated(page, route);

    const region = page.getByTestId(testId);
    await expect(region).toHaveCount(1);
    await expect(region).toBeEmpty();
    await expect(region).toHaveAttribute('role', 'alert');
  });
}

test('a server-owned conversation mounts its recovery error region before failure', async ({
  page,
  request,
}) => {
  const created = await request.post('/api/server-owned/conversations', {
    data: { title: `Live region ${Date.now().toString(36)}` },
  });
  const conversation = await readCreatedConversation(created);

  await gotoHydrated(page, `/server-owned/${conversation.id}`);

  const region = page.getByTestId('recovery-error');
  await expect(region).toHaveCount(1);
  await expect(region).toBeEmpty();
  await expect(region).toHaveAttribute('role', 'alert');
});
