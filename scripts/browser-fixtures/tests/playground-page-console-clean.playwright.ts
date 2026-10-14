import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { browserPorts } from '../scripts/browser-ports.ts';

/**
 * Loading `/page/button` logged Svelte's `hydration_mismatch` warning. The page
 * entry ran twice: the document loads it from the bare `/page-bundle/button.js`
 * URL, while the code-split chunks import it back by its hashed name, and a
 * browser evaluates one module per URL. The second copy hydrated a tree the
 * first had already brought to life, failed, and remounted the page. A
 * documentation page load must leave the console free of warnings and errors.
 *
 * The fixture host renders bare fixtures, not the documentation page, so this
 * spec runs the playground server itself and visits its real `/page/<slug>`
 * route (the same one cinder.website serves).
 */

const { PLAYGROUND_PORT: playgroundPort } = browserPorts(['PLAYGROUND_PORT']);
const playgroundOrigin = `http://127.0.0.1:${playgroundPort}`;
const playgroundDirectory = resolve(import.meta.dirname, '../../../applications/playground');
let playgroundServer: ReturnType<typeof Bun.spawn> | undefined;

test.beforeAll(async () => {
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
  for (const path of ['/page/button', '/page-bundle/button.js']) {
    const warmed = await fetch(`${playgroundOrigin}${path}`);
    expect(warmed.status).toBe(200);
  }
});

test.afterAll(async () => {
  playgroundServer?.kill();
  // Another spec in this worker inherits PLAYGROUND_PORT, so release it before that spec starts.
  await playgroundServer?.exited;
});

test('loading /page/button logs no console warning or error', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: playgroundOrigin });
  const page = await context.newPage();
  const diagnostics: string[] = [];
  page.on('pageerror', (error) => diagnostics.push(`Page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      diagnostics.push(`Console ${message.type()}: ${message.text()}`);
    }
  });
  try {
    await page.goto('/page/button', { waitUntil: 'load' });
    // The overview example becomes ready only after hydration has finished,
    // including the remount a failed hydration falls back to, so the warning
    // has been logged by the time this resolves.
    await expect(page.locator('[id^="overview-mount-"]').first()).toHaveAttribute(
      'data-example-preview-ready',
      '',
      { timeout: 60_000 },
    );
    await expect(page.locator('#app')).toHaveAttribute('data-playground-controls-hydrated', '');
    expect(diagnostics).toEqual([]);
  } finally {
    await context.close();
  }
});
