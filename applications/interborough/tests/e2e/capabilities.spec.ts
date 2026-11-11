/**
 * `/capabilities` against the real host (COR-1840): every tool of the catalog and every executable
 * skill the host discovered is listed (a tool as two lines, with its risk word and its source),
 * the tabs carry their counts, the open item is in the
 * address, a skill from a source the host does not trust is marked, and G P opens the page.
 * The host starts with three skills in two configured sources (`skills-support.ts`): two from a
 * trusted source, one of them with a long name and description, and one from a source it does not
 * trust.
 */
import type { Page } from '@playwright/test';

import { CAPABILITIES_COPY } from '../../src/app/copy.ts';
import { readCatalog } from './agent-support.ts';
import { expect, test } from './fixtures.ts';
import { E2E_SKILLS, skillAddressKey } from './skills-support.ts';

const WIDTHS = [375, 1280] as const;
const copy = CAPABILITIES_COPY;

const area = (page: Page) => page.locator('[data-view="capabilities"]');
const toolRows = (page: Page) => page.locator('[data-tool-row]');
const skillRows = (page: Page) => page.locator('[data-skill-row]');

test.describe('the Tools tab', () => {
  test('lists every tool of the catalog as two lines, and counts them in the tab', async ({
    page,
    request,
  }) => {
    const { tools } = await readCatalog(request);
    expect(tools.length).toBeGreaterThan(0);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/capabilities');
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    await expect(toolRows(page)).toHaveCount(tools.length);
    for (const tool of tools) {
      const row = page.locator(`[data-tool-row="${tool.name}"]`);
      await expect(row).toHaveCount(1);
      // Line one: the name for a person and the muted risk word. Line two: the source, then the sentence.
      await expect(row.getByTestId('tool-row-name')).not.toBeEmpty();
      await expect(row.getByTestId('tool-row-risk')).toHaveText(
        /^(Reads|Changes things|Dangerous|Not classified)$/,
      );
      await expect(row.getByTestId('tool-row-source')).not.toBeEmpty();
      await expect(row.getByTestId('tool-row-summary')).not.toBeEmpty();
    }
    // The count is in the tab, not in the list; the list shows one only while something is typed.
    await expect(page.getByTestId('tab-count-tools')).toHaveText(String(tools.length));
    await expect(page.getByTestId('tools-count')).toHaveCount(0);
  });

  for (const width of WIDTHS) {
    test(`opens a tool with its tier, approval, source, inputs and users, at ${width} pixels`, async ({
      page,
      request,
      checkA11y,
    }) => {
      const { tools } = await readCatalog(request);
      const tool = tools[0]!;
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/capabilities');
      await page.locator(`[data-tool-row="${tool.name}"]`).click();
      const detail = page.getByTestId('tool-detail');
      await expect(detail).toHaveAttribute('data-tool', tool.name);
      await expect(detail.getByTestId('tool-risk')).toHaveText(
        /Reads|Changes things|Dangerous|Not classified/,
      );
      await expect(detail.getByTestId('tool-approval')).toHaveText(
        /Asks: (Never|On changes|Always)/,
      );
      // The chip's text is its label alone; the space around it is the chip's markup, not a word.
      await expect(detail.getByTestId('tool-source')).toHaveText(/^\s*(Built in|From \S.*?)\s*$/);
      await expect(detail.getByTestId('tool-input-schema')).toBeVisible();
      await expect(detail.getByTestId('capability-users')).toBeVisible();
      // The open tool is in the address, so the page can be linked.
      await expect(page).toHaveURL(new RegExp(`tool=${encodeURIComponent(tool.name)}`));
      // No word stands in for an empty list.
      await expect(detail).not.toContainText(/\bNone\b/);
      await checkA11y(`the Tools tab with ${tool.name} open at ${width}px`);
    });
  }

  test('filters by name and says so when nothing matches', async ({ page, request }) => {
    const { tools } = await readCatalog(request);
    const total = tools.length;
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/capabilities');
    await expect(toolRows(page)).toHaveCount(total);
    await page.getByRole('searchbox', { name: copy.filterLabel.tools }).fill('zzz-no-such-tool');
    await expect(page.getByText(copy.tool.filtered.title)).toBeVisible();
    // The field keeps its text and the count reads at its right; the tab keeps its count.
    await expect(page.getByTestId('tools-count')).toHaveText(`0 of ${String(total)} tools`);
    await expect(page.getByTestId('tab-count-tools')).toHaveText(String(total));
    await page.getByRole('button', { name: copy.tool.filtered.clear }).click();
    await expect(toolRows(page)).toHaveCount(total);
  });
});

