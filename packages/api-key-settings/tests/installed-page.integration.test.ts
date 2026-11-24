import { principalFromJwtClaims } from '@lostgradient/backchannel';
import { createApiKeys } from '@lostgradient/credentials/api-keys';
import { MemoryStorage } from '@lostgradient/storage';
import { sveltePlugin } from '@lostgradient/testing';
import { afterAll, expect, it } from 'bun:test';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { installFixture } from './installed-fixture.ts';

const fixture = await installFixture();
afterAll(async () => {
  await fixture.cleanup();
});

it('installs the public entries and exercises the page against durable credentials', async () => {
  using storage = new MemoryStorage();
  let clock = 10;
  let writes = 0;
  let reads = 0;
  let loseNext = false;
  const diagnostics: string[] = [];
  const keys = createApiKeys({
    storage,
    now: () => clock,
    resolveAuthority: async ({ workspaceId, subject }) => ({
      workspaceId,
      subject,
      scopes: ['equipment:read'],
    }),
    authorizeManagement: async (actor: { workspace?: { workspaceId: string } }, request) =>
      actor.workspace?.workspaceId === request.workspaceId,
  });
  const installedPath = Bun.resolveSync(
    '@lostgradient/api-key-settings/backchannel',
    join(fixture.consumer, 'probe.ts'),
  );
  const installed = (await import(
    pathToFileURL(installedPath).href
  )) as typeof import('../src/backchannel.ts');
  expect(
    installed.apiKeyManagementOperations.map((operation) => operation.name).toSorted(),
  ).toEqual(['api.keys.issue', 'api.keys.list', 'api.keys.revoke', 'api.keys.rotate']);
  expect(installed.apiKeyManagementOperations.every((operation) => !operation.mcpExposable)).toBe(
    true,
  );
  const entry = join(fixture.consumer, 'headless.ts');
  await Bun.write(entry, "export * from '@lostgradient/api-key-settings/svelte';");
  const headless = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    metafile: true,
    plugins: [sveltePlugin({ generate: 'client' })],
  });
  expect(headless.success).toBe(true);
  expect(JSON.stringify(headless.metafile)).not.toContain('/cinder/');
  const headlessSource = await headless.outputs[0].text();
  for (const name of [
    'ApiKeySettingsProvider',
    'useApiKeysIssue',
    'useApiKeysList',
    'useApiKeysRotate',
    'useApiKeysRevoke',
  ])
    expect(headlessSource).toContain(name);
  const build = await Bun.build({
    entrypoints: [join(fixture.consumer, 'installed-client.ts')],
    outdir: join(fixture.consumer, 'dist'),
    target: 'browser',
    metafile: true,
    plugins: [sveltePlugin({ generate: 'client' })],
  });
  expect(build.success).toBe(true);
  expect(
    Object.keys(build.metafile.inputs).filter((path) =>
      /storage|credential.verifier|api-keys\.ts|authentication/.test(path),
    ),
  ).toEqual([]);
  const outputs = new Map(build.outputs.map((output) => [basename(output.path), output]));
  const javascript = build.outputs.find((output) => output.kind === 'entry-point');
  if (!javascript) throw new Error('Missing browser entry');
  let handler: ReturnType<typeof installed.createApiKeyManagementHandler>;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/key-admin/jsonrpc') {
        const body = (await request.clone().json()) as { method: string };
        if (body.method === 'api.keys.list') reads++;
        else writes++;
        const response = await handler(request);
        if (loseNext && body.method === 'api.keys.issue') {
          loseNext = false;
          await response.body?.cancel();
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error('Response lost'));
              },
            }),
          );
        }
        return response;
      }
      if (url.pathname === '/read') {
        const identity = await keys.verify(request.headers.get('x-api-key') ?? '');
        return identity?.scopes.includes('equipment:read')
          ? Response.json({ equipment: ['pump'] })
          : new Response('Unauthorized', { status: 401 });
      }
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
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const principal = (workspaceId: string) => ({
      ...principalFromJwtClaims({ sub: 'manager' }),
      workspace: {
        version: 1 as const,
        workspaceId,
        actorId: 'manager',
        actorKind: 'user' as const,
        owner: 'owner',
        membershipRevision: '1',
        capabilities: ['workspace:use' as const, 'workspace:manage' as const],
      },
    });
    handler = installed.createApiKeyManagementHandler({
      host: {
        keys,
        currentManager: async () => true,
        targets: async () => [{ subject: 'service', scopes: ['equipment:read'] }],
        allowedActions: async (_actor, key) =>
          key.revokedAt !== undefined
            ? []
            : key.retiresAt !== undefined
              ? ['revoke']
              : ['rotate', 'revoke'],
        overlapCutoff: () => 20,
      },
      authenticateSession: async (request) => ({
        method: 'jwt',
        principal: principal(request.headers.get('cookie')?.includes('workspace=B') ? 'B' : 'A'),
      }),
      publicOrigin: server.url.origin,
      guardWrite: async (request) => request.headers.get('x-csrf-token') === 'valid',
    });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning')
        diagnostics.push(message.text());
    });
    page.on('pageerror', (error) => diagnostics.push(error.message));
    await page.goto(server.url.href);
    const issue = async () => {
      await page.getByLabel('Label').fill('sync');
      await page.getByLabel('Target').selectOption('service');
      await page.getByLabel('equipment:read').check();
      await page.getByRole('button', { name: 'Issue key' }).click();
    };
    const secretText = () => page.locator('section[aria-label="New API key"] code').textContent();
    const inspect = async (secret: string) => {
      const state = await page.evaluate(() =>
        (window as typeof window & { inspectSettings: () => string }).inspectSettings(),
      );
      expect(state).not.toContain(secret);
      expect(JSON.stringify(diagnostics)).not.toContain(secret);
    };
    const read = async (secret: string) => {
      const response = await fetch(new URL('/read', server.url), {
        headers: { 'x-api-key': secret },
      });
      return response.status;
    };
    const call = async (method: string, params: object, cookie = 'workspace=A', csrf = 'valid') => {
      const response = await fetch(new URL('/key-admin/jsonrpc', server.url), {
        method: 'POST',
        headers: {
          origin: server.url.origin,
          cookie,
          'x-csrf-token': csrf,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      return response;
    };
    await issue();
    await page.locator('section[aria-label="New API key"] code').waitFor();
    const first = await secretText();
    if (!first) throw new Error('Missing issued secret');
    expect(await read(first)).toBe(200);
    const listResponse = await call('api.keys.list', {}, 'workspace=A; session=other');
    const listText = await listResponse.text();
    expect(listText).not.toContain(first);
    const list = JSON.parse(listText) as { result: { keys: { id: string }[] } };
    const id = list.result.keys[0]!.id;
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await inspect(first);
    await page.reload();
    await page.getByRole('button', { name: 'Rotate' }).waitFor();
    await inspect(first);
    await page.getByRole('button', { name: 'Rotate' }).click();
    await page.locator('section[aria-label="New API key"] code').waitFor();
    const second = await secretText();
    if (!second) throw new Error('Missing replacement secret');
    const afterRotate = await call('api.keys.list', {});
    const afterRotateText = await afterRotate.text();
    expect(afterRotateText).not.toContain(first);
    expect(afterRotateText).not.toContain(second);
    const afterRotateBody = JSON.parse(afterRotateText) as {
      result: { keys: { id: string; retiresAt?: number }[] };
    };
    expect(afterRotateBody.result.keys.find((key) => key.id === id)?.retiresAt).toBe(20);
    const replacementId = afterRotateBody.result.keys.find((key) => key.id !== id)?.id;
    if (!replacementId) throw new Error('Missing replacement metadata');
    expect(await read(first)).toBe(200);
    expect(await read(second)).toBe(200);
    clock = 20;
    expect(await read(first)).toBe(401);
    expect(await read(second)).toBe(200);
    const otherList = await call('api.keys.list', {}, 'workspace=B');
    const otherText = await otherList.text();
    expect(otherText).not.toContain(first);
    expect(otherText).not.toContain(second);
    expect(JSON.parse(otherText).result.keys).toEqual([]);
    for (const method of ['api.keys.rotate', 'api.keys.revoke']) {
      const denied = await call(method, { id }, 'workspace=B');
      expect(((await denied.json()) as { error?: unknown }).error).toBeDefined();
    }
    const deniedIssue = await call('api.keys.issue', {
      label: 'bad',
      subject: 'service',
      scopes: ['equipment:write'],
    });
    expect(((await deniedIssue.json()) as { error?: unknown }).error).toBeDefined();
    for (const method of ['api.keys.issue', 'api.keys.rotate', 'api.keys.revoke']) {
      const denied = await call(method, {}, 'workspace=A', 'bad');
      expect(denied.status).toBe(403);
    }
    await page.getByRole('button', { name: 'Change authority' }).click();
    await inspect(first);
    await inspect(second);
    await page.getByRole('button', { name: 'Change authority' }).click();
    const revokeButton = page
      .getByRole('listitem')
      .filter({ hasText: replacementId })
      .getByRole('button', { name: 'Revoke' });
    await revokeButton.click();
    await revokeButton.waitFor({ state: 'detached' });
    expect(await read(second)).toBe(401);
    const finalResponse = await call('api.keys.list', {});
    const finalList = await finalResponse.text();
    expect(finalList).not.toContain(first);
    expect(finalList).not.toContain(second);
    const beforeWrites = writes;
    const beforeReads = reads;
    const beforeRows = await page.getByRole('listitem').count();
    loseNext = true;
    await issue();
    await page
      .getByText('The outcome is uncertain. Check the refreshed list before trying again.')
      .waitFor();
    await page.getByRole('listitem').nth(beforeRows).waitFor();
    expect(writes).toBe(beforeWrites + 1);
    expect(reads).toBe(beforeReads + 1);
    await inspect(first);
    await inspect(second);
  } finally {
    await browser?.close();
    await server.stop(true);
  }
});
