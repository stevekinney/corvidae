/**
 * COR-910 — the run inspector, loaded the way an MCP Apps host loads it: the built `ui://` page in a
 * sandboxed frame under its declared deny-all policy, behind the ext-apps 2.0.x `AppBridge`.
 * Tool calls are answered from fixtures, so the spec proves the page, not the Bureau.
 */
import { default as Axe } from '@axe-core/playwright';
import type { McpUiResourceCsp } from '@modelcontextprotocol/ext-apps/app-bridge';
import { expect, test, type Page } from '@playwright/test';

import {
  buildRunInspectorPage,
  RUN_INSPECTOR_UI_META,
} from '../../src/host/run-inspector-resource.ts';

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
  const built = await buildRunInspectorPage();
  pageHtml = built.html;
});

const inspection = (overrides: Record<string, unknown> = {}, taskOverrides = {}) => ({
  schemaVersion: 'bureau.task-inspection.v1',
  taskId: 'run-1',
  canCancel: true,
  task: {
    id: 'run-1',
    contextId: 'c',
    agentName: 'worker',
    owner: 'alice',
    actor: null,
    status: 'working',
    finishReason: null,
    statusMessage: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:01Z',
    cleanup: null,
    openWaits: [],
    ...taskOverrides,
  },
  liveness: {
    id: 'run-1',
    status: 'running',
    assessment: 'healthy',
    reachability: 'reachable',
    progress: 'progressing',
    revision: 2,
    attempt: 1,
    startedAt: '2026-01-01T00:00:00Z',
    lastTransitionAt: '2026-01-01T00:00:00Z',
    ownership: 'independent',
    durability: 'durable',
    cancellable: true,
    observedAt: 10,
    missedPulseCount: 0,
    semanticProgress: { phase: 'indexing', current: 3, total: 10, unit: 'files' },
    evidence: [
      { source: 'transport-keepalive', at: 5 },
      { source: 'tool-progress', at: 7 },
    ],
  },
  children: [{ runId: 'child-1', agentName: 'helper', status: 'running', assessment: 'healthy' }],
  ...overrides,
});

type Fixture = { inspection: unknown; events?: unknown };

async function open(page: Page, fixture: Fixture) {
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
    { html: string; csp: McpUiResourceCsp; inspected: unknown; events: unknown }
  >(
    async ({ html, csp, inspected, events }) => {
      const host = window.referenceHost;
      host.handlers['bureau.tasks.inspect'] = () => inspected;
      host.handlers['bureau.tasks.events'] = () => events;
      host.handlers['bureau.tasks.cancel'] = () => ({
        taskId: 'run-1',
        receipt: 'cancel-requested',
      });
      await host.mount(html, csp, { taskId: 'run-1' });
    },
    {
      html: pageHtml,
      csp: RUN_INSPECTOR_UI_META.csp,
      inspected: fixture.inspection,
      events: fixture.events ?? { events: [], nextCursor: null, ended: false },
    },
  );
  return { errors, app: page.frameLocator('iframe[title="Run inspector"]') };
}

