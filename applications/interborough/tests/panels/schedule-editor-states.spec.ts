/**
 * The schedule editor panel in each state it draws, for the design review of COR-2545.
 * `scripts/design-review-capture.ts` screenshots pages, and the panel is not a page: it is a
 * document in a sandboxed frame inside a host. This specification mounts it the way
 * `schedule-editor.spec.ts` does (the built `ui://` page in the reference host, behind the ext-apps
 * `AppBridge`, every tool call forwarded to the running end-to-end host's own panel route, so a
 * save reaches a real Bureau), reaches each state the way a person does, and captures it at 1280
 * (and 1920, which the helper repeats) and at 375 (and 320 by 640). Each capture is named
 * `schedule-editor--<state>` (the route and the state of `captureForDesignReview`).
 *
 * The reference host holds the frame in a `main.weft-shell-outlet`, as the shell holds a page, and
 * the frame is sized to what the panel draws, so the helper's whole-page capture shows all of the
 * form and not a 300 by 150 window of it. The panel follows the theme the host sends, which is the
 * run's color scheme.
 *
 * What the host answers is the real one wherever it can be: the schedules are made through the
 * Bureau, a refused save is the Bureau's own refusal, a stale save is a write another caller made
 * in between. What a person cannot cause on demand is answered at the panel route's edge, as the
 * other state specifications do: an empty list, a workflow schedule, the task a run's page names,
 * a call held in flight, a call that fails, and a host that does not answer. Every schedule here is
 * made through the Bureau and cancelled after the test, and nothing else is written. The capture
 * runs only when `INTERBOROUGH_DESIGN_REVIEW_CAPTURE` is set; an ordinary run reaches each state
 * and checks it is the one named.
 */
import { scheduleEditor } from '@lostgradient/plugin-inspectors';
import type { McpUiHostContext, McpUiResourceCsp } from '@modelcontextprotocol/ext-apps/app-bridge';
import {
  expect,
  test,
  type APIRequestContext,
  type FrameLocator,
  type Page,
} from '@playwright/test';

import {
  designReviewCaptureDirectory,
  designReviewColorScheme,
} from '../../scripts/environment-configuration.ts';
import { buildPanelPage } from '../../src/host/panel-build.ts';
import { MCP_APP_UI_META } from '../../src/host/panel-mounts.ts';
import { captureForDesignReview, nextFrame } from '../e2e/design-review-capture.ts';
import { E2E_BASE_URL } from '../e2e/e2e-constants.ts';
import { bureauCall } from '../e2e/task-support.ts';

const SOURCE = 'schedule-editor-states.spec.ts';
const ROUTE = 'schedule-editor';
const HOST_ORIGIN = 'http://reference-host.test';
const TITLE = scheduleEditor.title;
const PANEL_ROUTE = `${E2E_BASE_URL}/host/plugins/inspectors/apps/${scheduleEditor.name}/tool-calls`;
const AGENT = 'barrier';

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
    entry: scheduleEditor.entry.href,
    title: scheduleEditor.title,
    styles: scheduleEditor.styles ?? '',
  });
  pageHtml = built.html;
});

/** What the Bureau holds of a schedule: the view `bureau.schedules.get` answers. */
type Stored = {
  id: string;
  revision: number;
  status: string;
  description: string | null;
  intervalMs: number | null;
  cronExpression: string | null;
  target: { kind: string; agentName?: string };
};

/** Schedules this test made, cancelled when it ends. */
const made: string[] = [];

/** Calls held in flight, released when the test ends so none outlives it. */
const held: (() => void)[] = [];

test.afterEach(async ({ request }) => {
  for (const release of held.splice(0)) release();
  for (const id of made.splice(0)) {
    await bureauCall(request, 'bureau.schedules.cancel', { scheduleId: id }).catch(() => undefined);
  }
});

async function readBack(request: APIRequestContext, id: string): Promise<Stored> {
  return (await bureauCall(request, 'bureau.schedules.get', { scheduleId: id })) as Stored;
}