test.describe('the Skills tab', () => {
  for (const width of WIDTHS) {
    test(`lists the discovered skills and marks the untrusted one, at ${width} pixels`, async ({
      page,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/capabilities?tab=skills');
      await expect(area(page)).toHaveAttribute('data-state', 'ready');
      await expect(skillRows(page)).toHaveCount(Object.keys(E2E_SKILLS).length);
      await expect(page.getByTestId('tab-count-skills')).toHaveText(
        String(Object.keys(E2E_SKILLS).length),
      );
      const untrusted = page.locator(`[data-skill-row="${E2E_SKILLS.deploy.name}"]`);
      await expect(untrusted).toHaveAttribute('data-trust', 'untrusted');
      await expect(untrusted).toContainText(copy.skill.untrustedBadge);
      const trusted = page.locator(`[data-skill-row="${E2E_SKILLS.summarize.name}"]`);
      await expect(trusted).toHaveAttribute('data-trust', 'trusted');
      await expect(trusted).not.toContainText(copy.skill.untrustedBadge);
      await checkA11y(`the Skills tab at ${width}px`);
    });
  }

  test('opens an untrusted skill with why agents are refused it, and a trusted one with its tools', async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/capabilities?tab=skills');
    await page.locator(`[data-skill-row="${E2E_SKILLS.deploy.name}"]`).click();
    const detail = page.getByTestId('skill-detail');
    await expect(detail).toHaveAttribute('data-skill', E2E_SKILLS.deploy.name);
    // The identifier sits beside the name for a person, and the muted line says what the skill holds.
    await expect(detail.getByTestId('skill-identifier')).toHaveText(E2E_SKILLS.deploy.name);
    await expect(detail.getByTestId('skill-meta')).toContainText(copy.skill.meta.instructionsOnly);
    await expect(detail.getByTestId('skill-meta')).toContainText(
      copy.skill.meta.loadedWhenRelevant,
    );
    await expect(detail).toHaveAttribute('data-trust', 'untrusted');
    await expect(detail.getByTestId('skill-trust')).toContainText('Not trusted');
    await expect(detail.getByTestId('skill-unavailable')).toContainText(
      copy.skill.unavailable['source-untrusted'],
    );
    await expect(detail.getByTestId('skill-allowed-tools')).toContainText('run_shell');
    await expect(page).toHaveURL(
      new RegExp(`skill=${encodeURIComponent(skillAddressKey(E2E_SKILLS.deploy))}`),
    );
    await checkA11y('an untrusted skill open');

    await page.locator(`[data-skill-row="${E2E_SKILLS.long.name}"]`).click();
    await expect(page.getByTestId('skill-detail')).toHaveAttribute(
      'data-skill',
      E2E_SKILLS.long.name,
    );
    await expect(page.getByTestId('skill-detail').getByTestId('skill-unavailable')).toHaveCount(0);
    await expect(page.getByTestId('skill-allowed-tools')).toContainText('grep');
  });

  test('opens the skill the address names, and Back from the Skills tab returns to Tools', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(
      `/capabilities?tab=skills&skill=${encodeURIComponent(skillAddressKey(E2E_SKILLS.summarize))}`,
    );
    await expect(page.getByTestId('skill-detail')).toHaveAttribute(
      'data-skill',
      E2E_SKILLS.summarize.name,
    );
    await page.getByRole('tab', { name: copy.tabs.tools }).click();
    await expect(page.getByTestId('tools-panel')).toBeVisible();
    await expect(page).toHaveURL(/\/capabilities$/);
  });
});

