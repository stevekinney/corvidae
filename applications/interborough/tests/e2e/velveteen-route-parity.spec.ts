import { expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readProductionGeneration } from '@lostgradient/velveteen/build/publication';
import { buildCheckoutApplication } from '../../scripts/build.ts';
import { NOT_FOUND_ROUTE_COPY } from '../../src/app/copy/views.ts';
import { routes, velveteenRouteId } from '../../src/app/routes.ts';
import { startHost, type Host } from '../../src/host/host.ts';
import {
  NATIVE_DOCUMENT_DIRECTORY,
  UNOWNED_DOCUMENT_ROUTE,
} from '../../src/host/native-document-path.ts';
import { createTextEchoAgents, TEXT_ECHO_AGENT_NAME } from './text-echo-agent.ts';

test.describe.configure({ mode: 'serial' });

let directory: string | undefined;
let host: Host | undefined;
let manifestIds: readonly string[];

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'interborough-route-parity-'));
  const buildDirectory = join(directory, 'build');
  const checkout = await buildCheckoutApplication({ outdir: buildDirectory });
  const generation = await readProductionGeneration(
    join(checkout.directory, NATIVE_DOCUMENT_DIRECTORY),
  );
  manifestIds = generation.manifest.routing.routes.map((route) => route.id);
  host = await startHost({
    environment: { INTERBOROUGH_HOME: join(directory, 'home') },
    buildDirectory,
    plugins: [],
    extraAgents: { agents: createTextEchoAgents() },
    port: 0,
  });
});

