/**
 * COR-2218 — the workflow revision review, loaded the way an MCP Apps host loads it: the built
 * `ui://` page in a sandboxed frame under its declared deny-all policy, behind the ext-apps 2.0.x
 * `AppBridge`. The proposal that opens the page and every tool call are answered from fixtures, so
 * the spec proves the page, not the Bureau.
 */
import { default as Axe } from '@axe-core/playwright';
import { workflowRevisionReview } from '@lostgradient/plugin-inspectors';
import type { McpUiHostContext, McpUiResourceCsp } from '@modelcontextprotocol/ext-apps/app-bridge';
import { expect, test, type Page } from '@playwright/test';

import { buildPanelPage } from '../../src/host/panel-build.ts';
import { MCP_APP_UI_META } from '../../src/host/panel-mounts.ts';
import { expectFollowsHost, hostContextFor, SCHEMES, type Scheme } from './host-theme.ts';

const HOST_ORIGIN = 'http://reference-host.test';
const TITLE = workflowRevisionReview.title;

let hostScript = '';
let pageHtml = '';

test.beforeAll(async () => {
  const bundle = await Bun.build({
    entrypoints: [new URL('./reference-host.ts', import.meta.url).pathname],
    target: 'browser',
    format: 'esm',
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, 'The reference host did not build');
  hostScript = await bundle.outputs[0]!.text();
  const built = await buildPanelPage({
    entry: workflowRevisionReview.entry.href,
    title: workflowRevisionReview.title,
    styles: workflowRevisionReview.styles ?? '',
  });
  pageHtml = built.html;
});

const CURRENT = {
  name: 'nightly',
  title: 'Nightly',
  trigger: { kind: 'manual' },
  steps: [{ id: 'one', run: 'a' }],
};
const PROPOSED = {
  name: 'nightly',
  title: 'Nightly report',
  trigger: { kind: 'manual' },
  steps: [
    { id: 'one', run: 'a' },
    { id: 'two', run: 'b' },
  ],
};
const PROPOSAL = {
  status: 'ok',
  id: 'wf',
  baseHash: 'h1',
  proposedText: JSON.stringify(PROPOSED),
};

type Fixture = { update?: unknown };

async function open(page: Page, fixture: Fixture = {}, scheme?: Scheme) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(`${HOST_ORIGIN}/`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Reference host</title><script type="module">${hostScript}</script>`,
    }),
  );
  await page.goto(`${HOST_ORIGIN}/`);
  await page.evaluate<
    void,
    {
      html: string;
      csp: McpUiResourceCsp;
      title: string;
      proposal: unknown;
      current: unknown;
      update: unknown;
      hostContext: unknown;
    }
  >(
    async ({ html, csp, title, proposal, current, update, hostContext }) => {
      const host = window.referenceHost;
      host.handlers['bureau.workflows.get'] = () => ({
        id: 'wf',
        hash: 'h1',
        text: JSON.stringify(current),
      });
      host.handlers['bureau.workflows.update'] = () => update;
      host.toolResult = {
        content: [{ type: 'text', text: JSON.stringify(proposal) }],
        structuredContent: proposal,
      };
      await host.mount(html, csp, { id: 'wf' }, title, hostContext as McpUiHostContext | undefined);
    },
    {
      html: pageHtml,
      csp: MCP_APP_UI_META.csp,
      title: TITLE,
      proposal: PROPOSAL,
      current: CURRENT,
      update: fixture.update ?? { status: 'ok', hash: 'h2' },
      hostContext: scheme === undefined ? undefined : hostContextFor(scheme),
    },
  );
  return { errors, app: page.frameLocator(`iframe[title="${TITLE}"]`) };
}

const calls = (page: Page, name: string) =>
  page.evaluate((tool) => window.referenceHost.calls.filter((call) => call.name === tool), name);

test.describe('the workflow revision review MCP App', () => {
  test('shows the current and the proposed definition, row by row, and what differs', async ({
    page,
  }) => {
    const { app, errors } = await open(page);
    await expect(
      app.getByRole('heading', { level: 1, name: 'Review workflow revision' }),
    ).toBeVisible();
    await expect(app.getByRole('status')).toHaveText('Review 2 visible changes before applying.');
    const comparison = app.getByRole('region', { name: 'Workflow definition comparison' });
    await expect(comparison).toContainText('Nightly report');
    await expect(comparison).toContainText('Step 2');
    await expect(comparison.locator('.revision-row[data-state="changed"]')).toHaveCount(1);
    await expect(comparison.locator('.revision-row[data-state="added"]')).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('applies by keyboard through the host, exactly once, fenced by the hash it read', async ({
    page,
  }) => {
    const { app } = await open(page);
    const apply = app.getByRole('button', { name: 'Apply' });
    await expect(apply).toBeEnabled();
    await apply.focus();
    await page.keyboard.press('Enter');
    await expect(app.getByRole('status')).toHaveText('Applied. New hash: h2');
    await expect(app.getByRole('button', { name: 'Applied' })).toBeDisabled();
    const updates = await calls(page, 'bureau.workflows.update');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.arguments).toMatchObject({ id: 'wf', expectedHash: 'h1' });
    expect(updates[0]?.arguments['definition']).toEqual({
      title: 'Nightly report',
      trigger: { kind: 'manual' },
      steps: PROPOSED.steps,
    });
  });

  test('says the file changed when the host reports a conflict, and offers no second Apply', async ({
    page,
  }) => {
    const { app } = await open(page, { update: { status: 'conflict', currentHash: 'h9' } });
    await app.getByRole('button', { name: 'Apply' }).click();
    await expect(app.getByRole('status')).toContainText('The file changed since the proposal.');
    await expect(app.getByRole('button', { name: 'Apply' })).toBeDisabled();
  });

  for (const scheme of SCHEMES) {
    test(`follows the host's ${scheme} theme and has no axe violations in it`, async ({ page }) => {
      // The system says the other scheme: the host's word is the one the panel follows.
      await page.emulateMedia({ colorScheme: scheme === 'dark' ? 'light' : 'dark' });
      const { app } = await open(page, {}, scheme);
      await expect(
        app.getByRole('heading', { level: 1, name: 'Review workflow revision' }),
      ).toBeVisible();
      await expectFollowsHost(app, scheme);
      const results = await new Axe({ page }).include('iframe').analyze();
      expect(results.violations.filter((violation) => violation.impact !== 'minor')).toEqual([]);
    });
  }
});
