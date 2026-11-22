/**
 * The failure explanation panel in each state it draws, for the design review of COR-2543.
 * `scripts/design-review-capture.ts` screenshots pages, and the panel is not a page: it is a
 * document in a sandboxed frame inside a host. This specification mounts it the way
 * `failure-explanation.spec.ts` does (the built `ui://` page in the reference host, behind the
 * ext-apps `AppBridge`, the explain read answered from a fixture), reaches each state, and captures
 * it at 1280 (and 1920, which the helper repeats) and at 375 (and 320 by 640). Each capture is
 * named `failure-explanation--<state>` (the route and the state of `captureForDesignReview`).
 *
 * The reference host holds the frame in a `main.weft-shell-outlet`, as the shell holds a page, and
 * the frame is sized to what the panel draws. The panel follows the theme the host sends, which is
 * the run's color scheme. What the host answers is a fixture of what the Bureau answers, so the
 * panel is shown in states a person cannot cause on demand: a run with a guardrail that halted it,
 * a failure nothing classifies, a read held in flight, and a host that does not answer. The capture
 * runs only when `INTERBOROUGH_DESIGN_REVIEW_CAPTURE` is set; an ordinary run reaches each state and
 * checks it is the one named.
 */
import { failureExplanation } from '@lostgradient/plugin-inspectors';
import type { McpUiHostContext, McpUiResourceCsp } from '@modelcontextprotocol/ext-apps/app-bridge';
import { expect, test, type FrameLocator, type Page } from '@playwright/test';

import {
  designReviewCaptureDirectory,
  designReviewColorScheme,
} from '../../scripts/environment-configuration.ts';
import { buildPanelPage } from '../../src/host/panel-build.ts';
import { MCP_APP_UI_META } from '../../src/host/panel-mounts.ts';
import { captureForDesignReview, nextFrame } from '../e2e/design-review-capture.ts';
import {
  explained,
  FAILED_FIXTURE_RUN,
  NOT_FAILED_FAULT,
  UNCLASSIFIED_FIXTURE_RUN,
} from './failure-explanation-fixtures.ts';

const SOURCE = 'failure-explanation-states.spec.ts';
const ROUTE = 'failure-explanation';
const HOST_ORIGIN = 'http://reference-host.test';
const TITLE = failureExplanation.title;

/** The widths a state is captured at; the helper repeats 1280 at 1920 and 375 at 320 by 640. */
const SIZES = [
  { width: 1280, height: 900 },
  { width: 375, height: 812 },
] as const;

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

/** What a state changes about how the host opens the panel and answers its read. */
type Hooks = {
  /** The input the host gives the panel: a run's page names the run by its `taskId`. */
  readonly toolInput?: Record<string, unknown>;
  /** What the host answers the explain read with, as a whole tool result. */
  readonly answer?: unknown;
  /** The explain read is held in flight: the host never answers it. */
  readonly held?: boolean;
  /** The host does not answer the explain read at all: the call fails at the transport. */
  readonly unreachable?: boolean;
};

/** Loads the panel in the reference host, held in an outlet as the shell holds a page. */
async function open(page: Page, hooks: Hooks = {}): Promise<FrameLocator> {
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
      answer: unknown;
      held: boolean;
      unreachable: boolean;
      hostContext: unknown;
    }
  >(
    async ({ html, csp, title, toolInput, answer, held, unreachable, hostContext }) => {
      const host = window.referenceHost;
      host.rawHandlers['bureau.tasks.explain'] = held
        ? () => new Promise<never>(() => undefined)
        : async () => answer as never;
      if (unreachable) host.unreachable.push('bureau.tasks.explain');
      await host.mount(html, csp, toolInput, title, hostContext as McpUiHostContext | undefined);
    },
    {
      html: pageHtml,
      csp: MCP_APP_UI_META.csp,
      title: TITLE,
      toolInput: hooks.toolInput ?? { taskId: 'run-1' },
      answer: hooks.answer ?? explained(FAILED_FIXTURE_RUN),
      held: hooks.held ?? false,
      unreachable: hooks.unreachable ?? false,
      // The host's theme is the run's color scheme; no palette of its own, so the panel is Cinder's.
      hostContext: { theme: designReviewColorScheme() ?? 'light' } satisfies McpUiHostContext,
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
    Math.max(height, 160),
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

test.describe('failure-explanation-states', () => {
  test('explained: a failed run, with a guardrail that halted it', async ({ page }) => {
    const app = await open(page);
    const ready = async () => {
      await expect(app.getByText(FAILED_FIXTURE_RUN.summary)).toBeVisible();
      await expect(app.getByRole('region', { name: 'Guardrails' })).toBeVisible();
    };
    await ready();
    await captureState(page, app, 'explained', ready);
  });

  test('explained-unclassified: a failure nothing classifies, with no step, tries or guardrail', async ({
    page,
  }) => {
    const app = await open(page, { answer: explained(UNCLASSIFIED_FIXTURE_RUN) });
    const ready = async () => {
      await expect(app.getByText(UNCLASSIFIED_FIXTURE_RUN.summary)).toBeVisible();
      await expect(app.getByRole('region', { name: 'Details' })).toContainText('not classified');
      await expect(app.getByRole('region', { name: 'Guardrails' })).toHaveCount(0);
    };
    await ready();
    await captureState(page, app, 'explained-unclassified', ready);
  });

  test('not-failed: the run did not fail, so the Bureau’s own message is shown', async ({
    page,
  }) => {
    const app = await open(page, { answer: NOT_FAILED_FAULT });
    const ready = async () => {
      await expect(app.getByText(NOT_FAILED_FAULT.structuredContent.message)).toBeVisible();
      await expect(app.getByRole('region', { name: 'What to do next' })).toBeVisible();
    };
    await ready();
    await captureState(page, app, 'not-failed', ready);
  });

  test('reading: the explain read is in flight', async ({ page }) => {
    const app = await open(page, { held: true });
    const ready = async () => {
      await expect(app.getByText('Reading what the Bureau stored about run run-1.')).toBeVisible();
    };
    await ready();
    await captureState(page, app, 'reading', ready);
  });

  test('no-answer: the host did not answer the read', async ({ page }) => {
    const app = await open(page, { unreachable: true });
    const ready = async () => {
      await expect(app.getByText(/The host did not answer/)).toBeVisible();
    };
    await ready();
    await captureState(page, app, 'no-answer', ready);
  });

  test('no-run: the panel is opened with no run named', async ({ page }) => {
    const app = await open(page, { toolInput: {} });
    const ready = async () => {
      await expect(app.getByText('No run is named.')).toBeVisible();
    };
    await ready();
    await captureState(page, app, 'no-run', ready);
  });
});
