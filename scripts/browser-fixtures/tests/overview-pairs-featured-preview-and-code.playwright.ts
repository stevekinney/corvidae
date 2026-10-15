import { THEME_STORAGE_KEY, themeContextOptions } from '@lostgradient/testing';
import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { browserPorts } from '../scripts/browser-ports.ts';

/**
 * COR-441: the Overview README snippet used to sit above a live preview that was
 * mounted from an unrelated example, so the code on the page could not produce
 * the preview below it. The README is now labeled "Reference usage", and the
 * stage is titled with the selected example and offers that example's own source
 * behind "Show code". Combobox and Message are the two components whose README
 * snippet differed from their featured example, so each is checked in both
 * themes and at a phone and a desktop viewport.
 *
 * The fixture host renders bare fixtures, not the documentation page, so this
 * spec runs the playground server itself and visits its real `/page/<slug>`
 * route (the same one cinder.website serves).
 */

const { PLAYGROUND_PORT: playgroundPort } = browserPorts(['PLAYGROUND_PORT']);
const playgroundOrigin = `http://127.0.0.1:${playgroundPort}`;
const playgroundDirectory = resolve(import.meta.dirname, '../../../applications/playground');
let playgroundServer: ReturnType<typeof Bun.spawn> | undefined;

test.beforeAll(async ({ browser }) => {
  // The first request builds the playground's bundles from cold, which is the
  // cost of starting a real server rather than a wait on a flaky condition.
  test.setTimeout(240_000);
  playgroundServer = Bun.spawn(['bun', 'src/playground-server.ts'], {
    cwd: playgroundDirectory,
    env: { ...process.env, PORT: String(playgroundPort) },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  await expect
    .poll(
      async () => {
        try {
          const response = await fetch(`${playgroundOrigin}/ping`);
          return response.status;
        } catch {
          return 0;
        }
      },
      { timeout: 60_000 },
    )
    .toBe(200);
  const warmed = await fetch(`${playgroundOrigin}/page/combobox`);
  expect(warmed.status).toBe(200);

  // Fetching the HTML only builds the server-rendered page. The client bundle,
  // the scenario loaders and the hydration path build on the first request
  // from a browser, which would otherwise land inside whichever test runs
  // first and be charged against its 5 s assertion. Visit each page the way a
  // test does and wait until its preview is interactive.
  const warmContext = await browser.newContext({ baseURL: playgroundOrigin });
  try {
    for (const component of components) {
      const warmPage = await warmContext.newPage();
      await warmPage.goto(`/page/${component.slug}`, { waitUntil: 'load' });
      await expect(warmPage.locator(`#overview-mount-${component.scenario}`)).toHaveAttribute(
        'data-example-preview-ready',
        '',
        { timeout: 60_000 },
      );
      await warmPage.close();
    }
  } finally {
    await warmContext.close();
  }
});

test.afterAll(() => {
  playgroundServer?.kill();
});

const themes = ['light', 'dark'] as const;
const viewports = [
  { name: '390x844', width: 390, height: 844 },
  { name: '1280x720', width: 1280, height: 720 },
] as const;

const components = [
  {
    slug: 'combobox',
    scenario: 'disabled',
    title: 'Disabled combobox',
    // A fragment unique to the selected example, present in both README and stage code.
    sharedCode: 'label="Plan"',
  },
  {
    slug: 'message',
    scenario: 'basic',
    title: 'Basic message',
    sharedCode: '<Message role="assistant" timestamp="10:00">How can I help?</Message>',
  },
] as const;

for (const component of components) {
  for (const theme of themes) {
    for (const viewport of viewports) {
      test(`Overview pairs featured preview and code: ${component.slug} (${theme}, ${viewport.name})`, async ({
        browser,
      }) => {
        const context = await browser.newContext({
          ...themeContextOptions(theme),
          viewport: { width: viewport.width, height: viewport.height },
          baseURL: playgroundOrigin,
          permissions: ['clipboard-read', 'clipboard-write'],
        });
        await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [
          THEME_STORAGE_KEY,
          theme,
        ] as const);
        const page = await context.newPage();
        try {
          await page.goto(`/page/${component.slug}`, { waitUntil: 'load' });

          const mount = page.locator(`#overview-mount-${component.scenario}`);
          await expect(mount).toHaveAttribute('data-example-preview-ready', '');

          const stage = page.locator('#overview .dx-stage');
          await expect(stage.getByRole('heading', { name: component.title })).toBeVisible();
          await expect(stage.locator(`#overview-mount-${component.scenario}`)).toBeVisible();

          const reference = page.getByRole('region', { name: 'Reference usage' });
          await expect(reference).toBeVisible();
          const referenceText = await reference.locator('pre').first().innerText();
          const referenceCode = referenceText.replace(/\s+/g, ' ');
          expect(referenceCode).toContain(component.sharedCode);

          await stage.getByRole('button', { name: 'Show code' }).click();
          const code = stage.locator('pre').first();
          await expect(code).toBeVisible();
          const stageCode = await code.innerText();
          expect(stageCode.replace(/\s+/g, ' ')).toContain(component.sharedCode);

          // The code on the stage is exactly the source the Examples section would
          // show for the same scenario, not README text or a synthesized snippet.
          const servedResponse = await page.request.get(
            `/example-src/${component.slug}/${component.scenario}`,
          );
          const served = await servedResponse.text();
          expect(stageCode.replace(/\s+/g, ' ').trim()).toBe(served.replace(/\s+/g, ' ').trim());

          // Copy code copies that same paired source.
          await stage.getByRole('button', { name: /^copy/i }).first().click();
          const copied = await page.evaluate(() => navigator.clipboard.readText());
          expect(copied.replace(/\s+/g, ' ').trim()).toBe(served.replace(/\s+/g, ' ').trim());
        } finally {
          await context.close();
        }
      });
    }
  }
}
