/**
 * COR-2542 — the run timeline, loaded the way an MCP Apps host loads it: the built `ui://` page in a
 * sandboxed frame under its declared deny-all policy, behind the ext-apps 2.0.x `AppBridge`. The
 * timeline read is answered from fixtures, so the spec proves the page, not the Bureau.
 */
import { default as Axe } from '@axe-core/playwright';
import { runTimeline } from '@lostgradient/plugin-inspectors';
import type { McpUiHostContext, McpUiResourceCsp } from '@modelcontextprotocol/ext-apps/app-bridge';
import { expect, test, type Page } from '@playwright/test';

import { buildPanelPage } from '../../src/host/panel-build.ts';
import { MCP_APP_UI_META } from '../../src/host/panel-mounts.ts';
import { expectFollowsHost, hostContextFor, SCHEMES, type Scheme } from './host-theme.ts';

const HOST_ORIGIN = 'http://reference-host.test';
const TITLE = runTimeline.title;

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
    entry: runTimeline.entry.href,
    title: runTimeline.title,
    styles: runTimeline.styles ?? '',
  });
  pageHtml = built.html;
});

// Steps start ten seconds apart, ending a minute or so before now, so the last one is still going.
const START = Date.now() - 60_000;

const step = (overrides: Record<string, unknown> & { step: number }) => ({
  label: `step-${String(overrides.step)}`,
  operationType: 'activity',
  status: 'completed',
  timestamp: START + overrides.step * 10_000,
  duration: 800,
  tries: 1,
  ...overrides,
});

/** A run that has fetched, retried a failing step three times, and is now waiting on a signal. */
const RUN = {
  runId: 'run-1',
  kind: 'workflow',
  runStatus: 'running',
  truncated: false,
  entries: [
    step({ step: 1, label: 'fetchPages', duration: 2_400 }),
    step({ step: 2, label: 'summarize', status: 'failed', duration: 1_100, tries: 3 }),
    step({
      step: 3,
      label: 'sleep',
      operationType: 'sleep',
      status: 'timed-out',
      duration: 9_000,
    }),
    step({
      step: 4,
      label: 'await-signal',
      operationType: 'await-signal',
      status: 'running',
      duration: undefined,
    }),
  ],
};

type Fixture = { timeline?: unknown; toolInput?: Record<string, unknown> };

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
  await page.evaluate<
    void,
    {
      html: string;
      csp: McpUiResourceCsp;
      title: string;
      timeline: unknown;
      toolInput: Record<string, unknown>;
      hostContext: unknown;
    }
  >(
    async ({ html, csp, title, timeline, toolInput, hostContext }) => {
      const host = window.referenceHost;
      host.handlers['bureau.runs.timeline'] = () => {
        if (timeline === undefined) throw new Error('NotFound');
        return timeline;
      };
      await host.mount(html, csp, toolInput, title, hostContext as McpUiHostContext | undefined);
    },
    {
      html: pageHtml,
      csp: MCP_APP_UI_META.csp,
      title: TITLE,
      timeline: fixture.timeline,
      // The run page opens a panel with `taskId`; the timeline tool takes `runId`.
      toolInput: fixture.toolInput ?? { taskId: 'run-1' },
      hostContext: scheme === undefined ? undefined : hostContextFor(scheme),
    },
  );
  return { errors, app: page.frameLocator(`iframe[title="${TITLE}"]`) };
}

