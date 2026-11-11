/**
 * Connect a tool source from Capabilities › Sources (COR-1991), on a host that really restarts
 * (`E2E_CONNECT_PORT`, `connect-host.ts`: the production entry under the real supervisor, with an
 * empty home). A failed test says why in words that hold no token and no address; an MCP server with
 * a bearer token, an OpenAPI service from a URL and an MCP server behind OAuth are connected from
 * the dialog; the tools of a source added to a live host are in Capabilities at once, with no
 * restart (COR-2009); the OAuth sign-in completes against a mock authorization server; and after the
 * host restarts the page lists the tools of every source it loaded at boot.
 *
 * The cases run in file order and each builds on the host the one before left: the first four leave
 * it empty, then three sources are saved and signed in to, and the host is restarted into. Nothing
 * else opens this host. The OAuth sign-in of a seeded source on the main host is `connect-tools.spec.ts`.
 */
import type { APIRequestContext, Page } from '@playwright/test';

import { CAPABILITIES_COPY } from '../../src/app/copy.ts';
import type { ConnectOrigins } from './connect-host.ts';
import { E2E_BARRIER_URL, E2E_CONNECT_TOKEN, E2E_CONNECT_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

test.use({ baseURL: E2E_CONNECT_URL });
test.describe.configure({ mode: 'serial' });

const copy = CAPABILITIES_COPY.source;
const SOURCES = '/capabilities?tab=sources';

const escapeForPattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const dialog = (page: Page) => page.getByTestId('connect-form');
/** Connect, in the dialog's footer; its name is exact because the page's own button is Connect a source. */
const saveButton = (page: Page) =>
  page.getByRole('dialog').getByRole('button', { name: copy.connect.actions.connect, exact: true });
const detail = (page: Page) => page.getByTestId('source-detail');

async function originsOf(request: APIRequestContext): Promise<ConnectOrigins> {
  const response = await request.get(`${E2E_BARRIER_URL}/connect/origins`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as ConnectOrigins;
}

/** The sources the host reports, as the specification reads them. */
async function snapshotOf(request: APIRequestContext) {
  const response = await request.get('/host/tool-sources');
  expect(response.ok()).toBe(true);
  return (await response.json()) as {
    sources: { id: string; state: string; authorized?: boolean }[];
  };
}

async function openDialog(page: Page): Promise<void> {
  await page.goto(SOURCES);
  await page.getByRole('button', { name: copy.connect.action }).first().click();
  await expect(dialog(page)).toBeVisible();
}

/** Fills the dialog for an MCP server reached by URL. */
async function fillMcp(page: Page, id: string, url: string): Promise<void> {
  await dialog(page).getByLabel(copy.connect.id.label).fill(id);
  await dialog(page).getByLabel(copy.connect.url.label).fill(url);
}

async function bearer(page: Page, token: string): Promise<void> {
  await dialog(page).getByRole('radio', { name: copy.connect.authentication.bearer }).check();
  // The radio has the same name as the field, so the field is found by what it is.
  await dialog(page).locator('#connect-secret').fill(token);
}

test('starts empty, and offers to connect a source', async ({ page, checkA11y }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(SOURCES);

  await expect(page.getByText(copy.empty.title)).toBeVisible();
  // The header's "+" and the empty state's primary button both connect tools (rows 31z, 32a).
  await expect(page.getByRole('button', { name: copy.connect.action })).toHaveCount(2);
  await checkA11y('the empty Sources tab');
});

for (const width of [375, 1280] as const) {
  test(`opens the dialog and keeps it inside the screen, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await openDialog(page);
    // The longest form: an OpenAPI service with a key.
    await dialog(page).getByRole('radio', { name: copy.connect.kind.openapi }).check();
    await dialog(page).getByLabel(copy.connect.id.label).fill('a'.repeat(20));
    await dialog(page).getByRole('radio', { name: copy.connect.authentication['api-key'] }).check();
    await dialog(page).locator('#connect-secret').fill('k'.repeat(300));

    const overflow = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth - window.innerWidth,
      form: (() => {
        const form = document.querySelector('[data-testid="connect-form"]');
        return form === null ? 0 : form.scrollWidth - form.clientWidth;
      })(),
    }));
    expect(overflow.document).toBeLessThanOrEqual(0);
    expect(overflow.form).toBeLessThanOrEqual(0);
    await checkA11y(`the connect dialog at ${width}px`);
  });
}

test('says why a test failed, with no token and no address in the words', async ({
  page,
  request,
}) => {
  const origins = await originsOf(request);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openDialog(page);

  // An address nothing listens on.
  const nothing = 'http://127.0.0.1:9/';
  await fillMcp(page, 'notes', nothing);
  await bearer(page, 'a-token-that-must-never-be-printed');
  await page.getByRole('button', { name: copy.connect.probe.action }).click();
  await expect(page.getByTestId('connect-probe-failed')).toBeVisible();
  const reason = page.getByTestId('connect-probe-reason');
  await expect(reason).not.toBeEmpty();
  await expect(reason).not.toContainText('127.0.0.1');

  // A server that is there and refuses the token.
  await dialog(page).getByLabel(copy.connect.url.label).fill(`${origins.bearerMcp}/`);
  await expect(page.getByTestId('connect-probe-failed')).toHaveCount(0);
  await page.getByRole('button', { name: copy.connect.probe.action }).click();
  await expect(page.getByTestId('connect-probe-failed')).toBeVisible();
  await expect(reason).not.toContainText(origins.bearerMcp);
  await expect(reason).not.toContainText('a-token-that-must-never-be-printed');
  expect(await page.content()).not.toContain('>a-token-that-must-never-be-printed<');
});

test('tests a server with its token, and lists the tools it offers before anything is saved', async ({
  page,
  request,
}) => {
  const origins = await originsOf(request);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openDialog(page);
  await fillMcp(page, 'notes', `${origins.bearerMcp}/`);
  await bearer(page, E2E_CONNECT_TOKEN);

  await page.getByRole('button', { name: copy.connect.probe.action }).click();

  await expect(page.getByTestId('connect-listed')).toHaveText(copy.connect.probe.listed(2));
  await expect(page.locator('[data-probe-tool="notes__lookup"]')).toContainText('Reads only');
  await expect(page.locator('[data-probe-tool="notes__wipe"]')).toContainText('Dangerous');
  // Nothing was saved.
  const saved = await snapshotOf(request);
  expect(saved).toMatchObject({ sources: [] });
});

test('connects an MCP server and an OpenAPI service, whose tools are listed at once', async ({
  page,
  request,
}) => {
  const origins = await originsOf(request);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openDialog(page);
  await fillMcp(page, 'notes', `${origins.bearerMcp}/`);
  await bearer(page, E2E_CONNECT_TOKEN);
  await saveButton(page).click();

  // A source added to a live host is loaded at once (COR-2009): it is Connected, not waiting.
  await expect(detail(page)).toHaveAttribute('data-source', 'notes');
  await expect(detail(page)).toHaveAttribute('data-state', 'loaded');
  expect(await page.content()).not.toContain(E2E_CONNECT_TOKEN);

  await page.getByRole('button', { name: copy.connect.action }).click();
  await dialog(page).getByRole('radio', { name: copy.connect.kind.openapi }).check();
  await dialog(page).getByLabel(copy.connect.id.label).fill('pets');
  await dialog(page)
    .getByLabel(copy.connect.specificationUrl.label)
    .fill(`${origins.pets}/openapi.json`);
  await dialog(page).getByLabel(copy.connect.baseUrl.label).fill(origins.pets);
  await page.getByRole('button', { name: copy.connect.probe.action }).click();
  await expect(page.getByTestId('connect-listed')).toHaveText(copy.connect.probe.listed(3));
  await saveButton(page).click();

  await expect(detail(page)).toHaveAttribute('data-source', 'pets');
  await expect(detail(page)).toHaveAttribute('data-state', 'loaded');
  // Nothing is saved and not running, so there is nothing to restart for.
  await expect(page.getByTestId('sources-restart')).toHaveCount(0);
  // The running host has loaded them: Capabilities lists their tools now.
  await page.goto('/capabilities');
  await expect(page.locator('[data-view="capabilities"]')).toHaveAttribute('data-state', 'ready');
  for (const name of ['notes__lookup', 'notes__wipe', 'pets__list-pets', 'pets__create-pet']) {
    await expect(page.locator(`[data-tool-row="${name}"]`)).toHaveCount(1);
  }
  const stored = await snapshotOf(request);
  expect(JSON.stringify(stored)).not.toContain(E2E_CONNECT_TOKEN);
});

test('connects an MCP server behind OAuth, and signing in completes', async ({ page, request }) => {
  const origins = await originsOf(request);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openDialog(page);
  await fillMcp(page, 'ledger', `${origins.oauthMcp}/`);
  await dialog(page).getByRole('radio', { name: copy.connect.authentication.oauth }).check();
  await page.getByRole('button', { name: copy.connect.probe.action }).click();
  await expect(page.getByTestId('connect-needs-authorization')).toBeVisible();
  await saveButton(page).click();

  await expect(detail(page)).toHaveAttribute('data-source', 'ledger');
  // It is saved and waits for the sign-in that lets it list its tools.
  await expect(detail(page)).toHaveAttribute('data-state', 'needs-authorization');
  await expect(page.getByTestId('source-state-description')).toHaveText(
    copy.stateDescriptions['needs-authorization'],
  );
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: copy.signIn.action }).click();
  const signIn = await popup;
  // The mock authorization server approves at once and sends the browser back to the host.
  await signIn.waitForURL(/\/host\/oauth\/callback\//);
  await expect(signIn.getByText(/^Signed in\./)).toBeVisible();
  expect(await signIn.content()).not.toMatch(/access-|refresh-/);
  await signIn.close();

  // The first sign-in completing loads the source at once (COR-2009): its tools are listed.
  await page.reload();
  await expect(detail(page)).toHaveAttribute('data-state', 'loaded');
  await expect(page.getByTestId('source-state-description')).toHaveText(
    copy.stateDescriptions.loaded,
  );
  expect(await page.content()).not.toMatch(/access-|refresh-/);
  const after = await snapshotOf(request);
  expect(after.sources.find((source) => source.id === 'ledger')).toMatchObject({
    authorized: true,
    state: 'loaded',
  });
});

/** How many times this host has started: its `host.started` events, the audit log's "Server started". */
async function hostStartsOf(request: APIRequestContext): Promise<number> {
  const response = await request.post('/bureau/jsonrpc', {
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'bureau.audit.query',
      params: { types: ['host.started'], includeTotal: true, limit: 1 },
    },
  });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { result: { total: number } };
  return body.result.total;
}

test('restarts the host, and the tools of every source it loaded are in Capabilities', async ({
  page,
  request,
  pageErrors,
}) => {
  // While the host is stopped, every request the open page makes to it dies: the health probe, the
  // event streams and the reads. How many depends on how long the supervisor takes.
  const connection =
    '(CONNECTION_REFUSED|CONNECTION_RESET|EMPTY_RESPONSE|INCOMPLETE_CHUNKED_ENCODING)';
  pageErrors.expectEvery({
    pattern: new RegExp(
      `^request failed: .* ${escapeForPattern(E2E_CONNECT_URL)}/.* \\(net::ERR_${connection}\\)$`,
    ),
    reason:
      'the host is stopped between the restart it was asked for and the supervisor starting it again',
  });
  pageErrors.expectEvery({
    pattern: new RegExp(`^console error: Failed to load resource: net::ERR_${connection}`),
    reason: 'Chromium logs each request that died while the host was stopped',
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(SOURCES);
  // The three sources are running, so nothing is saved and waiting, and the page offers no restart.
  await expect(page.getByTestId('sources-restart')).toHaveCount(0);

  // Ask the host to restart, as the page's restart does (`POST /host/restart`, answered 202 before
  // it stops). The supervisor starts it again, which the audit log records as one more start.
  const starts = await hostStartsOf(request);
  const asked = await request.post('/host/restart');
  expect(asked.status()).toBe(202);
  await expect
    .poll(
      async () => {
        // While the host is stopped no request is answered: that is the restart under way.
        try {
          return await hostStartsOf(request);
        } catch {
          return starts;
        }
      },
      { message: 'the supervisor starts the host again, and it records its start' },
    )
    .toBe(starts + 1);

  await page.goto(SOURCES);
  for (const [id, state] of [
    ['notes', 'loaded'],
    ['pets', 'loaded'],
    ['ledger', 'loaded'],
  ] as const) {
    await expect(page.locator(`[data-source-row="${id}"]`)).toHaveAttribute('data-state', state);
  }

  await page.goto('/capabilities');
  for (const name of ['notes__lookup', 'notes__wipe', 'pets__list-pets', 'pets__create-pet']) {
    await expect(page.locator(`[data-tool-row="${name}"]`)).toHaveCount(1);
  }
  await expect(page.locator('[data-tool-row^="ledger__"]').first()).toBeVisible();
  const snapshot = await snapshotOf(request);
  expect(snapshot.sources.map((source) => [source.id, source.state])).toEqual([
    ['notes', 'loaded'],
    ['pets', 'loaded'],
    ['ledger', 'loaded'],
  ]);
});
