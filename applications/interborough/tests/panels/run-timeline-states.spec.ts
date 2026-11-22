/**
 * The run timeline panel in each state it draws, for the design review of COR-2542.
 * `scripts/design-review-capture.ts` screenshots pages, and the panel is not a page: it is a
 * document in a sandboxed frame inside a host. This specification mounts it the way
 * `run-timeline.spec.ts` does (the built `ui://` page in the reference host, behind the ext-apps
 * `AppBridge`), reaches each state the way a host causes it, and captures it at 1280 (and 1920,
 * which the helper repeats) and at 375 (and 320 by 640). Each capture is named
 * `run-timeline--<state>` (the route and the state of `captureForDesignReview`).
 *
 * The reference host holds the frame in a `main.weft-shell-outlet`, as the shell holds a page, and
 * the frame is sized to what the panel draws, so the helper's whole-page capture shows all of the
 * timeline and not a 300 by 150 window of it. The panel follows the theme the host sends, which is
 * the run's color scheme, so the capture in light and in dark is the workflow's two runs.
 *
 * The timeline read is answered from fixtures, as in `run-timeline.spec.ts`: the page is under
 * review, not the Bureau. What a person cannot cause on demand is answered at the host's edge: a
 * read held in flight (loading), a run the host cannot read (unreadable), a host that stops
 * answering and then answers again, and a host that gives the panel no server tools. The Chat
 * state is the panel opened as Chat opens it, with the agent tool's result, in JSON text, as the
 * result that opens the page. The capture runs only when `INTERBOROUGH_DESIGN_REVIEW_CAPTURE` is
 * set; an ordinary run reaches each state and checks it is the one named.
 */
import { runTimeline } from '@lostgradient/plugin-inspectors';
import type { McpUiHostContext, McpUiResourceCsp } from '@modelcontextprotocol/ext-apps/app-bridge';
import { expect, test, type FrameLocator, type Page } from '@playwright/test';

import {
  designReviewCaptureDirectory,
  designReviewColorScheme,
} from '../../scripts/environment-configuration.ts';
import { buildPanelPage } from '../../src/host/panel-build.ts';
import { MCP_APP_UI_META } from '../../src/host/panel-mounts.ts';
import { captureForDesignReview, nextFrame } from '../e2e/design-review-capture.ts';

const SOURCE = 'run-timeline-states.spec.ts';
const ROUTE = 'run-timeline';
const HOST_ORIGIN = 'http://reference-host.test';
const TITLE = runTimeline.title;

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
    entry: runTimeline.entry.href,
    title: runTimeline.title,
    styles: runTimeline.styles ?? '',
  });
  pageHtml = built.html;
});

// Steps start ten seconds apart and end well before now, so the last one of a running run is open.
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

/** The steps of a run that fetched, retried a failing step three times, timed out, and now waits. */
const MIXED_STEPS = [
  step({ step: 1, label: 'fetchPages', duration: 2_400 }),
  step({ step: 2, label: 'summarize', status: 'failed', duration: 1_100, tries: 3 }),
  step({ step: 3, label: 'sleep', operationType: 'sleep', status: 'timed-out', duration: 9_000 }),
  step({
    step: 4,
    label: 'await-signal',
    operationType: 'await-signal',
    status: 'running',
    duration: undefined,
  }),
];

/**
 * The steps of a run that went through without a failure and finished: its last entry is still
 * `running`, as the engine leaves one it waited in, so the page draws it as ended.
 */
const COMPLETED_STEPS = [
  step({ step: 1, label: 'fetchPages', duration: 2_400 }),
  step({ step: 2, label: 'summarize', duration: 1_100 }),
  step({ step: 3, label: 'publish', duration: 900 }),
  step({
    step: 4,
    label: 'await-signal',
    operationType: 'await-signal',
    status: 'running',
    duration: undefined,
  }),
];

const timeline = (overrides: Record<string, unknown> = {}) => ({
  runId: 'run-1',
  kind: 'workflow',
  runStatus: 'running',
  truncated: false,
  entries: MIXED_STEPS,
  ...overrides,
});

/** Marks a read that never answers: the host is still working on it. */
const HELD = (): unknown => undefined;

