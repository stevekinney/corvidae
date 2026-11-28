import { principalFromJwtClaims } from '@lostgradient/backchannel';
import { sveltePlugin } from '@lostgradient/testing';
import { afterAll, expect, test } from 'bun:test';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { installFixture } from './installed-fixture.ts';

const fixture = await installFixture();
afterAll(() => fixture.cleanup());

test('installed public entries support personal connected app management', async () => {
  const installedPath = Bun.resolveSync(
    '@lostgradient/connected-apps/backchannel',
    join(fixture.consumer, 'probe.ts'),
  );
  const installed = (await import(
    pathToFileURL(installedPath).href
  )) as typeof import('../src/backchannel.ts');
  expect(installed.connectedAppsOperations.map((operation) => operation.name)).toEqual([
    'connected.apps.list',
    'connected.apps.revoke',
  ]);
  const headlessEntry = join(fixture.consumer, 'headless.ts');
  await Bun.write(headlessEntry, "export * from '@lostgradient/connected-apps/svelte';");
  const headless = await Bun.build({
    entrypoints: [headlessEntry],
    target: 'browser',
    metafile: true,
    plugins: [sveltePlugin({ generate: 'client' })],
  });
  expect(headless.success).toBe(true);
  expect(JSON.stringify(headless.metafile)).not.toContain('/cinder/');
  const build = await Bun.build({
    entrypoints: [join(fixture.consumer, 'installed-client.ts')],
    target: 'browser',
    outdir: join(fixture.consumer, 'dist'),
    plugins: [sveltePlugin({ generate: 'client' })],
  });
  expect(build.success).toBe(true);
  const outputs = new Map(build.outputs.map((output) => [basename(output.path), output]));
  const javascript = build.outputs.find((output) => output.kind === 'entry-point')!;
  let present = true;
  let duplicateName = true;
  let fail = false;
  let reads = 0;
  let writes = 0;
  let externalOnly = false;
  let heldRevoke: PromiseWithResolvers<void> | undefined;
  let handler: ReturnType<typeof installed.createConnectedAppsHandler>;
  let externalHandler: ReturnType<typeof installed.createConnectedAppsHandler>;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/connected-apps/jsonrpc')
        return externalOnly ? externalHandler(request) : handler(request);
      if (url.pathname === '/')
        return new Response(
          `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">${build.outputs
            .filter((output) => output.path.endsWith('.css'))
            .map((output) => `<link rel="stylesheet" href="/${basename(output.path)}">`)
            .join(
              '',
            )}</head><body><div id="app"></div><script type="module" src="/${basename(javascript.path)}"></script></body></html>`,
          { headers: { 'content-type': 'text/html' } },
        );
      const output = outputs.get(url.pathname.slice(1));
      return output ? new Response(output) : new Response('Not found', { status: 404 });
    },
  });
  const principal = (workspaceId: string) => ({
    ...principalFromJwtClaims({ sub: 'member' }),
    workspace: {
      version: 1 as const,
      workspaceId,
      actorId: 'member',
      actorKind: 'user' as const,
      owner: 'owner',
      membershipRevision: '1',
      capabilities: ['workspace:use' as const],
    },
  });
  handler = installed.createConnectedAppsHandler({
    publicOrigin: server.url.origin,
    guardWrite: async (request) => request.headers.get('x-csrf') === 'valid',
    authenticateSession: async (request) => ({
      method: 'jwt',
      principal: principal(request.headers.get('cookie')?.includes('workspace=B') ? 'B' : 'A'),
    }),
    host: {
      currentMember: async () => true,
      list: async (actor) => {
        reads++;
        if (actor.method === 'unauthenticated' || actor.workspace?.workspaceId !== 'A' || !present)
          return [];
        const grant = {
          grantId: 'grant',
          clientId: 'client',
          clientName: 'Claude',
          resource: 'https://resource.test',
          approvedAt: 1,
          permissions: [
            { scope: 'read', description: 'Read assets', available: true },
            { scope: 'write', description: 'Change assets', available: false },
          ],
        };
        return duplicateName
          ? [grant, { ...grant, grantId: 'separate-grant', clientId: 'separate-client' }]
          : [grant];
      },
      revoke: async (_actor, id) => {
        writes++;
        await heldRevoke?.promise;
        if (fail) throw new Error('Unavailable');
        if (id !== 'grant') return false;
        present = false;
        return true;
      },
    },
  });
  externalHandler = installed.createConnectedAppsHandler({
    publicOrigin: server.url.origin,
    guardWrite: async () => true,
    authenticateSession: async () => ({ method: 'jwt', principal: principal('A') }),
    host: {
      currentMember: async () => true,
      managementDestination: 'https://issuer.test/settings',
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 375, height: 812 },
      hasTouch: true,
      isMobile: true,
    });
    await page.goto(server.url.href);
    await page.getByRole('heading', { name: 'Claude', exact: true }).first().waitFor();
    const original = page.getByRole('listitem').filter({
      has: page.getByText('Grant reference grant', { exact: true }),
    });
    const duplicate = page.getByRole('listitem').filter({
      has: page.getByText('Grant reference separate-grant', { exact: true }),
    });
    expect(await original.getByText('Grant reference grant', { exact: true }).isVisible()).toBe(
      true,
    );
    expect(
      await duplicate.getByText('Grant reference separate-grant', { exact: true }).isVisible(),
    ).toBe(true);
    const disclosure = original.getByText('Connection details', { exact: true });
    const reachesTouchTarget = await disclosure.evaluate((label) => {
      const trigger = label.closest('button, summary');
      if (!trigger) return false;
      const bounds = trigger.getBoundingClientRect();
      const x = bounds.left + bounds.width / 2;
      const y = bounds.top + bounds.height / 2;
      return [-21.5, 21.5].every((offset) =>
        trigger.contains(document.elementFromPoint(x, y + offset)),
      );
    });
    expect(reachesTouchTarget).toBe(true);
    await disclosure.click();
    expect(await original.getByText('https://resource.test').count()).toBe(1);
    expect(
      await original
        .getByRole('region', { name: 'Connection details' })
        .getByText('Read assets', { exact: false })
        .count(),
    ).toBe(1);
    expect(await original.getByText('currently unavailable', { exact: false }).count()).toBe(1);
    await original.getByRole('button', { name: 'Disconnect' }).click();
    const confirmation = page.getByRole('dialog', { name: 'Disconnect Claude' });
    expect(await confirmation.getByText('Grant reference grant', { exact: true }).count()).toBe(1);
    await confirmation.getByRole('button', { name: 'Cancel' }).click();
    expect(writes).toBe(0);
    duplicateName = false;
    await page.getByRole('button', { name: 'Change account' }).click();
    await page.getByText('You haven’t authorized any apps in this workspace.').waitFor();
    await page.getByRole('button', { name: 'Change account' }).click();
    await page.getByText('Claude', { exact: true }).waitFor();
    fail = true;
    const previousReads = reads;
    await page
      .getByRole('listitem')
      .filter({ has: page.getByRole('heading', { name: 'Claude' }) })
      .getByRole('button', { name: 'Disconnect' })
      .click();
    await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click();
    await page.getByRole('status').getByText('Unable to disconnect', { exact: false }).waitFor();
    expect(reads).toBeGreaterThan(previousReads);
    fail = false;
    await page.getByRole('button', { name: 'Change account' }).click();
    await page.getByText('You haven’t authorized any apps in this workspace.').waitFor();
    expect(await page.getByText('Claude', { exact: true }).count()).toBe(0);
    await page.getByRole('button', { name: 'Change account' }).click();
    await page.getByText('Claude', { exact: true }).waitFor();
    await page
      .getByRole('listitem')
      .filter({ has: page.getByRole('heading', { name: 'Claude' }) })
      .getByRole('button', { name: 'Disconnect' })
      .click();
    heldRevoke = Promise.withResolvers<void>();
    await confirmation.getByRole('button', { name: 'Disconnect' }).click();
    const row = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('heading', { name: 'Claude' }) });
    expect(await row.isVisible()).toBe(true);
    expect(await row.getByRole('button', { name: 'Disconnect' }).getAttribute('aria-busy')).toBe(
      'true',
    );
    heldRevoke.resolve();
    await page.getByRole('status').getByText('App disconnected.').waitFor();
    await page.getByText('You haven’t authorized any apps in this workspace.').waitFor();
    externalOnly = true;
    await page.reload();
    await page.getByRole('link', { name: 'Manage connected apps' }).waitFor();
    expect(await page.getByRole('button', { name: 'Disconnect' }).count()).toBe(0);
    expect(await page.getByText('You haven’t authorized any apps in this workspace.').count()).toBe(
      0,
    );
  } finally {
    heldRevoke?.resolve();
    await browser.close();
    server.stop(true);
  }
});
