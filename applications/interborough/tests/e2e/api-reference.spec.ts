/**
 * Settings › API reference (board PageSettingsSections, "API reference · /settings/api-reference",
 * "API reference · Discovery documents", "Your scopes", "Workflow sources" and "API reference loading
 * and failing to load"): one tabs row of four tabs, each filled from what the running server answers.
 * The seeded host serves Interborough's own API description at `/api/openapi.json` and says the one
 * local session holds every scope; the showcase host holds the sample world's workflow files. A failed read must be an error in
 * its tab, never an empty one.
 *
 * Each captioned state is captured for the design review (`design-review-capture.ts`) at the three
 * widths Settings is drawn at.
 */
import type { Page } from '@playwright/test';

import { API_REFERENCE_COPY } from '../../src/app/copy.ts';
import { API_SCOPE_CATALOG } from '../../src/lib/api-scopes.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';

const SOURCE = 'api-reference.spec.ts';
const ROUTE = '/settings/api-reference';
const TABS = ['Operations', 'Discovery documents', 'Your scopes', 'Workflow sources'] as const;

async function captureAtEveryWidth(page: Page, state: string, tab?: string) {
  for (const width of [1280, 768, 375] as const) {
    await page.setViewportSize({ width, height: 900 });
    await captureForDesignReview(page, {
      route: ROUTE,
      state,
      source: SOURCE,
      ...(tab === undefined ? {} : { tab }),
    });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

test('one tabs row holds the four tabs, and the page has no key management', async ({
  page,
  checkA11y,
}) => {
  await page.goto(ROUTE);

  await expect(page.getByRole('heading', { level: 1, name: 'API reference' })).toBeVisible();
  await expect(page.getByText(API_REFERENCE_COPY.intro)).toBeVisible();
  const tabs = page.getByRole('tablist', { name: 'API reference' });
  await expect(tabs.getByRole('tab')).toHaveText([...TABS]);
  await expect(tabs.getByRole('tab', { name: 'Operations' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('navigation', { name: 'API reference groups' })).toHaveCount(0);
  await expect(page.getByText(/API key/i)).toHaveCount(0);
  await checkA11y('settings api reference');
  await captureAtEveryWidth(page, 'operations', 'Operations');
});

test('Operations lists the seven operations of Interborough’s API with their scope, a group select and a count, and POST /api/runs opens to its request and response', async ({
  page,
}) => {
  await page.goto(`${ROUTE}?group=operations`);

  const table = page.getByRole('table', { name: 'Operations' });
  await expect(table).toBeVisible();
  await expect(table.getByRole('columnheader')).toHaveText([
    'Method',
    'Path',
    'What it does',
    'Scope',
    'Details',
  ]);
  const count = page.getByTestId('api-operations-count');
  await expect(count).toHaveText('7 operations');
  const rows = table.locator('tbody tr[data-operation]');
  const cells = async (index: number) => {
    const texts = await rows.nth(index).locator('td').allTextContents();
    return texts.slice(0, 4).map((text) => text.trim());
  };
  const expected = [
    ['GET', '/api/runs', 'List runs', 'runs:read'],
    ['POST', '/api/runs', 'Start a run', 'runs:write'],
    ['GET', '/api/runs/{run}', 'Get one run and its steps', 'runs:read'],
    ['POST', '/api/chats/{chat}/messages', 'Send a message to a chat', 'chats:write'],
    ['GET', '/api/agents', 'List agents', 'agents:read'],
    ['GET', '/api/schedules', 'List schedules', 'schedules:read'],
    ['POST', '/api/reviews/{review}/decision', 'Approve or deny a review', 'reviews:write'],
  ];
  await expect(rows).toHaveCount(expected.length);
  for (const [index, row] of expected.entries()) expect(await cells(index)).toEqual(row);
  // The method is coloured monospaced text, and the chevron that opens a row is at its right.
  await expect(rows.first().locator('td').first().locator('code[data-method="GET"]')).toBeVisible();
  await expect(
    rows
      .first()
      .locator('td')
      .last()
      .getByRole('button', { name: /^Request and response for/ }),
  ).toBeVisible();

  // The whole row, chevron included, is in view at every width Settings is drawn at: the table
  // wraps its cells instead of scrolling sideways, and the page never scrolls sideways.
  for (const width of [1280, 768, 375] as const) {
    await page.setViewportSize({ width, height: 900 });
    const panelBox = await page.getByTestId('api-operations').boundingBox();
    const tableBox = await table.boundingBox();
    expect((tableBox?.x ?? 0) + (tableBox?.width ?? 0)).toBeLessThanOrEqual(
      (panelBox?.x ?? 0) + (panelBox?.width ?? 0) + 0.5,
    );
    await expect(rows.first().locator('td').last().getByRole('button')).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  // A group narrows the table and the count.
  const group = page.getByRole('combobox', { name: 'Group' });
  await expect(group).toContainText('All groups');
  await group.selectOption({ label: 'Runs' });
  await expect(count).toHaveText('3 operations');
  await group.selectOption({ label: 'All groups' });
  await expect(count).toHaveText('7 operations');

  // POST /api/runs opens to the board's request body and its 201 response.
  const toggle = table.getByRole('button', { name: 'Request and response for POST /api/runs' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const request = page.getByRole('region', { name: 'Request body' });
  await expect(request).toContainText('{ "workflow": "order-refund", "input": { "order": 4471 } }');
  const response = page.getByRole('region', { name: 'Response, 201' });
  await expect(response).toContainText('{ "run": "run-1-9f3a", "status": "running" }');
  await captureAtEveryWidth(page, 'operation-open', 'Operations');
});

test('Discovery documents lists the three documents, each with its address and a Copy button named for it', async ({
  page,
}) => {
  await page.goto(ROUTE);
  await page.getByRole('tab', { name: 'Discovery documents' }).click();
  await expect(page).toHaveURL(/group=discovery/);

  const panel = page.getByTestId('api-discovery');
  for (const [title, description] of [
    ['OpenAPI description', 'Every operation, for generating a client.'],
    ['Agent card', 'How other agents discover yours (A2A).'],
    ['Tool server', 'The same tools, over MCP.'],
  ] as const) {
    await expect(panel).toContainText(title);
    await expect(panel).toContainText(description);
    await expect(panel.getByRole('button', { name: `Copy ${title}` })).toBeVisible();
  }
  await expect(panel.locator('[data-document="openapi"] code')).toHaveText(/\/api\/openapi\.json$/);
  await expect(panel.locator('[data-document="agent-card"] code')).toHaveText(/agent-card\.json$/);
  await expect(panel.locator('[data-document="tools"] code')).toHaveText(/\/mcp$/);
  await captureAtEveryWidth(page, 'discovery-documents', 'Discovery documents');
});

test('Your scopes opens with the single-user sentence and lists the ten scopes this session holds, with what each lets it do', async ({
  page,
}) => {
  await page.goto(`${ROUTE}?group=scopes`);

  const panel = page.getByTestId('api-scopes');
  await expect(panel.locator('p').first()).toHaveText(API_REFERENCE_COPY.scopes.intro);
  const rows = panel.locator('li');
  await expect(rows).toHaveCount(API_SCOPE_CATALOG.length);
  for (const [index, entry] of API_SCOPE_CATALOG.entries()) {
    await expect(rows.nth(index).locator('code')).toHaveText(entry.scope);
    await expect(rows.nth(index)).toContainText(entry.description);
  }
  await captureAtEveryWidth(page, 'your-scopes', 'Your scopes');
});

test('Workflow sources lists the workflow files read-only, with no Open file', async ({ page }) => {
  await page.goto(`${E2E_SHOWCASE_URL}${ROUTE}?group=sources`);

  const panel = page.getByTestId('api-sources');
  await expect(panel).toContainText(API_REFERENCE_COPY.sources.intro);
  await expect(panel.locator('[data-workflow-file="order-refund"]')).toContainText(
    'workflows/order-refund.json',
  );
  await expect(panel.locator('[data-workflow-file="order-refund"]')).toContainText(
    '1 workflow · Order refund',
  );
  await expect(panel.locator('[data-workflow-file="release-notes"]')).toContainText(
    '1 workflow · Release notes, 1 schedule',
  );
  await expect(panel.locator('[data-workflow-file="triage-inbox"]')).toContainText(
    '1 workflow · Triage inbox',
  );
  await expect(panel.getByRole('button', { name: /open file/i })).toHaveCount(0);
  await captureAtEveryWidth(page, 'workflow-sources', 'Workflow sources');
});

test('loading shows skeleton rows with the tab row live, then a status line with Cancel, and a failure says so with Try again', async ({
  page,
  pageErrors,
}) => {
  pageErrors.expect({
    pattern: loggedFailedResponse(500, /api\/openapi\.json/),
    reason: 'The test answers the OpenAPI description with an error to draw the failed state.',
  });
  await page.clock.install();
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/openapi.json', async (route) => {
    await held;
    return route.fulfill({ status: 500, body: 'nope' });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${E2E_SHOWCASE_URL}${ROUTE}`);

  // The tab row and the heading are real while the rows are placeholders.
  await expect(page.getByRole('heading', { level: 1, name: 'API reference' })).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'API reference' })).toBeVisible();
  await page.clock.runFor(400);
  await expect(page.locator('.cinder-skeleton-group')).toBeVisible();
  await captureAtEveryWidth(page, 'loading');
  await page.clock.runFor(10_000);
  await expect(page.getByText(API_REFERENCE_COPY.loading.stillLoading)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await captureAtEveryWidth(page, 'still-loading');

  release?.();
  const failed = page.getByTestId('api-reference-load-failed');
  await expect(failed).toContainText('Couldn’t load the API reference.');
  await expect(failed).toContainText('The server answered with an error (500).');
  await expect(failed.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'API reference' })).toBeVisible();
  await captureAtEveryWidth(page, 'load-failed');

  // Another tab reads for itself, so this one failing does not empty it.
  await page.getByRole('tab', { name: 'Discovery documents' }).click();
  await expect(page.getByTestId('api-discovery')).toBeVisible();
});
