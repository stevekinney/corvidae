import { loadManifest } from '@lostgradient/testing';
import { expect, test } from './component-page-fixture.ts';

const entriesBySlug = new Map(loadManifest().map((entry) => [entry.slug, entry] as const));
const desktopViewport = { name: 'desktop', width: 1280, height: 900 } as const;
const lightTheme = 'light' as const;

function getEntry(slug: string) {
  const entry = entriesBySlug.get(slug);
  if (!entry) throw new Error(`Component manifest is missing slug: ${slug}`);
  return entry;
}

test.describe('SchemaForm native form serialization', () => {
  test('serializes the validated JSON Schema value into real FormData', async ({
    componentPage,
  }) => {
    const page = await componentPage.open({
      entry: getEntry('schema-form'),
      theme: lightTheme,
      viewport: desktopViewport,
      fixtureName: 'assertion',
    });

    const mount = page.locator('#example-mount-json-schema');
    const form = mount.locator('form');
    await expect(form).toBeVisible();

    await mount.getByRole('button', { name: 'Save schedule' }).click();
    const submittedOutput = mount
      .getByRole('heading', { name: 'Last valid submission' })
      .locator('..')
      .locator('pre');
    await expect(submittedOutput).toContainText('"name": "Refresh indexes"');

    const payload = await form.evaluate((element) => {
      if (!(element instanceof HTMLFormElement)) throw new Error('Expected a form element.');
      const raw = new FormData(element).get('payload');
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    });

    expect(payload).toEqual({
      name: 'Refresh indexes',
      retries: 2,
      enabled: true,
      cadence: 'daily',
    });
  });
});