test('G P opens the page, and the sidebar marks it current', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/agents');
  await expect(page.getByRole('navigation', { name: 'Views' })).toBeVisible();
  await page.keyboard.press('g');
  await page.keyboard.press('p');
  await expect(page).toHaveURL(/\/capabilities$/);
  await expect(
    page
      .getByRole('navigation', { name: 'Views' })
      .getByRole('link', { name: new RegExp(`^${copy.title}`) }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(area(page)).toHaveAttribute('data-state', 'ready');
});

test.describe('the Connect tools page', () => {
  const connect = copy.source.connect;
  const form = (page: Page) => page.getByTestId('connect-form');

  for (const width of WIDTHS) {
    test(`is a page in the reading column under Capabilities, at ${width} pixels`, async ({
      page,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/capabilities/connect');

      // Rows 33a to 33d: the title is in the column, and the sections run in order above the footer.
      await expect(page.getByRole('heading', { level: 1, name: connect.title })).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(form(page).getByRole('heading', { level: 2 })).toHaveText([
        connect.sections.source,
        connect.sections.address,
        connect.sections.signIn,
        connect.sections.test,
        connect.sections.chooseTools,
      ]);
      // Before a test passes, Choose tools is a dashed box and the footer says to test (rows 33m, 33n).
      await expect(page.getByTestId('connect-choose-locked')).toHaveText(
        connect.chooseTools.locked,
      );
      await expect(page.getByTestId('connect-summary')).toHaveText(connect.chooseFirst);
      await checkA11y(`the Connect tools page at ${width}px`);
    });
  }

  test('MCP, Command: a one-line command under a warning, with Name and the footer (rows 33o, 33p, 33r)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/capabilities/connect');
    await form(page).getByRole('radio', { name: connect.transport.stdio, exact: true }).click();
    await form(page)
      .getByLabel(connect.command.label, { exact: true })
      .fill('npx -y @example/github-mcp');
    await form(page).getByLabel(connect.name.label, { exact: true }).fill('GitHub');

    const warning = page.getByTestId('connect-command-warning');
    await expect(warning).toContainText(connect.command.warningBefore.trim());
    await expect(warning.locator('code')).toHaveText(connect.command.warningCode);
    await expect(page.getByTestId('connect-summary')).toHaveText(connect.testsFirst);
  });

  /** Chooses an OpenAPI spec file holding `text`, which the host reads before anything is saved. */
  async function uploadSpec(page: Page, name: string, text: string): Promise<void> {
    await form(page).getByRole('radio', { name: connect.kind.openapi }).check();
    await form(page).getByRole('radio', { name: connect.specification.file }).check();
    await form(page)
      .locator('#connect-file')
      .setInputFiles({ name, mimeType: 'application/yaml', buffer: Buffer.from(text) });
  }

  const PAYMENTS_SPEC = [
    'openapi: 3.1.0',
    'info:',
    '  title: Payments API',
    "  version: '1'",
    'servers:',
    '  - url: https://payments.example.com/v1',
    'paths:',
    '  /refunds:',
    '    get: { operationId: listRefunds, summary: List refunds }',
    '    post: { operationId: createRefund, summary: Create a refund }',
    '  /refunds/{id}:',
    '    parameters: [{ name: id, in: path, required: true, schema: { type: string } }]',
    '    get: { operationId: getRefund, summary: Get a refund }',
    '    delete: { operationId: deleteRefund, summary: Delete a refund }',
    '  /invoices:',
    '    get: { operationId: listInvoices, summary: List invoices }',
    '    post: { operationId: createInvoice, summary: Create an invoice }',
    '',
  ].join('\n');

  test('OpenAPI spec: Name and Base URL from the spec, an API key, the read the test makes, and its operations (rows 33t to 33y, 34r)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/capabilities/connect');

    await uploadSpec(page, 'payments-openapi.yaml', PAYMENTS_SPEC);

    await expect(form(page).getByLabel(connect.name.label, { exact: true })).toHaveValue(
      'Payments API',
    );
    await expect(form(page)).toContainText(connect.name.fromSpec);
    await expect(form(page).getByLabel(connect.baseUrl.label)).toHaveValue(
      'https://payments.example.com/v1',
    );
    await expect(
      form(page).getByRole('radio', { name: connect.authentication['api-key'] }),
    ).toBeChecked();
    await expect(page.getByTestId('connect-test-calls')).toHaveText(
      connect.probe.calls('List refunds', 'GET', '/refunds'),
    );
    await expect(page.getByTestId('connect-spec-summary').locator('li')).toHaveText([
      'payments-openapi.yaml',
      'OpenAPI 3.1',
      '6 operations',
    ]);
    await expect(page.getByTestId('connect-operations-found')).toHaveText(
      connect.chooseTools.operations.found(6),
    );
    // Reads start on and changes start off (row 33w).
    await expect(page.getByTestId('connect-operations-selected')).toHaveText(
      connect.chooseTools.operations.selected(3, 6),
    );
    await expect(page.getByTestId('connect-operations-showing')).toHaveText(
      connect.chooseTools.operations.showing(4, 6),
    );
    await expect(page.getByTestId('connect-summary')).toHaveText(connect.joins(3, 'Payments API'));
  });

  test('OpenAPI spec: a spec with no operationId, and a file that is not a spec, say what is wrong (rows 34u, 34v)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/capabilities/connect');

    await uploadSpec(
      page,
      'payments-openapi.yaml',
      PAYMENTS_SPEC.replaceAll(/operationId: \w+, /g, ''),
    );
    await expect(page.getByTestId('connect-file-error')).toHaveText(
      'None of the 6 operations has an operationId, and each tool needs one. Add operationIds to the spec, then upload it again.',
    );
    await expect(page.getByTestId('connect-spec-summary').locator('li')).toHaveText([
      'payments-openapi.yaml',
      'OpenAPI 3.1',
      '6 operations',
    ]);

    await uploadSpec(
      page,
      'payments-openapi.yaml',
      "openapi: 3.1.0\ninfo:\n  title: Payments API\n  version: '1'\npaths: 5\n",
    );
    await expect(page.getByTestId('connect-file-error')).toContainText(
      '“paths” must be an object.',
    );
    await expect(form(page).locator('#connect-file')).toHaveAttribute('aria-invalid', 'true');
  });

  test('leaving: an untouched form leaves at once, and a filled one asks first (row 35b)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/capabilities/connect');
    await form(page).getByRole('button', { name: connect.actions.cancel, exact: true }).click();
    await expect(page).toHaveURL(/\/capabilities\?tab=sources$/);

    await page.goto('/capabilities/connect');
    await form(page).getByLabel(connect.name.label, { exact: true }).fill('GitHub');
    await form(page).getByRole('button', { name: connect.actions.cancel, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: connect.leave.title });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: connect.leave.keep }).click();
    await expect(page).toHaveURL(/\/capabilities\/connect$/);
    await expect(form(page).getByLabel(connect.name.label, { exact: true })).toHaveValue('GitHub');
  });

  test('Bearer token: a required masked Token under Sign in (row 34q)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/capabilities/connect');
    await form(page).getByRole('radio', { name: connect.authentication.bearer }).check();

    const token = form(page).locator('#connect-secret');
    await expect(token).toHaveAttribute('type', 'password');
    await expect(token).toHaveAttribute('required', '');
    await expect(form(page)).toContainText(connect.secret.description);
  });
});
