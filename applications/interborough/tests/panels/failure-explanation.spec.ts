/**
 * COR-2543 — the failure explanation, loaded the way an MCP Apps host loads it: the built `ui://`
 * page in a sandboxed frame under its declared deny-all policy, behind the ext-apps 2.0.x
 * `AppBridge`. Tool calls are answered from fixtures, so the spec proves the page, not the Bureau:
 * the explanation of a failed run renders its sentence, cause, step, tries, guardrails and
 * remediation, a run that did not fail shows the Bureau's own message, and the one tool the page
 * calls is the explain read.
 */
import { default as Axe } from '@axe-core/playwright';
import { failureExplanation } from '@lostgradient/plugin-inspectors';
import type { McpUiHostContext, McpUiResourceCsp } from '@modelcontextprotocol/ext-apps/app-bridge';
import { expect, test, type Page } from '@playwright/test';

import { buildPanelPage } from '../../src/host/panel-build.ts';
import { MCP_APP_UI_META } from '../../src/host/panel-mounts.ts';
import {
  explained,
  FAILED_FIXTURE_RUN,
  NOT_FAILED_FAULT,
  NOT_FAILED_SENTENCE,
} from './failure-explanation-fixtures.ts';
import { expectFollowsHost, hostContextFor, SCHEMES, type Scheme } from './host-theme.ts';

const HOST_ORIGIN = 'http://reference-host.test';
const TITLE = failureExplanation.title;

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
    entry: failureExplanation.entry.href,
    title: failureExplanation.title,
    styles: failureExplanation.styles ?? '',
  });
  pageHtml = built.html;
});

type Opening = {
  /** What the host gives the panel as the tool input: the explain tool's `runId`, or a run page's `taskId`. */
  readonly toolInput?: Record<string, unknown>;
  /** The result that opened the page, for a client that ran the explain tool. */
  readonly toolResult?: { content: unknown[]; structuredContent?: unknown; isError?: boolean };
  /** What the host answers the panel's own read with, as a whole tool result. */
  readonly answer?: unknown;
  readonly unreachable?: boolean;
  readonly scheme?: Scheme;
};

async function open(page: Page, opening: Opening = {}) {
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
      toolInput: Record<string, unknown>;
      toolResult: unknown;
      answer: unknown;
      unreachable: boolean;
      hostContext: unknown;
    }
  >(
    async ({ html, csp, title, toolInput, toolResult, answer, unreachable, hostContext }) => {
      const host = window.referenceHost;
      if (toolResult !== undefined) {
        host.toolResult = toolResult as NonNullable<typeof host.toolResult>;
      }
      host.rawHandlers['bureau.tasks.explain'] = async () => answer as never;
      if (unreachable) host.unreachable.push('bureau.tasks.explain');
      await host.mount(html, csp, toolInput, title, hostContext as McpUiHostContext | undefined);
    },
    {
      html: pageHtml,
      csp: MCP_APP_UI_META.csp,
      title: TITLE,
      toolInput: opening.toolInput ?? { taskId: 'run-1' },
      toolResult: opening.toolResult,
      answer: opening.answer ?? explained(FAILED_FIXTURE_RUN),
      unreachable: opening.unreachable ?? false,
      hostContext: opening.scheme === undefined ? undefined : hostContextFor(opening.scheme),
    },
  );
  return { errors, app: page.frameLocator(`iframe[title="${TITLE}"]`) };
}

