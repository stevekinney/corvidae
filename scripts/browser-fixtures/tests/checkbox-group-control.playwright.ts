import { loadManifest } from '@corvidae/testing';
import { expect, test } from '@playwright/test';

const manifest = loadManifest();
function fixtureRoute(slug: string): string {
  const entry = manifest.find((candidate) => candidate.slug === slug);
  const hash = entry?.fixtures?.find((fixture) => fixture.name === 'assertion')?.fixtureContentHash;
  if (hash === undefined) throw new Error(`Assertion fixture hash missing for ${slug}.`);
  return `/page/${slug}?snapshot=1&fixture=assertion&fixtureContentHash=${hash}`;
}

test.describe('checkbox-group disabled-fieldset label dimming', () => {
  test('a disabled CheckboxGroup dims a child label styled only via the native fieldset cascade', async ({
    page,
  }) => {
    await page.goto(fixtureRoute('checkbox-group'), { waitUntil: 'load' });
    await page.waitForSelector('#app > *', { state: 'visible', timeout: 20_000 });

    const mount = page.locator('#example-mount-disabled-fieldset');
    await expect(mount).toBeVisible();
    const smsLabel = mount.locator('label', { hasText: 'SMS' });
    await expect(smsLabel).toBeVisible();

    const styles = await smsLabel.evaluate((element) => {
      const resolvedDisabledColor = getComputedStyle(document.documentElement)
        .getPropertyValue('--cinder-text-disabled')
        .trim();
      const probe = document.createElement('div');
      probe.style.color = resolvedDisabledColor;
      document.body.appendChild(probe);
      const resolvedDisabledRgb = getComputedStyle(probe).color;
      probe.remove();
      const computed = getComputedStyle(element);
      return {
        color: computed.color,
        cursor: computed.cursor,
        resolvedDisabledRgb,
      };
    });

    expect(styles.color).toBe(styles.resolvedDisabledRgb);
    expect(styles.cursor).toBe('not-allowed');
  });
});
