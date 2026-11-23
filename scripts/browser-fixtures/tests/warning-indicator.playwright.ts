import { loadManifest } from '@lostgradient/testing';
import { expect, test } from '@lostgradient/testing/playwright/component-page-fixture';
import type { Page } from '@playwright/test';

const entries = new Map(loadManifest().map((entry) => [entry.slug, entry] as const));
const viewport = { name: 'desktop', width: 1280, height: 800 } as const;

function entry(slug: 'meter' | 'sparkbar') {
  const value = entries.get(slug);
  if (value === undefined) throw new Error(`Fixture manifest is missing ${slug}.`);
  const fixture = value.fixtures?.find((candidate) => candidate.name === 'assertion');
  if (fixture === undefined) throw new Error(`${slug} has no assertion fixture.`);
  return { value, fixture };
}

/** Resolves the indicator through the rendered theme, matching CSS's serialized color syntax. */
function renderedWarningIndicator(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.backgroundColor = 'var(--cinder-status-warning-indicator)';
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`warning indicator paints Meter low fill and band (${theme})`, async ({
    componentPage,
  }, testInfo) => {
    const { value, fixture } = entry('meter');
    const page = await componentPage.open({
      entry: value,
      theme,
      viewport,
      fixtureName: fixture.name,
      fixtureContentHash: fixture.fixtureContentHash,
    });
    const route = new URL(page.url());
    route.searchParams.set('warning-indicator', '1');
    await page.goto(route.toString(), { waitUntil: 'load' });
    const meter = page.locator(".cinder-meter[data-cinder-state='low']").first();
    const fill = meter.locator('.cinder-meter__fill');
    const band = meter.locator('.cinder-meter__segment--state-low');
    await expect(meter).toBeVisible();
    await expect(band).toHaveCSS('opacity', '0.32');
    const indicator = await renderedWarningIndicator(page);
    await expect(fill).toHaveCSS('background-color', indicator);
    await expect(band).toHaveCSS('background-color', indicator);
    await testInfo.attach(`meter-warning-indicator-${theme}`, {
      body: await meter.screenshot(),
      contentType: 'image/png',
    });
  });

  test(`warning indicator paints Sparkbar warning fill (${theme})`, async ({
    componentPage,
  }, testInfo) => {
    const { value, fixture } = entry('sparkbar');
    const page = await componentPage.open({
      entry: value,
      theme,
      viewport,
      fixtureName: fixture.name,
      fixtureContentHash: fixture.fixtureContentHash,
    });
    const sparkbar = page.locator(".cinder-sparkbar[data-cinder-variant='warning']").first();
    const fill = sparkbar.locator('.cinder-sparkbar__fill');
    await expect(sparkbar).toBeVisible();
    const indicator = await renderedWarningIndicator(page);
    await expect(fill).toHaveCSS('background-color', indicator);
    await testInfo.attach(`sparkbar-warning-indicator-${theme}`, {
      body: await sparkbar.screenshot(),
      contentType: 'image/png',
    });
  });
}
