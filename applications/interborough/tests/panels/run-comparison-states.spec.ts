/**
 * The run comparison panel in each state it draws, for the design review of COR-2544.
 * `scripts/design-review-capture.ts` screenshots pages, and the panel is not a page: it is a
 * document in a sandboxed frame inside a host. This specification mounts it the way
 * `run-comparison.spec.ts` does (the built `ui://` page in the reference host, behind the ext-apps
 * `AppBridge`), answers `bureau.runs.compare` from fixtures, reaches each state the way a person
 * does, and captures it at 1280 (and 1920, which the helper repeats) and at 375 (and 320 by 640).
 * Each capture is named `run-comparison--<state>` (the route and the state of `captureForDesignReview`).
 *
 * The comparison is a fixture because the end-to-end host holds no fork of an instance of a workflow
 * file for the Bureau to compare (`fork-comparison-states.spec.ts` says why); the answer is the shape
 * `bureau.runs.compare` serves, and the Bureau's own is `runs-compare-operation.test.ts`. The refusal is the shape the
 * MCP adapter gives a Bureau fault: an error result with the fault as structured content.
 *
 * The reference host holds the frame in a `main.weft-shell-outlet`, as the shell holds a page, and
 * the frame is sized to what the panel draws, so the helper's whole-page capture shows all of it.
 * The panel follows the theme the host sends: both schemes in an ordinary run, and the capture's own
 * color scheme when `INTERBOROUGH_DESIGN_REVIEW_CAPTURE` is set, so a capture is taken once per
 * scheme. An ordinary run reaches each state and checks it is the one named.
 */
import { runComparison } from '@lostgradient/plugin-inspectors';
import type { McpUiHostContext, McpUiResourceCsp } from '@modelcontextprotocol/ext-apps/app-bridge';
import { expect, test, type FrameLocator, type Page } from '@playwright/test';

import {
  designReviewCaptureDirectory,
  designReviewColorScheme,
} from '../../scripts/environment-configuration.ts';
import { buildPanelPage } from '../../src/host/panel-build.ts';
import { MCP_APP_UI_META } from '../../src/host/panel-mounts.ts';
import { captureForDesignReview, nextFrame } from '../e2e/design-review-capture.ts';
import { hostContextFor, SCHEMES, type Scheme } from './host-theme.ts';

const SOURCE = 'run-comparison-states.spec.ts';
const ROUTE = 'run-comparison';
const HOST_ORIGIN = 'http://reference-host.test';
const TITLE = runComparison.title;

/** The widths a state is captured at; the helper repeats 1280 at 1920 and 375 at 320 by 640. */
const SIZES = [
  { width: 1280, height: 900 },
  { width: 375, height: 812 },
] as const;

/** A capture run takes one scheme, the run's own; an ordinary run takes both. */
const capturedScheme = designReviewColorScheme();
const RUN_SCHEMES: readonly Scheme[] = capturedScheme === undefined ? SCHEMES : [capturedScheme];

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
  input: '{"order":"ord_6001"}',
  output: '{"ticket":{"id":1,"lane":"north"},"cents":4999}',
  ...overrides,
});

/**
 * A fork of `source-1` at checkpoint step 3: two shared steps, one the fork ran again with a new
 * ticket, one it ran again to the same result, one only the source reached and one only the fork did.
 */
const FORK = {
  runId: 'fork-1',
  sourceRunId: 'source-1',
  forkPoint: 3,
  steps: [
    {
      index: 0,
      shared: true,
      source: side({ label: 'reserveStock' }),
      fork: side({ label: 'reserveStock' }),
    },
    {
      index: 1,
      shared: true,
      source: side({ label: 'chargeCard' }),
      fork: side({ label: 'chargeCard' }),
    },
    {
      index: 2,
      shared: false,
      source: side(),
      fork: side({ output: '{"ticket":{"id":2,"lane":"north"},"cents":4999}' }),
    },
    { index: 3, shared: false, source: side({ label: 'notify' }), fork: side({ label: 'notify' }) },
    { index: 4, shared: false, source: side({ label: 'archive' }) },
    { index: 5, shared: false, fork: side({ label: 'audit' }) },
  ],
};

/** What the MCP adapter answers when `bureau.runs.compare` faults: the fault as structured content. */
const NOT_A_FORK = {
  code: 'Unprocessable',
  message:
    'Run run-1 is not a fork, so there is no source to compare it with. Fork a run, then compare the fork.',
  data: { reason: 'not-a-fork' },
  retryable: false,
};