/** What a test changes about how the host opens the panel and answers its read. */
type Hooks = {
  /** The input the host gives the panel when it opens it. */
  readonly toolInput?: Record<string, unknown>;
  /** What the timeline read answers; a read that throws is a tool that answered with an error. */
  readonly answer?: () => unknown;
  /** The result that opens the page, as Chat hands it over. */
  readonly toolResult?: unknown;
  /** A host that gives the panel no server tools. */
  readonly withoutServerTools?: boolean;
};

/** Loads the panel in the reference host, in the run's color scheme. */
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
  // A read the test holds in flight stays held for as long as the page lives.
  await page.exposeFunction('answerTimeline', async () => hooks.answer?.() ?? timeline());
  await page.evaluate<
    void,
    {
      html: string;
      csp: McpUiResourceCsp;
      title: string;
      toolInput: Record<string, unknown>;
      toolResult: unknown;
      withoutServerTools: boolean;
      held: boolean;
      hostContext: unknown;
    }
  >(
    async ({ html, csp, title, toolInput, toolResult, withoutServerTools, held, hostContext }) => {
      const host = window.referenceHost;
      const answer = (window as unknown as Record<string, () => Promise<unknown>>)[
        'answerTimeline'
      ]!;
      host.handlers['bureau.runs.timeline'] = () => (held ? new Promise(() => {}) : answer());
      if (toolResult !== undefined) {
        host.toolResult = toolResult as NonNullable<typeof host.toolResult>;
      }
      host.withoutServerTools = withoutServerTools;
      await host.mount(html, csp, toolInput, title, hostContext as McpUiHostContext | undefined);
    },
    {
      html: pageHtml,
      csp: MCP_APP_UI_META.csp,
      title: TITLE,
      // The run page opens a panel with `taskId`; the timeline tool takes `runId`.
      toolInput: hooks.toolInput ?? { taskId: 'run-1' },
      toolResult: hooks.toolResult,
      withoutServerTools: hooks.withoutServerTools ?? false,
      held: hooks.answer === HELD,
      // The host's theme is the run's color scheme; no palette of its own, so the panel is Cinder's.
      hostContext: { theme: designReviewColorScheme() ?? 'light' } satisfies McpUiHostContext,
    },
  );
  return page.frameLocator(`iframe[title="${TITLE}"]`);
}

/** Sizes the frame to what the panel draws, so a capture shows all of the timeline and the outlet scrolls only past it. */
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

/** The steps' list, which every state with a timeline draws. */
const steps = (app: FrameLocator) =>
  app.getByRole('list', { name: /Steps of the run/ }).getByRole('listitem');

