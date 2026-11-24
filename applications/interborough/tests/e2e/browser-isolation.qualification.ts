import { E2E_BARRIER_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

test('a browser stays on its own seeded host until released', async ({ page, request }) => {
  await page.goto('/goals');
  await expect(page.locator('[data-goal="seeded-goal"]')).toBeVisible();
  const revision = process.env['COR_2653_REVISION'];
  if (!revision) throw new Error('COR_2653_REVISION must name the expected build.');
  await expect(page.locator('.weft-shell-sidebar__commit')).toContainText(revision);
  await test.info().attach('seeded-host', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  expect((await request.post(`${E2E_BARRIER_URL}/qualification/ready`)).ok()).toBe(true);
  await expect
    .poll(
      async () => (await (await request.get(`${E2E_BARRIER_URL}/qualification`)).json()).released,
    )
    .toBe(true);
  await page.reload();
  await expect(
    page.locator('[data-goal="seeded-goal"]').getByRole('link', { name: 'say-hello' }),
  ).toBeVisible();
  await test.info().attach('after-peer-stop', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});
