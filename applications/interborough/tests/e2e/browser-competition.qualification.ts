import { waitUntil } from '@lostgradient/testing/wait-until';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { competitionDirectory } from '../../scripts/environment-configuration.ts';
import { E2E_BARRIER_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

const directory = competitionDirectory();
if (!directory) throw new Error('The competition control directory is required.');

test.beforeAll(async () => {
  await waitUntil(
    () =>
      existsSync(join(directory, 'integration-ready')) &&
      existsSync(join(directory, 'browser-ready')),
    { message: 'both target cases to finish startup' },
  );
});

test('performs real browser actions until both target assertions run', async ({
  page,
  request,
}) => {
  await page.goto('/goals');
  let released = false;
  while (!released) {
    await page.reload();
    await expect(page.locator('[data-goal="seeded-goal"]')).toBeVisible();
    process.stdout.write(`COR2653_ACTION ${new Date().toISOString()}\n`);
    const response = await request.get(`${E2E_BARRIER_URL}/qualification`);
    expect(response.ok()).toBe(true);
    const status = (await response.json()) as { released: boolean };
    released = status.released;
  }
});
