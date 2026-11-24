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
  let fail = false;
  let reads = 0;
  let writes = 0;
  let externalOnly = false;
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
          `<!doctype html><html><head>${build.outputs
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
        return actor.method !== 'unauthenticated' && actor.workspace?.workspaceId === 'A' && present
          ? [
              {
                grantId: 'grant',
                clientId: 'client',
                clientName: 'Claude',
                resource: 'https://resource.test',
                approvedAt: 1,
                permissions: [
                  { scope: 'read', description: 'Read assets', available: true },
                  { scope: 'write', description: 'Change assets', available: false },
                ],
              },
            ]
          : [];
      },
      revoke: async (_actor, id) => {
        writes++;
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
    const page = await browser.newPage();
    await page.goto(server.url.href);
    await page.getByText('Claude', { exact: true }).waitFor();
    expect(await page.getByText('https://resource.test').count()).toBe(1);
    await page.getByText('Approved permissions').click();
    expect(await page.getByText('Read assets', { exact: false }).count()).toBe(1);
    expect(await page.getByText('currently unavailable', { exact: false }).count()).toBe(1);
    await page
      .getByRole('listitem')
      .filter({ has: page.getByRole('heading', { name: 'Claude' }) })
      .getByRole('button', { name: 'Disconnect' })
      .click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    expect(writes).toBe(0);
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
    await page.getByText('No connected apps.').waitFor();
    expect(await page.getByText('Claude', { exact: true }).count()).toBe(0);
    await page.getByRole('button', { name: 'Change account' }).click();
    await page.getByText('Claude', { exact: true }).waitFor();
    await page
      .getByRole('listitem')
      .filter({ has: page.getByRole('heading', { name: 'Claude' }) })
      .getByRole('button', { name: 'Disconnect' })
      .click();
    await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click();
    await page.getByRole('status').getByText('App disconnected.').waitFor();
    await page.getByText('No connected apps.').waitFor();
    externalOnly = true;
    await page.reload();
    await page.getByRole('link', { name: 'Manage connected apps' }).waitFor();
    expect(await page.getByRole('button', { name: 'Disconnect' }).count()).toBe(0);
    expect(await page.getByText('No connected apps.').count()).toBe(0);
  } finally {
    await browser.close();
    server.stop(true);
  }
});