test.describe('the failure explanation MCP App', () => {
  test('AC5: renders the explanation of a failed fixture run, read through the one explain call', async ({
    page,
  }) => {
    const { app, errors } = await open(page);
    await expect(app.getByRole('heading', { level: 1, name: 'Why this run failed' })).toBeVisible();
    await expect(app.getByText(FAILED_FIXTURE_RUN.summary)).toBeVisible();
    const facts = app.locator('.cinder-description-list');
    await expect(facts).toContainText('application');
    // The engine's UNKNOWN is no code, and the kind is in the sentence: neither is drawn.
    await expect(facts).not.toContainText('UNKNOWN');
    await expect(facts).toContainText('charge-card');
    await expect(facts).toContainText('3');
    await expect(app.locator('[data-explanation="guardrails"]')).toContainText(
      'sentinel-card stopped the run',
    );
    await expect(app.locator('[data-explanation="remediation"]')).toContainText(
      FAILED_FIXTURE_RUN.remediation,
    );
    // The page calls the explain read, once, for the run the run's page named, and nothing else.
    const calls = await page.evaluate(() => window.referenceHost.calls);
    expect(calls).toEqual([{ name: 'bureau.tasks.explain', arguments: { runId: 'run-1' } }]);
    expect(errors).toEqual([]);
  });

  test('AC2: draws the result that opened it, from the explain tool, without a second read', async ({
    page,
  }) => {
    const { app } = await open(page, {
      toolInput: { runId: 'run-1' },
      toolResult: explained(FAILED_FIXTURE_RUN),
    });
    await expect(app.getByText(FAILED_FIXTURE_RUN.summary)).toBeVisible();
    // The page makes no call of its own that the opening result already answered. A read that was
    // already in flight when the result arrived is dropped for it; either way only the explain read.
    const calls = await page.evaluate(() => window.referenceHost.calls);
    for (const call of calls) expect(call.name).toBe('bureau.tasks.explain');
    expect(calls.length).toBeLessThanOrEqual(1);
  });

  test('AC3: says the run did not fail, in the page’s own sentence, and what to do', async ({
    page,
  }) => {
    const { app } = await open(page, { answer: NOT_FAILED_FAULT });
    await expect(app.getByText(NOT_FAILED_SENTENCE)).toBeVisible();
    // No run identifier and no quoted status in what the page says.
    await expect(app.getByText('run-1')).toHaveCount(0);
    await expect(app.locator('[data-explanation="remediation"]')).toContainText(
      'Explain a run only after it has failed',
    );
    await expect(app.locator('[data-explanation="cause"]')).toHaveCount(0);
  });

  test('AC3: says the same for a refusal opened from the explain tool', async ({ page }) => {
    const { app } = await open(page, {
      toolInput: { runId: 'run-1' },
      toolResult: NOT_FAILED_FAULT,
      answer: NOT_FAILED_FAULT,
    });
    await expect(app.getByText(NOT_FAILED_SENTENCE)).toBeVisible();
  });

  test('says so when the host does not answer, and draws nothing it did not read', async ({
    page,
  }) => {
    const { app } = await open(page, { unreachable: true });
    await expect(app.getByText('The host did not answer')).toBeVisible();
    await expect(app.locator('[data-explanation="root"]')).toHaveCount(0);
  });

  test('says no run is named when it is opened with none', async ({ page }) => {
    const { app } = await open(page, { toolInput: {} });
    await expect(app.getByText('No run is named.')).toBeVisible();
    expect(await page.evaluate(() => window.referenceHost.calls)).toEqual([]);
  });

  test('has no control: it reads, and there is nothing in it to press', async ({ page }) => {
    const { app } = await open(page);
    await expect(app.getByText(FAILED_FIXTURE_RUN.summary)).toBeVisible();
    await expect(app.getByRole('button')).toHaveCount(0);
    await expect(app.getByRole('link')).toHaveCount(0);
  });

  for (const scheme of SCHEMES) {
    test(`follows the host's ${scheme} theme and has no axe violations in it`, async ({ page }) => {
      // The system says the other scheme: the host's word is the one the panel follows.
      await page.emulateMedia({ colorScheme: scheme === 'dark' ? 'light' : 'dark' });
      const { app } = await open(page, { scheme });
      await expect(app.getByText(FAILED_FIXTURE_RUN.summary)).toBeVisible();
      await expectFollowsHost(app, scheme);
      const results = await new Axe({ page }).include('iframe').analyze();
      expect(results.violations.filter((violation) => violation.impact !== 'minor')).toEqual([]);
    });
  }

  test('cannot reach the network, the parent, or another origin', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (request) => {
      if (!request.url().startsWith(HOST_ORIGIN) && !request.url().startsWith('about:')) {
        requests.push(request.url());
      }
    });
    const { app } = await open(page);
    await expect(app.getByText(FAILED_FIXTURE_RUN.summary)).toBeVisible();
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame())!;
    const outcome = await frame.evaluate(async () => {
      const reach = async (probe: () => unknown): Promise<string> => {
        try {
          await probe();
          return 'reached';
        } catch {
          return 'blocked';
        }
      };
      return {
        fetch: await reach(() => fetch('https://example.com/steal')),
        parent: await reach(() => parent.document.body),
        storage: await reach(() => localStorage.getItem('x')),
      };
    });
    expect(outcome).toEqual({ fetch: 'blocked', parent: 'blocked', storage: 'blocked' });
    expect(requests).toEqual([]);
  });

  test('tears down without a call the Bureau would see', async ({ page }) => {
    const { app } = await open(page);
    await expect(app.getByText(FAILED_FIXTURE_RUN.summary)).toBeVisible();
    await page.evaluate(async () => window.referenceHost.teardown());
    await expect(page.locator(`iframe[title="${TITLE}"]`)).toHaveCount(0);
    const names = await page.evaluate(() => window.referenceHost.calls.map((call) => call.name));
    expect(names.every((name) => name === 'bureau.tasks.explain')).toBe(true);
  });
});
