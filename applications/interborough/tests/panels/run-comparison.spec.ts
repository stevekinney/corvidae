/**
 * COR-2544 — the run comparison, loaded the way an MCP Apps host loads it: the built `ui://` page in
 * a sandboxed frame under its declared deny-all policy, behind the ext-apps 2.0.x `AppBridge`. Tool
 * calls are answered from fixtures, so the spec proves the page, not the Bureau.
 */
import { default as Axe } from '@axe-core/playwright';
import { runComparison } from '@lostgradient/plugin-inspectors';
import type { McpUiHostContext, McpUiResourceCsp } from '@modelcontextprotocol/ext-apps/app-bridge';
import { expect, test, type Page } from '@playwright/test';

import { buildPanelPage } from '../../src/host/panel-build.ts';
import { MCP_APP_UI_META } from '../../src/host/panel-mounts.ts';
import { expectFollowsHost, hostContextFor, SCHEMES, type Scheme } from './host-theme.ts';

const HOST_ORIGIN = 'http://reference-host.test';

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
    entry: runComparison.entry.href,
    title: runComparison.title,
    styles: runComparison.styles ?? '',
  });
  pageHtml = built.html;
});

const side = (overrides: Record<string, string | undefined> = {}) => ({
  operationType: 'activity',
  label: 'issueTicket',
  status: 'completed',
  input: '{"order":"ord_1"}',
  output: '{"ticket":{"id":1,"lane":"north"},"cents":4999}',
  ...overrides,
});

/** A fork of `source-1` at checkpoint step 2: step 1 is shared, step 2 changed its ticket, step 3 is the same. */
const FORK = {
  runId: 'fork-1',
  sourceRunId: 'source-1',
  forkPoint: 2,
  steps: [
    {
      index: 0,
      shared: true,
      source: side({ label: 'reserveStock' }),
      fork: side({ label: 'reserveStock' }),
    },
    {
      index: 1,
      shared: false,
      source: side(),
      fork: side({ output: '{"ticket":{"id":2,"lane":"north"},"cents":4999}' }),
    },
    { index: 2, shared: false, source: side({ label: 'notify' }), fork: side({ label: 'notify' }) },
  ],
};

type Fixture = {
  /** What `bureau.runs.compare` answers, by the arguments it is called with. */
  compare: (args: Record<string, unknown>) => unknown;
  /** The arguments that open the page: a client's `runId`, or a run page's `taskId`. */
  toolInput?: Record<string, unknown>;
};

async function open(page: Page, fixture: Fixture, scheme?: Scheme) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(`${HOST_ORIGIN}/`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Reference host</title><script type="module">${hostScript}</script>`,
    }),
  );
  await page.goto(`${HOST_ORIGIN}/`);
  await page.exposeFunction('compareFixture', (args: Record<string, unknown>) =>
    fixture.compare(args),
  );
  await page.evaluate<
    void,
    {
      html: string;
      csp: McpUiResourceCsp;
      title: string;
      toolInput: Record<string, unknown>;
      hostContext: unknown;
    }
  >(
    async ({ html, csp, title, toolInput, hostContext }) => {
      const host = window.referenceHost;
      host.handlers['bureau.runs.compare'] = (args) =>
        (window as unknown as { compareFixture(args: unknown): unknown }).compareFixture(args);
      await host.mount(html, csp, toolInput, title, hostContext as McpUiHostContext | undefined);
    },
    {
      html: pageHtml,
      csp: MCP_APP_UI_META.csp,
      title: runComparison.title,
      toolInput: fixture.toolInput ?? { runId: 'fork-1' },
      hostContext: scheme === undefined ? undefined : hostContextFor(scheme),
    },
  );
  return { errors, app: page.frameLocator(`iframe[title="${runComparison.title}"]`) };
}

test.describe('the run comparison MCP App', () => {
  test('selects a differing step of a forked run and reads the changed value', async ({ page }) => {
    const { app, errors } = await open(page, { compare: () => FORK });

    await expect(
      app.getByRole('heading', { level: 1, name: 'Run fork-1 compared with source-1' }),
    ).toBeVisible();
    // The step before the fork point is shared, and collapsed until it is asked for.
    const shared = app.getByRole('button', { name: '1 step shared with the source' });
    await expect(shared).toHaveAttribute('aria-expanded', 'false');
    await expect(app.locator('[data-shared-step]')).toHaveCount(0);

    const changed = app.locator('[data-compared-step="1"]');
    await expect(changed).toHaveAttribute('data-kind', 'changed');
    await changed.click();
    const output = app.getByRole('group', { name: 'Output differences, step 2' });
    await expect(output).toBeVisible();
    // The ticket's id changed from 1 to 2, read at its depth.
    const id = output.locator('[data-cinder-diff-kind="changed"]').filter({ hasText: 'id' });
    await expect(id).toContainText('1 → 2');
    await expect(app.getByText('The input is the same in both runs.')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('reads the run a run page names, and follows the pages of a long comparison', async ({
    page,
  }) => {
    const asked: Record<string, unknown>[] = [];
    const { app } = await open(page, {
      toolInput: { taskId: 'fork-1' },
      compare: (args) => {
        asked.push(args);
        return args['cursor'] === undefined
          ? { ...FORK, steps: FORK.steps.slice(0, 2), nextCursor: 'step:1' }
          : { ...FORK, steps: FORK.steps.slice(2) };
      },
    });

    await expect(app.locator('[data-compared-step="2"]')).toBeVisible();
    await expect(app.locator('[data-compared-step="1"]')).toBeVisible();
    expect(asked).toEqual([
      { runId: 'fork-1', limit: 1000 },
      { runId: 'fork-1', limit: 1000, cursor: 'step:1' },
    ]);
  });

  test('shows the server’s message for a run that is not a fork', async ({ page }) => {
    const message =
      'Run run-1 is not a fork, so there is no source to compare it with. Fork a run, then compare the fork.';
    const { app, errors } = await open(page, {
      toolInput: { taskId: 'run-1' },
      compare: () => {
        throw new Error(message);
      },
    });

    const shown = app.locator('[data-comparison-message]');
    await expect(shown).toBeVisible();
    await expect(shown).toContainText(message);
    await expect(app.locator('[data-compared-step]')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  for (const scheme of SCHEMES) {
    test(`follows the host's ${scheme} theme and has no axe violations in it`, async ({ page }) => {
      // The system says the other scheme: the host's word is the one the panel follows.
      await page.emulateMedia({ colorScheme: scheme === 'dark' ? 'light' : 'dark' });
      const { app } = await open(page, { compare: () => FORK }, scheme);
      await expect(app.getByRole('heading', { level: 1 })).toBeVisible();
      await app.locator('[data-compared-step="1"]').click();
      await expect(app.getByRole('group', { name: 'Output differences, step 2' })).toBeVisible();
      await expectFollowsHost(app, scheme);
      const results = await new Axe({ page }).include('iframe').analyze();
      expect(results.violations.filter((violation) => violation.impact !== 'minor')).toEqual([]);
    });
  }
});