test.describe('run-timeline-states: reading a run', () => {
  test('loading: the first read has not answered', async ({ page }) => {
    const app = await open(page, { answer: HELD });
    const ready = async () => {
      await expect(app.getByRole('heading', { name: 'Loading the timeline' })).toBeVisible();
      await expect(app.getByRole('main')).toHaveCount(0);
    };
    await ready();
    await captureState(page, app, 'loading', ready);
  });

  test('mixed: succeeded, failed after three tries, timed out, and one still running', async ({
    page,
  }) => {
    const app = await open(page);
    const ready = async () => {
      await expect(steps(app)).toHaveCount(4);
      await expect(steps(app).nth(1)).toContainText('3 tries');
      await expect(steps(app).nth(3)).toContainText('Running');
      // The run's own badge, and the scale said once over the bars.
      await expect(app.getByLabel('Run status: running')).toBeVisible();
      await expect(app.getByRole('group', { name: /Time scale of the bars/ })).toBeVisible();
    };
    await ready();
    await captureState(page, app, 'mixed', ready);
  });

  test('finished: a step the engine left running is drawn as ended', async ({ page }) => {
    const app = await open(page, { answer: () => timeline({ runStatus: 'failed' }) });
    const ready = async () => {
      await expect(steps(app)).toHaveCount(4);
      await expect(steps(app).nth(3)).toContainText('Ended');
      await expect(steps(app).nth(3)).not.toContainText('Running');
      await expect(app.getByLabel('Run status: failed')).toBeVisible();
    };
    await ready();
    await captureState(page, app, 'finished', ready);
  });

  test('empty: the run has taken no steps yet', async ({ page }) => {
    const app = await open(page, { answer: () => timeline({ entries: [], runStatus: 'pending' }) });
    const ready = async () => {
      // One message, and no "Steps" heading over it saying the same thing.
      await expect(
        app.getByRole('heading', { name: 'This run has taken no steps yet' }),
      ).toBeVisible();
      // `exact`: a name matches as a substring otherwise, and "no steps yet" holds "steps".
      await expect(app.getByRole('heading', { name: 'Steps', exact: true })).toHaveCount(0);
      await expect(app.getByRole('list', { name: /Steps of the run/ })).toHaveCount(0);
    };
    await ready();
    await captureState(page, app, 'empty', ready);
  });

  test('truncated: the run has more steps than the read holds', async ({ page }) => {
    const app = await open(page, { answer: () => timeline({ truncated: true }) });
    const ready = async () => {
      await expect(steps(app)).toHaveCount(4);
      await expect(app.getByText('This run has more steps than the timeline holds.')).toBeVisible();
    };
    await ready();
    await captureState(page, app, 'truncated', ready);
  });

  test('unreadable: the host cannot read the run', async ({ page }) => {
    const app = await open(page, {
      answer: () => {
        throw new Error('NotFound');
      },
    });
    const ready = async () => {
      await expect(
        app.getByRole('heading', { name: 'This run’s timeline could not be read' }),
      ).toBeVisible();
      await expect(
        app.getByText('It may have been removed, or you may not have access to it.'),
      ).toBeVisible();
      await expect(app.getByRole('main')).toHaveCount(0);
    };
    await ready();
    await captureState(page, app, 'unreadable', ready);
  });
});

test.describe('run-timeline-states: the host and the connection', () => {
  test('connection-lost then reconnected: it keeps what it shows, then reads again', async ({
    page,
  }) => {
    const app = await open(page);
    await expect(steps(app)).toHaveCount(4);
    await page.evaluate(() => {
      delete window.referenceHost.handlers['bureau.runs.timeline'];
    });
    const lost = async () => {
      await expect(app.getByRole('status')).toHaveText('Connection lost. Retrying.');
      await expect(app.getByText('The steps and bars may be out of date.')).toBeVisible();
      await expect(steps(app)).toHaveCount(4);
    };
    await lost();
    await captureState(page, app, 'connection-lost', lost);

    await page.evaluate((answer) => {
      window.referenceHost.handlers['bureau.runs.timeline'] = () => answer;
    }, timeline());
    const back = async () => {
      await expect(app.getByRole('status')).toHaveText('Reconnected.');
      await expect(app.getByText('Reconnected. The timeline is up to date.')).toBeVisible();
      await expect(steps(app)).toHaveCount(4);
    };
    await back();
    await captureState(page, app, 'reconnected', back);
  });

  test('no-server-tools: the host does not let the panel read a run', async ({ page }) => {
    const app = await open(page, { withoutServerTools: true });
    const ready = async () => {
      await expect(
        app.getByRole('heading', { name: 'This host does not let the panel read a run' }),
      ).toBeVisible();
      await expect(app.getByRole('main')).toHaveCount(0);
    };
    await ready();
    await captureState(page, app, 'no-server-tools', ready);
  });

  test('from-chat: opened by the agent tool’s result, as Chat opens it', async ({ page }) => {
    // Chat hands the panel the call's arguments and the tool's result as JSON text.
    const app = await open(page, {
      toolInput: { runId: 'run-1' },
      toolResult: {
        content: [],
        structuredContent: JSON.stringify({
          status: 'ok',
          ...timeline({ runStatus: 'completed', entries: COMPLETED_STEPS }),
        }),
      },
      answer: () => timeline({ runStatus: 'completed', entries: COMPLETED_STEPS }),
    });
    const ready = async () => {
      await expect(steps(app)).toHaveCount(4);
      await expect(app.getByLabel('Run status: completed')).toBeVisible();
      await expect(steps(app).nth(3)).toContainText('Ended');
    };
    await ready();
    await captureState(page, app, 'from-chat', ready);
  });
});