/** A schedule the panel did not make: it runs the first agent every hour, with a name a reader can tell. */
async function fixtureSchedule(
  request: APIRequestContext,
  description = 'Morning summary',
): Promise<string> {
  const view = (await bureauCall(request, 'bureau.schedules.create', {
    agentName: AGENT,
    spec: '1h',
    input: 'Say hello',
    description,
  })) as Stored;
  made.push(view.id);
  return view.id;
}

/** What a test changes about how the host answers the panel's calls. */
type Hooks = {
  /** The input the host gives the panel when it opens it: a schedule, or the task of a run's page. */
  readonly toolInput?: Record<string, unknown>;
  /** Tools that answer with an error, as a host does when the Bureau gives no answer. */
  readonly failing?: ReadonlySet<string>;
  /** Tools the host does not answer at all: the call fails at the transport. */
  readonly unreachable?: readonly string[];
  /** Done just before a call is answered, which can hold it in flight or change the schedule under it. */
  readonly before?: (name: string) => Promise<void>;
  /** What a tool answers instead of the Bureau, as the structured content of a result. */
  readonly answers?: Readonly<Record<string, (args: Record<string, unknown>) => unknown>>;
};

/**
 * Loads the editor in the reference host and forwards each call of the panel to the running host's
 * panel route, answering exactly what the route answers unless `hooks` say otherwise.
 */
async function open(page: Page, request: APIRequestContext, hooks: Hooks = {}) {
  const failing = hooks.failing ?? new Set<string>();
  await page.exposeFunction(
    'forwardToolCall',
    async (name: string, args: Record<string, unknown>) => {
      await hooks.before?.(name);
      if (failing.has(name)) return { isError: true, content: [{ type: 'text', text: 'failed' }] };
      const answer = hooks.answers?.[name];
      if (answer !== undefined) {
        const value = answer(args);
        return {
          content: [{ type: 'text', text: JSON.stringify(value) }],
          structuredContent: value,
        };
      }
      const response = await request.post(PANEL_ROUTE, { data: { name, arguments: args } });
      const body = (await response.json()) as Record<string, unknown>;
      // A route refusal carries no result; the panel is told it as an error, as a host would.
      const message = body['message'];
      return Array.isArray(body['content'])
        ? body
        : {
            isError: true,
            content: [{ type: 'text', text: typeof message === 'string' ? message : 'failed' }],
          };
    },
  );
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
      tools: readonly string[];
      unreachable: readonly string[];
      toolInput: Record<string, unknown>;
      hostContext: unknown;
    }
  >(
    async ({ html, csp, title, tools, unreachable, toolInput, hostContext }) => {
      const host = window.referenceHost;
      const forward = (window as unknown as Record<string, (...args: unknown[]) => Promise<never>>)[
        'forwardToolCall'
      ]!;
      for (const tool of tools) host.rawHandlers[tool] = (args) => forward(tool, args);
      host.unreachable.push(...unreachable);
      await host.mount(html, csp, toolInput, title, hostContext as McpUiHostContext | undefined);
    },
    {
      html: pageHtml,
      csp: MCP_APP_UI_META.csp,
      title: TITLE,
      tools: scheduleEditor.allowedTools,
      unreachable: hooks.unreachable ?? [],
      toolInput: hooks.toolInput ?? {},
      // The host's theme is the run's color scheme; no palette of its own, so the panel is Cinder's.
      hostContext: { theme: designReviewColorScheme() ?? 'light' } satisfies McpUiHostContext,
    },
  );
  return page.frameLocator(`iframe[title="${TITLE}"]`);
}

/** Sizes the frame to what the panel draws, so a capture shows all of the form and the outlet scrolls only past it. */
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

// The page's own status, not the live region a busy Button adds beside itself.
const status = (app: FrameLocator) =>
  app.locator('[role="status"]:not([data-cinder-button-status])');
const save = (app: FrameLocator) =>
  app.getByRole('button', { name: /^(Save changes|Create schedule)$/ });

