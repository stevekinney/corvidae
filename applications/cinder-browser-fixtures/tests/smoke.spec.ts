import { expect, test, type Page } from '@playwright/test';

type ManifestResponse = {
  entries: Array<{
    slug: string;
    fixtures?: Array<{ name: string; fixtureContentHash: string }>;
  }>;
};

function isManifestResponse(value: unknown): value is ManifestResponse {
  if (value === null || typeof value !== 'object' || !('entries' in value)) return false;
  const entries: unknown = value.entries;
  return (
    Array.isArray(entries) &&
    entries.every((entry) => {
      if (entry === null || typeof entry !== 'object' || !('slug' in entry)) return false;
      if (typeof entry.slug !== 'string') return false;
      if (!('fixtures' in entry) || entry.fixtures === undefined) return true;
      return (
        Array.isArray(entry.fixtures) &&
        entry.fixtures.every(
          (fixture: unknown) =>
            fixture !== null &&
            typeof fixture === 'object' &&
            'name' in fixture &&
            typeof fixture.name === 'string' &&
            'fixtureContentHash' in fixture &&
            typeof fixture.fixtureContentHash === 'string',
        )
      );
    })
  );
}

async function getManifest(page: Page): Promise<ManifestResponse> {
  const response = await page.request.get('/api/manifest?standalone=1');
  const body: unknown = await response.json();
  if (!isManifestResponse(body)) throw new Error('Fixture manifest response has an invalid shape.');
  return body;
}

test('renders a direct fixture with snapshot semantics in light and dark themes', async ({
  browser,
}) => {
  for (const theme of ['light', 'dark'] as const) {
    const context = await browser.newContext({ colorScheme: theme });
    await context.addInitScript(
      (value) => localStorage.setItem('browser-fixture-theme', value),
      theme,
    );
    const page = await context.newPage();
    const body = await getManifest(page);
    const fixture = body.entries
      .find((entry) => entry.slug === 'button')
      ?.fixtures?.find((candidate) => candidate.name === 'primary');
    expect(fixture).toBeDefined();
    const response = await page.goto(
      `/page/button?snapshot=1&fixture=primary&fixtureContentHash=${fixture!.fixtureContentHash}`,
    );
    expect(response?.ok()).toBe(true);
    await expect(page.locator('#app > *')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-snapshot-mode', '');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await context.close();
  }
});

test('renders a host fixture and rejects unknown fixtures', async ({ page }) => {
  const manifest = await page.request.get('/api/manifest?standalone=1');
  expect(manifest.ok()).toBe(true);
  const body = await getManifest(page);
  const dropdown = body.entries.find((entry) => entry.slug === 'dropdown');
  const fixture = dropdown?.fixtures?.find((candidate) => candidate.name === 'open');
  expect(fixture).toBeDefined();
  const response = await page.goto(
    `/page/dropdown?snapshot=1&fixture=open&fixtureContentHash=${fixture!.fixtureContentHash}`,
  );
  expect(response?.ok()).toBe(true);
  await expect(page.locator('#app > *')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-snapshot-mode', '');
  const drift = await page.request.get(
    '/page/dropdown?snapshot=1&fixture=open&fixtureContentHash=' + '0'.repeat(64),
  );
  expect(drift.status()).toBe(409);
  expect(await drift.text()).toContain('hash drift');
  const unknown = await page.request.get(
    '/page/dropdown?snapshot=1&fixture=missing&fixtureContentHash=abc',
  );
  expect(unknown.status()).toBe(404);
  const malformed = await page.request.get('/page/%E0%A4%A');
  expect(malformed.status()).toBe(400);
});
