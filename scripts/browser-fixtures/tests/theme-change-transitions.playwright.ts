/// <reference lib="dom" />
/**
 * A theme change must not animate. Cinder components transition color, background and border so
 * hover and press feedback eases, and every one of those values changes when the theme flips, so
 * without a guard a switch animates each button, card and banner from its old theme's colors to the
 * new ones. In a throttled page the animation stalls partway: the owner saw Interborough's banner
 * with a light background under dark-theme text, and a white search field, on a dark page.
 *
 * The fixture shell installs `guardThemeTransitions()` the way an application does; these tests
 * flip the theme both ways it changes and count the CSS transitions that start, then prove the
 * page still animates an ordinary state change.
 */

import { loadManifest } from '@lostgradient/testing';
import { expect, test, type Page } from '@playwright/test';

const manifest = loadManifest();
function fixtureRoute(slug: string): string {
  const entry = manifest.find((candidate) => candidate.slug === slug);
  const hash = entry?.fixtures?.find((fixture) => fixture.name === 'assertion')?.fixtureContentHash;
  if (hash === undefined) throw new Error(`Assertion fixture hash missing for ${slug}.`);
  // Not snapshot mode: snapshot mode zeroes every transition, which would hide the defect.
  return `/page/${slug}?fixture=assertion&fixtureContentHash=${hash}`;
}

/** Names of the CSS transitions running on the page after the next frame renders. */
async function transitionsAfter(page: Page, change: string): Promise<string[]> {
  return page.evaluate(async (script) => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the change is test-authored
    new Function(script)();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return document
      .getAnimations()
      .filter((animation): animation is CSSTransition => animation instanceof CSSTransition)
      .map((transition) => transition.transitionProperty);
  }, change);
}

for (const slug of ['button', 'banner', 'card']) {
  test(`${slug}: switching data-theme starts no transitions`, async ({ page }) => {
    await page.goto(fixtureRoute(slug), { waitUntil: 'load' });
    await page.waitForSelector(`.cinder-${slug}`, { state: 'attached' });

    const toDark = await transitionsAfter(
      page,
      "document.documentElement.dataset.theme = 'dark'; document.documentElement.style.colorScheme = 'dark';",
    );
    const toLight = await transitionsAfter(
      page,
      "document.documentElement.dataset.theme = 'light'; document.documentElement.style.colorScheme = 'light';",
    );

    expect({ toDark, toLight }).toEqual({ toDark: [], toLight: [] });
  });
}

test('switching the system color scheme starts no transitions', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(fixtureRoute('button'), { waitUntil: 'load' });
  await page.waitForSelector('.cinder-button', { state: 'attached' });
  // Let the system setting choose the theme, as an application in "system" mode does.
  await page.evaluate(() => {
    delete document.documentElement.dataset['theme'];
    delete document.documentElement.dataset['cinderTheme'];
    document.documentElement.style.colorScheme = '';
  });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

  await page.emulateMedia({ colorScheme: 'dark' });
  const running = await transitionsAfter(page, '');

  expect(running).toEqual([]);
});

test('an ordinary state change still animates', async ({ page }) => {
  await page.goto(fixtureRoute('button'), { waitUntil: 'load' });
  await page.waitForSelector('.cinder-button', { state: 'attached' });

  // A button that changes its own background is hover-like feedback, not a theme change.
  const running = await transitionsAfter(
    page,
    "document.querySelector('.cinder-button').style.backgroundColor = 'rgb(200, 0, 0)';",
  );

  expect(running).toContain('background-color');
});