/** A workflow schedule as `bureau.schedules.get` views it, which a Bureau with no workflow to schedule cannot give. */
const WORKFLOW_SCHEDULE = {
  id: 'schedule-of-a-workflow',
  owner: 'anonymous:local',
  agentName: null,
  target: { kind: 'workflow', workflowType: 'plugin:nightly-digest' },
  inputPreview: null,
  continuesChat: false,
  workflowType: 'plugin:nightly-digest',
  description: 'Nightly digest',
  cronExpression: '0 2 * * *',
  intervalMs: null,
  timeZone: 'Europe/Paris',
  status: 'active',
  overlap: 'skip',
  revision: 3,
  nextFireAt: null,
  skippedOccurrences: [],
  lastFireAt: null,
  missedFireCount: 0,
  skippedCount: 0,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  blocker: null,
};

test.describe('schedule-editor-states: the list of schedules', () => {
  test('list: every schedule the caller may change', async ({ page, request }) => {
    await fixtureSchedule(request, 'Morning summary');
    const second = await fixtureSchedule(request, 'Hourly check');
    await bureauCall(request, 'bureau.schedules.pause', { scheduleId: second });
    const app = await open(page, request);
    await expect(app.getByRole('button', { name: 'New schedule' })).toBeVisible();
    const ready = async () => {
      await expect(app.getByText('Morning summary, 1h')).toBeVisible();
      await expect(app.getByText('Hourly check, 1h (paused)')).toBeVisible();
    };
    await ready();
    await captureState(page, app, 'list', ready);
  });

  test('list-empty: there are no schedules', async ({ page, request }) => {
    const app = await open(page, request, {
      answers: { 'bureau.schedules.list': () => ({ schedules: [], nextOffset: null }) },
    });
    const ready = async () => {
      await expect(app.getByRole('heading', { name: 'No schedules yet' })).toBeVisible();
      // The empty state's one action makes a schedule: there is no second button beside it.
      await expect(app.getByRole('button', { name: 'New schedule' })).toHaveCount(1);
      // No status box is drawn while there is nothing to say.
      await expect(app.locator('.cinder-callout')).toHaveCount(0);
    };
    await ready();
    await captureState(page, app, 'list-empty', ready);
  });
});

