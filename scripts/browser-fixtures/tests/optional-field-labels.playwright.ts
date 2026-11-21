import { loadManifest } from '@lostgradient/testing';
import { expect, test } from '@lostgradient/testing/playwright/component-page-fixture';

const formField = loadManifest().find((entry) => entry.slug === 'form-field');

if (formField === undefined) throw new Error('Component manifest is missing form-field.');

test('optional labels retain label metrics and expose Optional in accessible names', async ({
  componentPage,
}) => {
  const page = await componentPage.open({
    entry: formField,
    fixtureName: 'optional-labels',
    theme: 'light',
    viewport: { name: 'desktop', width: 1280, height: 900 },
  });

  const mount = page.locator('#example-mount-optional-labels');
  const standaloneLabel = mount.locator('label', { hasText: 'Timezone' });
  const automaticLabel = mount.locator('.cinder-form-field__label');
  const markers = mount.locator('.cinder-_optional-marker');

  await expect(mount.getByRole('textbox', { name: 'Timezone Optional' })).toBeVisible();
  await expect(mount.getByRole('textbox', { name: 'Nickname Optional' })).toBeVisible();
  await expect(markers).toHaveCount(2);

  const metrics = await markers.evaluateAll((elements) =>
    elements.map((marker) => {
      const markerStyle = getComputedStyle(marker);
      const labelStyle = getComputedStyle(marker.parentElement as HTMLElement);
      return {
        color: markerStyle.color,
        fontSize: markerStyle.fontSize,
        fontWeight: markerStyle.fontWeight,
        labelColor: labelStyle.color,
        labelFontSize: labelStyle.fontSize,
        labelFontWeight: labelStyle.fontWeight,
      };
    }),
  );

  for (const metric of metrics) {
    expect(metric.fontSize).toBe(metric.labelFontSize);
    expect(Number(metric.fontWeight)).toBeLessThan(Number(metric.labelFontWeight));
    expect(metric.color).not.toBe(metric.labelColor);
  }

  await expect(standaloneLabel).toContainText('Timezone Optional');
  await expect(automaticLabel).toContainText('Nickname Optional');
});