test.afterAll(async () => {
  try {
    await host?.close();
  } finally {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

test('mounts each current document pattern through the native manifest', async ({ page }) => {
  const origin = host!.url;
  expect([...manifestIds].toSorted()).toEqual(
    [...routes.map(({ pattern }) => velveteenRouteId(pattern)), UNOWNED_DOCUMENT_ROUTE].toSorted(),
  );

  for (const { pattern, view } of routes) {
    await test.step(`${pattern} resolves to ${velveteenRouteId(pattern)} and mounts its application view`, async () => {
      const pathname = pattern
        .replace(/:([^/]+)/g, (_, parameter: string) => encodeURIComponent(`parity-${parameter}`))
        .replace('*', 'guide/queue');
      const response = await page.goto(new URL(pathname, origin).href);
      expect(response?.status()).toBe(200);
      const outlet = page.locator('main.weft-shell-outlet');
      await expect(outlet).toBeVisible();
      await expect(outlet.locator('.weft-shell-outlet__skeleton')).toHaveCount(0);
      await expect(outlet.locator(`[data-view="${view}"]`).first()).toBeVisible();
      await expect(outlet.locator('[data-view="route"][data-state="error"]')).toHaveCount(0);
    });
  }
});

test('keeps native history, dirty navigation and transport ownership distinct', async ({
  page,
  request,
}) => {
  const origin = host!.url;
  const nativeReads: string[] = [];
  page.on('request', (entry) => {
    if (entry.headers()['accept']?.includes('application/x-velveteen-data'))
      nativeReads.push(new URL(entry.url()).pathname);
  });
  await page.goto(new URL('/settings/mcp', origin).href);
  await expect(page.getByRole('heading', { name: 'Endpoint address' })).toBeVisible();

  const initialLength = await page.evaluate(() => history.length);
  const readsBeforeClick = nativeReads.length;
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'General', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(initialLength + 1);
  expect(nativeReads.slice(readsBeforeClick)).toEqual(['/settings']);

  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Endpoint address' })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();

  await page.goto(new URL('/schedules/new', origin).href);
  const workflow = page.getByRole('combobox', { name: /^Workflow/ });
  await expect(workflow).not.toHaveAttribute('aria-busy', 'true');
  await workflow.click();
  await page.getByRole('option', { name: /Chat with an agent/ }).click();
  const cancel = page.getByRole('link', { name: 'Cancel', exact: true });
  await cancel.click();
  const dialog = page.getByRole('dialog', { name: 'Discard this schedule?' });
  await expect(dialog.getByRole('button', { name: 'Keep editing' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page).toHaveURL(/\/schedules\/new$/);
  await cancel.click();
  await dialog.getByRole('button', { name: 'Discard and leave' }).click();
  await expect(page).toHaveURL(/\/schedules$/);

  const missing = await page.goto(new URL('/missing-document-parity', origin).href);
  expect(missing?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: NOT_FOUND_ROUTE_COPY.title })).toBeVisible();
  const principal = await request.get(new URL('/api/v1/principal', origin).href, {
    headers: { accept: 'text/html' },
  });
  expect(principal.headers()['content-type']).toContain('application/json');
  for (const path of ['/assets/missing.js', '/_assets/missing.js', '/triggers/missing']) {
    const refused = await request.get(new URL(path, origin).href, {
      headers: { accept: 'text/html' },
    });
    expect(refused.status(), path).toBe(404);
    expect(refused.headers()['content-type'] ?? '', path).not.toContain('text/html');
  }
  const missingModule = await request.get(new URL('/_assets/missing.js', origin).href, {
    headers: { accept: 'application/javascript' },
  });
  expect(missingModule.status()).toBe(404);
  expect(await missingModule.text()).toBe('Not found');
});

test('keeps encoded identifiers distinct from static segments', async ({ page, request }) => {
  const origin = host!.url;
  const validAddresses = [
    ['/runs/_?__weft_workflow_id=..', '/runs/[run]'],
    ['/runs//second', '/runs/[run]'],
    ['/runs/%2F', '/runs/[run]'],
    ['/runs/%252F', '/runs/[run]'],
    ['/chats/%6eew', '/chats/[chat]'],
    ['/plugins/parity-plugin/page%2Finner/sub', '/plugins/[plugin]/[...path]'],
  ] as const;
  for (const [address, routeId] of validAddresses) {
    const url = new URL(address, origin).href;
    const data = await request.get(url, { headers: { accept: 'application/x-velveteen-data' } });
    expect(data.ok(), address).toBe(true);
    const initial = (await data.json()) as { type: string; value: string };
    expect(initial.type).toBe('initial');
    expect(initial.value).toContain(JSON.stringify(routeId));
    const document = await page.goto(url);
    expect(document?.status(), address).toBe(200);
    await expect(page).toHaveURL(url);
    await expect(page.locator('main.weft-shell-outlet')).toBeVisible();
  }
  for (const address of [
    '/runs/%E0',
    '/%72eviews',
    '/plugins/parity-plugin',
    '/plugins/parity-plugin/',
  ]) {
    const document = await page.goto(new URL(address, origin).href);
    expect(document?.status(), address).toBe(404);
  }
});

test('leaves a modified Diagnostics link to the browser and navigates a plain click once', async ({
  page,
}) => {
  const origin = host!.url;
  const alerts = new URL('/health?advanced=alerts', origin).href;
  const diagnostics = new URL('/health/workers?tab=diagnostics', origin).href;
  await page.goto(alerts);
  const link = page.getByRole('link', { name: 'Open Diagnostics' });
  await expect(link).toHaveAttribute('href', '/health/workers?tab=diagnostics');

  const [modified] = await Promise.all([
    page.context().waitForEvent('page'),
    link.click({ modifiers: ['ControlOrMeta'] }),
  ]);
  await expect(modified).toHaveURL(diagnostics);
  await expect(page).toHaveURL(alerts);
  await modified.close();

  const dataRequests: string[] = [];
  page.on('request', (entry) => {
    if (entry.headers()['accept']?.includes('application/x-velveteen-data'))
      dataRequests.push(entry.url());
  });
  await link.click();
  await expect(page).toHaveURL(diagnostics);
  expect(dataRequests).toEqual([diagnostics]);
});

test('leaves modified, downloaded, external and consumed links with their existing owner', async ({
  page,
}) => {
  const origin = host!.url;
  const startingAddress = new URL('/settings/mcp', origin).href;
  const generalAddress = new URL('/settings', origin).href;
  await page.goto(startingAddress);
  await expect(page.getByRole('heading', { name: 'Endpoint address' })).toBeVisible();

  const dataRequests: string[] = [];
  page.on('request', (entry) => {
    if (entry.headers()['accept']?.includes('application/x-velveteen-data'))
      dataRequests.push(entry.url());
  });
  const general = page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'General', exact: true });
  const [modified] = await Promise.all([
    page.context().waitForEvent('page'),
    general.click({ modifiers: ['ControlOrMeta'] }),
  ]);
  await expect(modified).toHaveURL(generalAddress);
  await modified.close();
  const [middle] = await Promise.all([
    page.context().waitForEvent('page'),
    general.click({ button: 'middle' }),
  ]);
  await expect(middle).toHaveURL(generalAddress);
  await middle.close();

  await page.evaluate(() => {
    const harness = document.createElement('section');
    document.querySelector('main')!.prepend(harness);
    for (const [label, href] of [
      ['Explicit new window', '/settings'],
      ['Download document', '/settings'],
      ['Already consumed', '/settings'],
      ['Jump to fragment', '#parity-fragment'],
    ]) {
      const anchor = document.createElement('a');
      anchor.href = href!;
      anchor.textContent = label!;
      if (label === 'Explicit new window') anchor.target = '_blank';
      if (label === 'Download document') anchor.download = 'settings.html';
      if (label === 'Already consumed')
        anchor.addEventListener('click', (event) => event.preventDefault());
      harness.append(anchor, document.createElement('br'));
    }
    const target = document.createElement('div');
    target.id = 'parity-fragment';
    target.textContent = 'Fragment target';
    harness.append(target);
  });
  const [windowPage] = await Promise.all([
    page.context().waitForEvent('page'),
    page.getByRole('link', { name: 'Explicit new window' }).click(),
  ]);
  await expect(windowPage).toHaveURL(generalAddress);
  await windowPage.close();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download document' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('settings.html');
  await page.getByRole('link', { name: 'Already consumed' }).click();
  await expect(page).toHaveURL(startingAddress);
  expect(dataRequests).toEqual([]);

  await page.getByRole('link', { name: 'Jump to fragment' }).click();
  await expect(page).toHaveURL(startingAddress + '#parity-fragment');
  await expect(page.getByText('Fragment target', { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(startingAddress);

  const external = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      new Response('<h1>External route</h1>', { headers: { 'content-type': 'text/html' } }),
  });
  try {
    await page.evaluate((href) => {
      const link = document.createElement('a');
      link.href = href;
      link.textContent = 'External destination';
      document.querySelector('main')!.prepend(link);
    }, external.url.href);
    await page.getByRole('link', { name: 'External destination' }).click();
    await expect(page).toHaveURL(external.url.href);
    await expect(page.getByRole('heading', { name: 'External route' })).toBeVisible();
  } finally {
    await external.stop();
  }
});

test('retains the actual agent view when selecting a tab', async ({ page }) => {
  const agentAddress = new URL(`/agents/${TEXT_ECHO_AGENT_NAME}`, host!.url).href;
  await page.goto(agentAddress);
  const header = page.getByTestId('agent-header');
  await expect(header).toContainText(TEXT_ECHO_AGENT_NAME);
  const previousHeader = await header.elementHandle();
  if (previousHeader === null) throw new Error('Agent view did not mount');
  const originalEntries = await page.evaluate(() => history.length);

  const access = page.getByRole('tab', { name: /^Access(?: |$)/ });
  await access.click();
  await expect(page).toHaveURL(agentAddress + '/access');
  await expect(access).toHaveAttribute('aria-selected', 'true');
  expect(
    await header.evaluate((current, previous) => current.isSameNode(previous), previousHeader),
  ).toBe(true);
  expect(await page.evaluate(() => history.length)).toBe(originalEntries + 1);

  await page.goBack();
  await expect(page).toHaveURL(agentAddress);
  await expect(page.getByRole('tab', { name: /^Chats/ })).toHaveAttribute('aria-selected', 'true');

  await page.goto(agentAddress + '?tab=access');
  await expect(page).toHaveURL(agentAddress + '/access');
  await expect(access).toHaveAttribute('aria-selected', 'true');
});

test('recovers a missing view chunk once on the native document address', async ({ page }) => {
  const origin = host!.url;
  const startingAddress = new URL('/settings/mcp', origin).href;
  const generalAddress = new URL('/settings', origin).href;
  const control = await page.context().newPage();
  const viewChunks = new Set<string>();
  await control.goto(startingAddress);
  await expect(control.getByRole('heading', { name: 'Endpoint address' })).toBeVisible();
  control.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/_assets/chunks/')) {
      viewChunks.add(request.url());
    }
  });
  await control
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'General', exact: true })
    .click();
  await expect(control.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
  await control.close();
  expect(viewChunks.size).toBeGreaterThan(0);

  await page.goto(startingAddress);
  await expect(page.getByRole('heading', { name: 'Endpoint address' })).toBeVisible();
  const failedChunks: string[] = [];
  await page.route(
    (url) => viewChunks.has(url.href),
    async (route) => {
      failedChunks.push(route.request().url());
      await route.fulfill({ status: 404 });
    },
  );
  const documentRequests: string[] = [];
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      documentRequests.push(request.url());
    }
  });

  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'General', exact: true })
    .click();
  await expect(page).toHaveURL(generalAddress);
  await expect(page.locator('[data-view="route"][data-state="error"]')).toBeVisible();
  expect(failedChunks.length).toBeGreaterThan(0);
  expect(documentRequests).toEqual([generalAddress]);
});