test.describe('the run timeline MCP App', () => {
  test('renders each step with its status, duration and tries, and calls only the timeline read', async ({
    page,
  }) => {
    const { app, errors } = await open(page, { timeline: RUN });
    await expect(
      app.getByRole('heading', { level: 1, name: 'Timeline of run run-1' }),
    ).toBeVisible();
    const steps = app.getByRole('list', { name: /Steps of the run/ }).getByRole('listitem');
    await expect(steps).toHaveCount(4);
    await expect(steps.nth(0)).toContainText('fetchPages');
    await expect(steps.nth(0)).toContainText('Succeeded');
    await expect(steps.nth(0)).toContainText('2.4 s');
    await expect(steps.nth(1)).toContainText('Failed');
    await expect(steps.nth(1)).toContainText('3 tries');
    await expect(steps.nth(2)).toContainText('Timed out');
    await expect(steps.nth(2)).toContainText('9 s');
    await expect(steps.nth(3)).toContainText('Running');
    await expect(steps.nth(3).getByRole('img')).toHaveAccessibleName(/still running/);
    const calls = await page.evaluate(() => window.referenceHost.calls.map((call) => call.name));
    expect(new Set(calls)).toEqual(new Set(['bureau.runs.timeline']));
    expect(errors).toEqual([]);
  });

  test('draws a step the engine left running as ended when the run has finished', async ({
    page,
  }) => {
    const { app } = await open(page, { timeline: { ...RUN, runStatus: 'failed' } });
    const steps = app.getByRole('list', { name: /Steps of the run/ }).getByRole('listitem');
    await expect(steps).toHaveCount(4);
    await expect(steps.nth(3)).toContainText('Ended');
    await expect(steps.nth(3)).not.toContainText('Running');
    await expect(app.getByText('Run failed.')).toBeVisible();
  });

  test('reads the run named by `runId` as well as `taskId`', async ({ page }) => {
    const { app } = await open(page, { timeline: RUN, toolInput: { runId: 'run-1' } });
    await expect(app.getByRole('heading', { level: 1 })).toBeVisible();
    const calls = await page.evaluate(() => window.referenceHost.calls);
    expect(calls[0]?.arguments).toEqual({ runId: 'run-1' });
  });

  test('says so when the run has taken no steps, and when it has more than the read holds', async ({
    page,
  }) => {
    const { app } = await open(page, { timeline: { ...RUN, entries: [] } });
    await expect(app.getByText('This run has taken no steps yet.')).toBeVisible();
    await page.evaluate(() => {
      window.referenceHost.handlers['bureau.runs.timeline'] = () => ({
        runId: 'run-1',
        kind: 'workflow',
        runStatus: 'running',
        truncated: true,
        entries: [
          {
            step: 1,
            label: 'only',
            operationType: 'activity',
            status: 'completed',
            timestamp: 1,
            duration: 5,
            tries: 1,
          },
        ],
      });
    });
    await expect(app.getByText('This run has more steps than the timeline holds.')).toBeVisible();
  });

  test('says when the run could not be read', async ({ page }) => {
    const { app } = await open(page, { timeline: undefined });
    await expect(app.getByText('The timeline could not be read.')).toBeVisible();
  });

  test('keeps what it shows when the host stops answering, then reconnects', async ({ page }) => {
    const { app } = await open(page, { timeline: RUN });
    await expect(app.getByRole('heading', { level: 1 })).toBeVisible();
    await page.evaluate(() => {
      delete window.referenceHost.handlers['bureau.runs.timeline'];
    });
    await expect(app.getByRole('status')).toHaveText('Connection lost. Retrying.');
    await expect(app.getByRole('heading', { level: 1 })).toBeVisible();
    await page.evaluate((timeline) => {
      window.referenceHost.handlers['bureau.runs.timeline'] = () => timeline;
    }, RUN);
    await expect(app.getByRole('status')).toHaveText('Reconnected.');
  });

  for (const scheme of SCHEMES) {
    test(`follows the host's ${scheme} theme and has no axe violations in it`, async ({ page }) => {
      // The system says the other scheme: the host's word is the one the panel follows.
      await page.emulateMedia({ colorScheme: scheme === 'dark' ? 'light' : 'dark' });
      const { app } = await open(page, { timeline: RUN }, scheme);
      await expect(app.getByRole('heading', { level: 1 })).toBeVisible();
      await expectFollowsHost(app, scheme);
      const results = await new Axe({ page }).include('iframe').analyze();
      expect(results.violations.filter((violation) => violation.impact !== 'minor')).toEqual([]);
    });
  }

  test('has no form or control to submit, so the sandbox that allows scripts alone loses nothing', async ({
    page,
  }) => {
    const { app } = await open(page, { timeline: RUN });
    await expect(app.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(app.locator('form, button, input, a')).toHaveCount(0);
  });

  test('cannot reach the network, the parent, or another origin', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (request) => {
      if (!request.url().startsWith(HOST_ORIGIN) && !request.url().startsWith('about:')) {
        requests.push(request.url());
      }
    });
    const { app } = await open(page, { timeline: RUN });
    await expect(app.getByRole('heading', { level: 1 })).toBeVisible();
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
});
