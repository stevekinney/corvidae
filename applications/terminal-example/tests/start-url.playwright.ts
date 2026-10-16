import { expect, test } from '@playwright/test';

import { OWN_SERVER_PORT } from './origin.ts';

const ORIGIN = `http://127.0.0.1:${OWN_SERVER_PORT}`;

/**
 * Start a server of this test's own, read the startup URL it prints, and hand both to `body`.
 * Nothing here chooses the token: it is the random one the server made, which is the flow the
 * README tells a person to follow.
 */
async function withServer(
  body: (startUrl: string) => Promise<void>,
  extraArguments: string[] = [],
): Promise<void> {
  const server = Bun.spawn(
    ['bun', 'src/server/main.ts', '--port', String(OWN_SERVER_PORT), ...extraArguments],
    {
      cwd: import.meta.dirname.replace(/\/tests$/, ''),
      env: { ...process.env, SHELL: '/bin/sh' },
      stdout: 'pipe',
      stderr: 'inherit',
      timeout: 60_000,
    },
  );
  try {
    const reader = server.stdout.getReader();
    let banner = '';
    while (!/Open http\S+\n/.test(banner)) {
      const { value, done } = await reader.read();
      if (done) throw new Error('the server ended before it printed its start URL');
      banner += new TextDecoder().decode(value);
    }
    const startUrl = /Open (http\S+)\n/.exec(banner)?.[1];
    if (startUrl === undefined) throw new Error('no start URL was printed');
    await body(startUrl);
  } finally {
    // The server is this test's own child.
    server.kill('SIGKILL');
  }
}

test('the printed start URL carries a random token and opens the terminal', async ({ page }) => {
  await withServer(async (startUrl) => {
    expect(startUrl).toMatch(new RegExp(`^${ORIGIN}/\\?token=[A-Za-z0-9_-]{32,}$`));
    await page.goto(startUrl);
    // The token is gone from the address bar once the cookie is set.
    expect(page.url()).toBe(`${ORIGIN}/`);
    await expect(page.getByRole('status').filter({ hasText: 'Connected' }).first()).toBeVisible();
    // Reloading needs no token: the cookie carries the browser.
    await page.reload();
    await expect(page.getByRole('status').filter({ hasText: 'Connected' }).first()).toBeVisible();
  });
});

test('the start URL admits one browser: a second is turned away and told to restart', async ({
  browser,
}) => {
  await withServer(async (startUrl) => {
    const first = await browser.newContext();
    const second = await browser.newContext();
    try {
      const firstPage = await first.newPage();
      await firstPage.goto(startUrl);
      await expect(
        firstPage.getByRole('status').filter({ hasText: 'Connected' }).first(),
      ).toBeVisible();
      const secondPage = await second.newPage();
      const refused = await secondPage.goto(startUrl);
      expect(refused?.status()).toBe(403);
      await expect(secondPage.getByText(/restart the server/i)).toBeVisible();
      expect(await second.cookies()).toEqual([]);
      // The first browser is unaffected and can use the same URL again without spending anything.
      await firstPage.goto(startUrl);
      expect(firstPage.url()).toBe(`${ORIGIN}/`);
    } finally {
      await first.close();
      await second.close();
    }
  });
});

test('--browsers admits that many, and no more', async ({ browser }) => {
  await withServer(
    async (startUrl) => {
      const statuses: (number | undefined)[] = [];
      for (let index = 0; index < 3; index += 1) {
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          const response = await page.goto(startUrl);
          statuses.push(response?.status());
        } finally {
          await context.close();
        }
      }
      expect(statuses).toEqual([200, 200, 403]);
    },
    ['--browsers', '2'],
  );
});
