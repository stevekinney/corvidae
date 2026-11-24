import { expect, test } from './fixtures.ts';
import { E2E_FIRST_RUN_URL } from './e2e-constants.ts';

const marker = process.env['QUALIFICATION_MARKER'];
if (!marker) throw new Error('Missing synthetic credential marker');
test.use({ baseURL: E2E_FIRST_RUN_URL, trace: 'on' });

test('credential success and validation failure keep visible evidence masked', async ({ page }, info) => {
  await page.goto('/settings/models');
  await page.locator('[data-provider="anthropic"]').getByRole('button', { name: /Connect/ }).click();
  const dialog = page.getByRole('dialog');
  const input = dialog.locator('input[type="password"]');
  await dialog.getByRole('button', { name: /^Connect$/ }).click();
  await expect(dialog.getByText('Enter the key.')).toBeVisible();
  await page.screenshot({ path: info.outputPath('credential-error.png') });
  await input.fill(marker);
  await page.screenshot({ path: info.outputPath('credential-masked.png') });
  await dialog.getByRole('button', { name: /^Connect$/ }).click();
  await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('credential-success.png') });
  expect(await page.content()).not.toContain(marker);
  const snapshot = await page.request.get('/host/providers');
  const { configurationRevision } = await snapshot.json();
  const response = await page.request.put('/host/providers/unknown-qualification-provider', {
    data: { apiKey: marker, operationId: crypto.randomUUID(), expectedRevision: configurationRevision },
    headers: { origin: E2E_FIRST_RUN_URL },
  });
  expect(response.status()).toBe(400);
  const failure = await response.text();
  expect(JSON.parse(failure)).toMatchObject({ error: 'invalid', field: 'provider' });
  expect(failure).not.toContain(marker);
  if (process.env['QUALIFICATION_EXPECTED_FAILURE'] === '1') expect(response.status()).toBe(201);
});