test.describe('the run inspector MCP App', () => {
  test('renders the run, its tree, progress, and keeps heartbeat out of progress', async ({
    page,
  }) => {
    const { app, errors } = await open(page, { inspection: inspection() });
    await expect(app.getByRole('heading', { level: 1, name: 'Run run-1' })).toBeVisible();
    await expect(app.getByRole('region', { name: 'Lifecycle' })).toContainText('healthy');
    await expect(app.getByRole('region', { name: 'Ownership tree' })).toContainText('helper');
    await expect(app.getByRole('region', { name: 'Progress evidence' })).toContainText('indexing');
    await expect(app.getByRole('region', { name: 'Progress evidence' })).toContainText(
      'tool-progress',
    );
    await expect(app.getByRole('region', { name: 'Progress evidence' })).not.toContainText(
      'transport-keepalive',
    );
    await expect(app.getByRole('region', { name: 'Liveness signals' })).toContainText(
      'transport-keepalive',
    );
    expect(errors).toEqual([]);
  });

  test('is operable by keyboard: tab reaches Abort, Enter aborts through the host', async ({
    page,
  }) => {
    const { app } = await open(page, { inspection: inspection() });
    const abort = app.getByRole('button', { name: 'Abort run' });
    await expect(abort).toBeEnabled();
    await abort.focus();
    await expect(abort).toBeFocused();
    await page.keyboard.press('Enter');
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.referenceHost.calls.filter((call) => call.name === 'bureau.tasks.cancel').length,
        ),
      )
      .toBe(1);
  });

  test('has no axe violations and honors reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    const { app } = await open(page, { inspection: inspection() });
    await expect(app.getByRole('heading', { level: 1 })).toBeVisible();
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame())!;
    const results = await new Axe({ page }).include('iframe').analyze();
    expect(results.violations.filter((violation) => violation.impact !== 'minor')).toEqual([]);
    const transition = await frame.evaluate(
      () => getComputedStyle(document.querySelector('button')!).transitionDuration,
    );
    expect(['0s', '0.00001s']).toContain(transition === '' ? '0s' : transition.split(',')[0]);
  });

  test('cannot reach the network, the parent, or another origin', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (request) => {
      if (!request.url().startsWith(HOST_ORIGIN) && !request.url().startsWith('about:')) {
        requests.push(request.url());
      }
    });
    const { app } = await open(page, { inspection: inspection() });
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
        cookie: await reach(() => document.cookie),
        camera: await reach(() => navigator.mediaDevices.getUserMedia({ video: true })),
      };
    });
    expect(outcome.fetch).toBe('blocked');
    expect(outcome.parent).toBe('blocked');
    expect(outcome.storage).toBe('blocked');
    expect(requests).toEqual([]);
  });

  test('says when a run is not observed, shows a stream gap, and tears down without aborting', async ({
    page,
  }) => {
    const { app } = await open(page, {
      inspection: inspection({ liveness: null }),
      events: {
        events: [{ kind: 'task.gap', requestedCursor: '1', firstRetainedCursor: '9', cursor: '9' }],
        nextCursor: '9',
        ended: false,
      },
    });
    await expect(app.getByRole('region', { name: 'Lifecycle' })).toContainText(
      'not observed by this process',
    );
    await expect(app.getByRole('region', { name: 'Event stream' })).toContainText('Gap');
    await expect(app.getByRole('button', { name: 'Abort run' })).toBeDisabled();
    await page.evaluate(async () => window.referenceHost.teardown());
    await expect(page.locator('iframe[title="Run inspector"]')).toHaveCount(0);
    const cancels = await page.evaluate(
      () => window.referenceHost.calls.filter((call) => call.name === 'bureau.tasks.cancel').length,
    );
    expect(cancels).toBe(0);
  });

  test('keeps what it shows when the host stops answering, then reconnects', async ({ page }) => {
    const { app } = await open(page, { inspection: inspection() });
    await expect(app.getByRole('heading', { level: 1 })).toBeVisible();
    await page.evaluate(() => {
      delete window.referenceHost.handlers['bureau.tasks.inspect'];
    });
    await expect(app.getByRole('status')).toHaveText('Connection lost. Retrying.', {
      timeout: 10_000,
    });
    await expect(app.getByRole('heading', { level: 1 })).toBeVisible();
    await page.evaluate(() => {
      window.referenceHost.handlers['bureau.tasks.inspect'] = () => ({
        schemaVersion: 'bureau.task-inspection.v1',
        taskId: 'run-1',
        canCancel: true,
        task: {
          id: 'run-1',
          agentName: 'worker',
          owner: 'a',
          status: 'working',
          cleanup: null,
          openWaits: [],
        },
        liveness: {
          status: 'running',
          assessment: 'healthy',
          reachability: 'reachable',
          progress: 'progressing',
          revision: 3,
          cancellable: true,
          evidence: [],
        },
        children: [],
      });
    });
    await expect(app.getByRole('status')).toHaveText('Reconnected.', { timeout: 10_000 });
  });

  test('ignores a snapshot older than the one it shows', async ({ page }) => {
    const { app } = await open(page, { inspection: inspection() });
    await expect(app.getByRole('region', { name: 'Lifecycle' })).toContainText('healthy');
    await page.evaluate(() => {
      window.referenceHost.handlers['bureau.tasks.inspect'] = () => ({
        schemaVersion: 'bureau.task-inspection.v1',
        taskId: 'run-1',
        canCancel: true,
        task: {
          id: 'run-1',
          agentName: 'worker',
          owner: 'a',
          status: 'failed',
          cleanup: null,
          openWaits: [],
        },
        liveness: {
          status: 'terminal',
          assessment: 'terminal',
          reachability: 'reachable',
          progress: 'idle',
          revision: 1,
          cancellable: false,
          evidence: [],
        },
        children: [],
      });
    });
    await page.waitForTimeout(3500);
    await expect(app.getByRole('region', { name: 'Lifecycle' })).toContainText('healthy');
    await expect(app.getByRole('region', { name: 'Lifecycle' })).not.toContainText('failed');
  });

  test('keeps keyboard focus on Abort across a refresh', async ({ page }) => {
    const { app } = await open(page, { inspection: inspection() });
    const abort = app.getByRole('button', { name: 'Abort run' });
    await abort.focus();
    const before = await page.evaluate(() => window.referenceHost.calls.length);
    await expect
      .poll(() => page.evaluate(() => window.referenceHost.calls.length), { timeout: 10_000 })
      .toBeGreaterThan(before + 1);
    await expect(abort).toBeFocused();
  });
});