test.describe('schedule-editor-states: one schedule', () => {
  test('open-agent: a schedule that runs an agent', async ({ page, request }) => {
    const id = await fixtureSchedule(request);
    const app = await open(page, request, { toolInput: { scheduleId: id } });
    const ready = async () => {
      await expect(app.getByLabel('When it runs')).toHaveValue('1h');
      await expect(app.getByLabel('Agent', { exact: true })).toHaveValue(AGENT);
      await expect(app.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    };
    await ready();
    await captureState(page, app, 'open-agent', ready);
  });

  test('open-workflow: a schedule that runs a workflow', async ({ page, request }) => {
    const app = await open(page, request, {
      toolInput: { scheduleId: WORKFLOW_SCHEDULE.id },
      answers: { 'bureau.schedules.get': () => WORKFLOW_SCHEDULE },
    });
    const ready = async () => {
      await expect(app.getByLabel('When it runs')).toHaveValue('0 2 * * *');
      await expect(app.getByLabel('Workflow', { exact: true })).toHaveValue(
        'plugin:nightly-digest',
      );
      await expect(app.getByLabel('Input for each run, as JSON')).toBeVisible();
    };
    await ready();
    await captureState(page, app, 'open-workflow', ready);
  });

  test('new-empty: a new schedule, with nothing chosen', async ({ page, request }) => {
    const app = await open(page, request);
    await app.getByRole('button', { name: 'New schedule' }).click();
    const ready = async () => {
      await expect(app.getByRole('button', { name: 'Create schedule' })).toBeVisible();
      await expect(app.getByLabel('When it runs')).toHaveValue('');
      await expect(app.getByLabel('Agent', { exact: true })).toHaveValue('');
    };
    await ready();
    await captureState(page, app, 'new-empty', ready);
  });

  test('canceled: a canceled schedule is read-only', async ({ page, request }) => {
    const id = await fixtureSchedule(request);
    await bureauCall(request, 'bureau.schedules.cancel', { scheduleId: id });
    const app = await open(page, request, { toolInput: { scheduleId: id } });
    const ready = async () => {
      // Said once, in the status, and not again above the form.
      await expect(
        app.getByText('This schedule was canceled, so it cannot be changed.'),
      ).toHaveCount(1);
      await expect(app.getByLabel('When it runs')).toBeDisabled();
      await expect(save(app)).toBeDisabled();
    };
    await ready();
    await captureState(page, app, 'canceled', ready);
  });

  test('from-run: opened from a run’s page with its task, which names the schedule', async ({
    page,
    request,
  }) => {
    const id = await fixtureSchedule(request);
    const app = await open(page, request, {
      toolInput: { taskId: 'task-a-schedule-started' },
      answers: {
        'bureau.tasks.get': () => ({
          id: 'task-a-schedule-started',
          origin: { kind: 'schedule', scheduleId: id, fireId: 'fire-1' },
        }),
      },
    });
    const ready = async () => {
      await expect(app.getByLabel('When it runs')).toHaveValue('1h');
      await expect(status(app)).toContainText('Changing');
    };
    await ready();
    await captureState(page, app, 'from-run', ready);
  });
});

test.describe('schedule-editor-states: a save', () => {
  test('field-errors: the Bureau refuses the cadence and the field says so', async ({
    page,
    request,
  }) => {
    const id = await fixtureSchedule(request);
    const app = await open(page, request, { toolInput: { scheduleId: id } });
    const when = app.getByLabel('When it runs');
    await expect(when).toHaveValue('1h');
    await when.fill('not a schedule');
    await save(app).click();
    const ready = async () => {
      await expect(when).toHaveAttribute('aria-invalid', 'true');
      // The Bureau's reason is on the field alone; the page only says to fix the fields.
      await expect(status(app)).toHaveText('Not saved. Fix the fields that show a problem.');
    };
    await ready();
    await captureState(page, app, 'field-errors', ready);
    const unchanged = await readBack(request, id);
    expect(unchanged.revision).toBe(1);
  });

  test('stale: another caller changed the schedule, so the form offers to read it again', async ({
    page,
    request,
  }) => {
    const id = await fixtureSchedule(request);
    let changed = false;
    const app = await open(page, request, {
      toolInput: { scheduleId: id },
      before: async (name) => {
        if (name !== 'bureau.schedules.update' || changed) return;
        changed = true;
        const current = await readBack(request, id);
        const changedElsewhere = (await bureauCall(request, 'bureau.schedules.update', {
          scheduleId: id,
          // An update replaces the cadence wholesale, so it is always sent: the one stored now.
          spec: current.cronExpression ?? `${String((current.intervalMs ?? 0) / 1000)}s`,
          description: 'Changed elsewhere',
          expectedRevision: current.revision,
        })) as { revision?: number };
        // The other caller's write must land, or the test proves nothing about the page.
        expect(changedElsewhere.revision).toBe(current.revision + 1);
      },
    });
    await expect(app.getByLabel('When it runs')).toHaveValue('1h');
    await app.getByLabel('When it runs').fill('2h');
    await save(app).click();
    const ready = async () => {
      await expect(app.getByRole('button', { name: 'Read it again' })).toBeVisible();
      await expect(status(app)).toContainText('The schedule changed since it was opened');
      await expect(save(app)).toBeDisabled();
    };
    await ready();
    await captureState(page, app, 'stale', ready);
  });

  test('saving: the save is in flight and nothing more is offered', async ({ page, request }) => {
    const id = await fixtureSchedule(request);
    const gate = Promise.withResolvers<void>();
    held.push(() => gate.resolve());
    const app = await open(page, request, {
      toolInput: { scheduleId: id },
      before: async (name) => {
        if (name === 'bureau.schedules.update') await gate.promise;
      },
    });
    await expect(app.getByLabel('When it runs')).toHaveValue('1h');
    await app.getByLabel('When it runs').fill('2h');
    await save(app).click();
    const ready = async () => {
      // The Save button announces the work and the page's own status stays empty, so the same
      // words are not read twice.
      await expect(app.locator('[data-cinder-button-status]')).toHaveText('Saving the changes…');
      await expect(status(app)).toHaveText('');
      await expect(save(app)).toHaveAttribute('aria-busy', 'true');
      await expect(save(app)).toBeDisabled();
      await expect(app.getByRole('button', { name: 'Back to schedules' })).toBeDisabled();
      await expect(app.getByLabel('When it runs')).toBeDisabled();
    };
    await ready();
    await captureState(page, app, 'saving', ready);
    gate.resolve();
    await expect(status(app)).toHaveText('Saved the changes.');
  });

  test('saved: the changes are written and the form shows the schedule as it is', async ({
    page,
    request,
  }) => {
    const id = await fixtureSchedule(request);
    const app = await open(page, request, { toolInput: { scheduleId: id } });
    await expect(app.getByLabel('When it runs')).toHaveValue('1h');
    await app.getByLabel('When it runs').fill('2h');
    await save(app).click();
    const ready = async () => {
      await expect(status(app)).toHaveText('Saved the changes.');
      await expect(app.getByLabel('When it runs')).toHaveValue('2h');
    };
    await ready();
    await captureState(page, app, 'saved', ready);
    const stored = await readBack(request, id);
    expect(stored.intervalMs).toBe(7_200_000);
  });

  test('half-saved: the cadence was written and the pause was refused', async ({
    page,
    request,
  }) => {
    const id = await fixtureSchedule(request);
    const app = await open(page, request, {
      toolInput: { scheduleId: id },
      failing: new Set(['bureau.schedules.pause']),
    });
    await expect(app.getByLabel('When it runs')).toHaveValue('1h');
    await app.getByLabel('When it runs').fill('2h');
    await app.getByRole('switch', { name: 'Paused' }).click();
    await save(app).click();
    const ready = async () => {
      // What landed and what did not, in the words of what was asked: never "not saved" beside "saved".
      await expect(status(app)).toHaveText('Saved the changes. Pausing it failed: Failed.');
    };
    await ready();
    await captureState(page, app, 'half-saved', ready);
    const stored = await readBack(request, id);
    expect(stored.intervalMs).toBe(7_200_000);
    expect(stored.status).toBe('active');
  });

  test('did-not-answer: the host never answered a create, so the form takes no second one', async ({
    page,
    request,
  }) => {
    const app = await open(page, request, { unreachable: ['bureau.schedules.create'] });
    await app.getByRole('button', { name: 'New schedule' }).click();
    await app.getByLabel('When it runs').fill('30m');
    await app.getByLabel('Agent', { exact: true }).selectOption(AGENT);
    await app.getByLabel('What each run sends the agent').fill('Report in');
    await save(app).click();
    const ready = async () => {
      await expect(status(app)).toContainText(
        'The host did not answer, so the schedule may or may not',
      );
      await expect(save(app)).toBeDisabled();
      // There is no schedule to read again, so the way on is the list.
      await expect(app.getByRole('button', { name: 'Read it again' })).toHaveCount(0);
      await expect(app.getByRole('button', { name: 'Back to schedules' })).toBeEnabled();
    };
    await ready();
    await captureState(page, app, 'did-not-answer', ready);
  });

  test('did-not-answer-update: the host never answered the pause after a written change', async ({
    page,
    request,
  }) => {
    const id = await fixtureSchedule(request);
    const app = await open(page, request, {
      toolInput: { scheduleId: id },
      unreachable: ['bureau.schedules.pause'],
    });
    await expect(app.getByLabel('When it runs')).toHaveValue('1h');
    await app.getByLabel('When it runs').fill('2h');
    await app.getByRole('switch', { name: 'Paused' }).click();
    await save(app).click();
    const ready = async () => {
      await expect(status(app)).toContainText('The host did not answer while pausing it.');
      await expect(status(app)).not.toContainText('bureau.');
    };
    await ready();
    await captureState(page, app, 'did-not-answer-update', ready);
  });
});