/** Opens the panel in the reference host, answering `bureau.runs.compare` as the fixture says. */
async function open(
  page: Page,
  scheme: Scheme,
  answer: 'fork' | 'not-a-fork',
  toolInput: Record<string, unknown> = { runId: FORK.runId },
): Promise<FrameLocator> {
  await page.route(`${HOST_ORIGIN}/`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: [
        '<!doctype html><title>Reference host</title>',
        '<style>html{color-scheme:light dark}body{margin:0}',
        'main.weft-shell-outlet{height:100vh;overflow:auto}',
        'iframe{display:block;width:100%;border:0}</style>',
        '<main class="weft-shell-outlet"><div id="host-outlet"></div></main>',
        `<script type="module">${hostScript}</script>`,
      ].join(''),
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
      hostContext: unknown;
      answer: 'fork' | 'not-a-fork';
      fork: unknown;
      fault: unknown;
    }
  >(
    async ({ html, csp, title, toolInput, hostContext, answer, fork, fault }) => {
      const host = window.referenceHost;
      host.rawHandlers['bureau.runs.compare'] = () =>
        answer === 'fork'
          ? {
              content: [{ type: 'text', text: JSON.stringify(fork) }],
              structuredContent: fork as Record<string, unknown>,
            }
          : {
              isError: true,
              content: [{ type: 'text', text: JSON.stringify(fault) }],
              structuredContent: fault as Record<string, unknown>,
            };
      await host.mount(html, csp, toolInput, title, hostContext as McpUiHostContext | undefined);
    },
    {
      html: pageHtml,
      csp: MCP_APP_UI_META.csp,
      title: TITLE,
      toolInput,
      hostContext: hostContextFor(scheme),
      answer,
      fork: FORK,
      fault: NOT_A_FORK,
    },
  );
  return page.frameLocator(`iframe[title="${TITLE}"]`);
}

/** Sizes the frame to what the panel draws, so a capture shows all of it and the outlet scrolls only past it. */
async function fitFrame(page: Page, app: FrameLocator): Promise<void> {
  const height = await app
    .locator('body')
    .evaluate((body) => Math.ceil(body.getBoundingClientRect().height));
  await page.evaluate(
    (pixels) => {
      const frame = document.querySelector('iframe');
      if (frame !== null) frame.style.height = `${String(pixels)}px`;
    },
    Math.max(height, 240),
  );
  await nextFrame(page);
}

/**
 * Captures the state the panel is in at each width, resizing in place. `ready` proves the state is
 * the one named, and runs again after every resize the helper makes, before the pixels are taken.
 * Does nothing outside a capture.
 */
async function captureState(
  page: Page,
  app: FrameLocator,
  state: string,
  ready: () => Promise<void>,
): Promise<void> {
  if (designReviewCaptureDirectory() === undefined) return;
  for (const size of SIZES) {
    await page.setViewportSize(size);
    await captureForDesignReview(page, {
      route: ROUTE,
      state,
      source: SOURCE,
      ready: async () => {
        await ready();
        await fitFrame(page, app);
      },
    });
  }
}

for (const scheme of RUN_SCHEMES) {
  test.describe(`run-comparison-states: ${scheme} host theme`, () => {
    test('ready: the shared steps collapsed and every kind of step the fork ran again', async ({
      page,
    }) => {
      const app = await open(page, scheme, 'fork');
      const ready = async () => {
        await expect(
          app.getByRole('heading', { level: 1, name: 'Run fork-1 compared with source-1' }),
        ).toBeVisible();
        await expect(
          app.getByRole('button', { name: '2 steps shared with the source' }),
        ).toHaveAttribute('aria-expanded', 'false');
        const kinds = ['changed', 'unchanged', 'source-only', 'fork-only'];
        for (const [position, kind] of kinds.entries()) {
          await expect(
            app.locator(`[data-compared-step="${String(position + 2)}"]`),
          ).toHaveAttribute('data-kind', kind);
        }
        await expect(app.getByText('Select a step')).toBeVisible();
      };
      await ready();
      await captureState(page, app, 'ready', ready);
    });

    test('shared-open: the steps the fork kept, listed', async ({ page }) => {
      const app = await open(page, scheme, 'fork');
      await app.getByRole('button', { name: '2 steps shared with the source' }).click();
      const ready = async () => {
        await expect(app.locator('[data-shared-step]')).toHaveCount(2);
      };
      await ready();
      await captureState(page, app, 'shared-open', ready);
    });

    test('step-selected: a changed step, its input the same and its output differing', async ({
      page,
    }) => {
      const app = await open(page, scheme, 'fork');
      await app.locator('[data-compared-step="2"]').click();
      const ready = async () => {
        await expect(app.locator('[data-compared-step="2"]')).toHaveAttribute(
          'aria-pressed',
          'true',
        );
        await expect(app.getByText('The input is the same in both runs.')).toBeVisible();
        const output = app.getByRole('group', { name: 'Output differences, step 3' });
        await expect(output).toBeVisible();
        await expect(
          output.locator('[data-cinder-diff-kind="changed"]').filter({ hasText: 'id' }),
        ).toContainText('1 → 2');
      };
      await ready();
      await captureState(page, app, 'step-selected', ready);
    });

    test('message: a run that is not a fork shows the server’s own words', async ({ page }) => {
      const app = await open(page, scheme, 'not-a-fork', { taskId: 'run-1' });
      const ready = async () => {
        await expect(app.locator('[data-comparison-message]')).toHaveText(NOT_A_FORK.message);
        await expect(app.locator('[data-compared-step]')).toHaveCount(0);
      };
      await ready();
      await captureState(page, app, 'message', ready);
    });
  });
}
