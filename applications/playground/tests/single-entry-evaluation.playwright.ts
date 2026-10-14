/**
 * Each page's entry module, and the landing page's shell entry, is evaluated exactly once.
 *
 * The stable entry URLs (`/page-bundle/<name>.js`, `/shell-bundle/shell.js`) used to serve a byte
 * copy of the hashed entry that peer chunks import, so the browser evaluated the same top-level
 * code under two URLs: every component page hydrated twice and logged `hydration_mismatch`. Here
 * the stable URL must be one import of a hashed entry, no script may be served twice under two
 * URLs, and the loaded page must hydrate once with no console warning or error.
 */
import { expect, test, type Page } from '@playwright/test';

type LoadedScript = { url: string; body: string };

async function openAndRecord(page: Page, path: string) {
  const scripts: Promise<LoadedScript>[] = [];
  const diagnostics: string[] = [];
  page.on('response', (response) => {
    if (response.request().resourceType() !== 'script') return;
    scripts.push(response.text().then((body) => ({ url: new URL(response.url()).pathname, body })));
  });
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      diagnostics.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`));
  await page.goto(path, { waitUntil: 'networkidle' });
  return { scripts: await Promise.all(scripts), diagnostics };
}

function expectSingleEvaluation(scripts: readonly LoadedScript[], stableUrl: string): void {
  const stable = scripts.find((script) => script.url === stableUrl);
  expect(stable, `${stableUrl} was loaded`).toBeDefined();
  const hashedUrl = /^import "([^"]+)";\n$/.exec(stable?.body ?? '')?.[1];
  expect(hashedUrl, `${stableUrl} is one import of a hashed entry`).toMatch(
    /^\/(?:page|shell)-bundle\/[A-Za-z0-9_-]+-[a-z0-9]{8,}\.js$/,
  );
  expect(scripts.map((script) => script.url)).toContain(hashedUrl);

  const urlsByBody = new Map<string, string[]>();
  for (const script of scripts) {
    urlsByBody.set(script.body, [...(urlsByBody.get(script.body) ?? []), script.url]);
  }
  const duplicated = [...urlsByBody.values()].filter((urls) => new Set(urls).size > 1);
  expect(duplicated, 'scripts served under more than one URL').toEqual([]);
}

test('a component page evaluates its entry once and hydrates without warnings', async ({
  page,
}) => {
  const { scripts, diagnostics } = await openAndRecord(page, '/page/button');

  expectSingleEvaluation(scripts, '/page-bundle/button.js');
  await expect(page.locator('#app[data-playground-controls-hydrated]')).toHaveCount(1);
  expect(diagnostics).toEqual([]);
});

test('the landing page evaluates the shell entry once without warnings', async ({ page }) => {
  const { scripts, diagnostics } = await openAndRecord(page, '/');

  expectSingleEvaluation(scripts, '/shell-bundle/shell.js');
  await expect(page.locator('h1')).toHaveCount(1);
  expect(diagnostics).toEqual([]);
});
