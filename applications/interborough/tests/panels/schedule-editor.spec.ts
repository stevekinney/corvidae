/**
 * COR-2545 — the schedule editor, loaded the way an MCP Apps host loads it (the built `ui://` page in
 * a sandboxed frame under its deny-all policy, behind the ext-apps `AppBridge`), but answered by the
 * running end-to-end host instead of fixtures. Every tool call the page makes is forwarded to the
 * host's own panel route, so each save goes through `hostOnlyTools` into a real Bureau, and each
 * result is read back from that Bureau with a call of its own: the spec proves the panel and what
 * it wrote, not a double.
 *
 * Every schedule here is made through the Bureau and cancelled after the test.
 */
import { default as Axe } from '@axe-core/playwright';
import { scheduleEditor } from '@lostgradient/plugin-inspectors';
import type { McpUiHostContext, McpUiResourceCsp } from '@modelcontextprotocol/ext-apps/app-bridge';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { buildPanelPage } from '../../src/host/panel-build.ts';
import { MCP_APP_UI_META } from '../../src/host/panel-mounts.ts';
import { E2E_BASE_URL } from '../e2e/e2e-constants.ts';
import { bureauCall } from '../e2e/task-support.ts';
import { expectFollowsHost, hostContextFor, SCHEMES, type Scheme } from './host-theme.ts';

const HOST_ORIGIN = 'http://reference-host.test';
const TITLE = scheduleEditor.title;
const PANEL_ROUTE = `${E2E_BASE_URL}/host/plugins/inspectors/apps/${scheduleEditor.name}/tool-calls`;
const FIRST_AGENT = 'barrier';
const SECOND_AGENT = 'demo:assistant';

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

/** What the Bureau holds of schedule `id`: the view `bureau.schedules.get` answers. */
type Stored = {
  id: string;
  revision: number;
  status: string;
  description: string | null;
  intervalMs: number | null;
  cronExpression: string | null;
  target: { kind: string; agentName?: string };
};

const made: string[] = [];

async function readBack(request: APIRequestContext, id: string): Promise<Stored> {
  return (await bureauCall(request, 'bureau.schedules.get', { scheduleId: id })) as Stored;
}

/** A schedule the panel did not make, to change: every hour, running the first agent. */
async function fixtureSchedule(request: APIRequestContext): Promise<string> {
  const view = (await bureauCall(request, 'bureau.schedules.create', {
    agentName: FIRST_AGENT,
    spec: '1h',
    input: 'Say hello',
    description: `Panel fixture ${String(Date.now())}`,
  })) as Stored;
  made.push(view.id);
  return view.id;
}

test.afterEach(async ({ request }) => {
  for (const id of made.splice(0)) {
    await bureauCall(request, 'bureau.schedules.cancel', { scheduleId: id }).catch(() => undefined);
  }
});

/**
 * Loads the editor in the reference host, with every tool call forwarded to the running host's panel
 * route as the panel itself would reach it, and answered with exactly what the route answered.
 */
async function open(
  page: Page,
  request: APIRequestContext,
  toolInput: Record<string, unknown>,
  scheme?: Scheme,
  failing: ReadonlySet<string> = new Set(),
  before: (name: string) => Promise<void> = async () => undefined,
) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.exposeFunction(
    'forwardToolCall',
    async (name: string, args: Record<string, unknown>) => {
      // Whatever another caller does just before this call is answered, done first.
      await before(name);
      // A tool this test makes fail answers as a host does when the Bureau gives no answer.
      if (failing.has(name)) return { isError: true, content: [{ type: 'text', text: 'failed' }] };
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
      tools: readonly string[];
      toolInput: Record<string, unknown>;
      hostContext: unknown;
    }
  >(
    async ({ html, csp, title, tools, toolInput: input, hostContext }) => {
      const host = window.referenceHost;
      const forward = (window as unknown as Record<string, (...args: unknown[]) => Promise<never>>)[
        'forwardToolCall'
      ]!;
      for (const tool of tools) host.rawHandlers[tool] = (args) => forward(tool, args);
      await host.mount(html, csp, input, title, hostContext as McpUiHostContext | undefined);
    },
    {
      html: pageHtml,
      csp: MCP_APP_UI_META.csp,
      title: TITLE,
      tools: scheduleEditor.allowedTools,
      toolInput,
      hostContext: scheme === undefined ? undefined : hostContextFor(scheme),
    },
  );
  return { errors, app: page.frameLocator(`iframe[title="${TITLE}"]`) };
}

test.describe('the schedule editor MCP App against the running host', () => {
  test('changes when it runs, which agent it runs and whether it is paused, reading each back from the Bureau', async ({
    page,
    request,
  }) => {
    const id = await fixtureSchedule(request);
    const { app, errors } = await open(page, request, { scheduleId: id });
    const when = app.getByLabel('When it runs');
    await expect(when).toHaveValue('1h');

    // When it runs.
    await when.fill('2h');
    await app.getByRole('button', { name: 'Save changes' }).click();
    await expect(app.getByRole('status')).toHaveText('Saved the changes.');
    const afterWhen = await readBack(request, id);
    expect(afterWhen.intervalMs).toBe(7_200_000);
    expect(afterWhen.revision).toBe(2);

    // Which agent it runs, with the cadence it has resent and the text it sends kept.
    await app.getByLabel('Agent', { exact: true }).selectOption(SECOND_AGENT);
    await app.getByRole('button', { name: 'Save changes' }).click();
    await expect(app.getByRole('status')).toHaveText('Saved the changes.');
    const afterAgent = await readBack(request, id);
    expect(afterAgent.target).toEqual({ kind: 'agent', agentName: SECOND_AGENT });
    expect(afterAgent.intervalMs).toBe(7_200_000);
    expect(afterAgent.revision).toBe(3);

    // Whether it is paused: a pause of its own, fenced by the revision the page read.
    await app.getByRole('switch', { name: 'Paused' }).click();
    await app.getByRole('button', { name: 'Save changes' }).click();
    await expect(app.getByRole('status')).toHaveText('Saved the changes.');
    const afterPause = await readBack(request, id);
    expect(afterPause.status).toBe('paused');
    expect(afterPause.revision).toBe(4);
    await expect(app.getByRole('switch', { name: 'Paused' })).toBeChecked();
    expect(errors).toEqual([]);
  });

  test('rebuilds the form from what a half-finished save left, so it never writes back over another caller', async ({
    page,
    request,
  }) => {
    const id = await fixtureSchedule(request);
    // Between the page's update and its pause, another caller changes the description; the pause
    // then gets no answer, so the page reads the schedule again.
    const { app } = await open(
      page,
      request,
      { scheduleId: id },
      undefined,
      new Set(['bureau.schedules.pause']),
      async (name) => {
        if (name !== 'bureau.schedules.pause') return;
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
    );
    await expect(app.getByLabel('When it runs')).toHaveValue('1h');
    await app.getByLabel('When it runs').fill('2h');
    await app.getByRole('switch', { name: 'Paused' }).click();
    await app.getByRole('button', { name: 'Save changes' }).click();
    await expect(app.getByLabel('Description')).toHaveValue('Changed elsewhere');
    await expect(app.getByLabel('When it runs')).toHaveValue('2h');

    // Saving again sends nothing that would undo the other caller's description.
    await app.getByRole('button', { name: 'Save changes' }).click();
    const stored = await readBack(request, id);
    expect(stored.description).toBe('Changed elsewhere');
    expect(stored.intervalMs).toBe(7_200_000);
  });

  test('makes a new schedule with the same fields and reads it back from the Bureau', async ({
    page,
    request,
  }) => {
    const description = `Panel made ${String(Date.now())}`;
    const { app, errors } = await open(page, request, {});
    await app.getByRole('button', { name: 'New schedule' }).click();
    await app.getByLabel('When it runs').fill('30m');
    await app.getByLabel('Agent', { exact: true }).selectOption(FIRST_AGENT);
    await app.getByLabel('What each run sends the agent').fill('Report in');
    await app.getByLabel('Description').fill(description);
    await app.getByRole('button', { name: 'Create schedule' }).click();
    await expect(app.getByRole('status')).toHaveText('Created the schedule.');

    const listed = (await bureauCall(request, 'bureau.schedules.list', { limit: 100 })) as {
      schedules: Stored[];
    };
    const stored = listed.schedules.find((schedule) => schedule.description === description);
    expect(stored).toBeDefined();
    made.push(stored!.id);
    expect(stored).toMatchObject({
      intervalMs: 1_800_000,
      status: 'active',
      target: { kind: 'agent', agentName: FIRST_AGENT },
    });
    // The form now shows the schedule as the Bureau holds it.
    await expect(app.getByLabel('When it runs')).toHaveValue('30m');
    expect(errors).toEqual([]);
  });

  test('takes no second save after a create it cannot read back, so it never makes the schedule twice', async ({
    page,
    request,
  }) => {
    const description = `Panel unread ${String(Date.now())}`;
    const { app } = await open(page, request, {}, undefined, new Set(['bureau.schedules.get']));
    await app.getByRole('button', { name: 'New schedule' }).click();
    await app.getByLabel('When it runs').fill('30m');
    await app.getByLabel('Agent', { exact: true }).selectOption(FIRST_AGENT);
    await app.getByLabel('What each run sends the agent').fill('Report in');
    await app.getByLabel('Description').fill(description);
    await app.getByRole('button', { name: 'Create schedule' }).click();
    await expect(app.getByRole('status')).toContainText('could not be read again');
    await app.getByRole('button', { name: 'Create schedule' }).click({ force: true });

    const listed = (await bureauCall(request, 'bureau.schedules.list', { limit: 100 })) as {
      schedules: Stored[];
    };
    const mine = listed.schedules.filter((schedule) => schedule.description === description);
    made.push(...mine.map((schedule) => schedule.id));
    expect(mine).toHaveLength(1);
  });

  test('shows the Bureau’s error on the field that caused it, and writes nothing', async ({
    page,
    request,
  }) => {
    const id = await fixtureSchedule(request);
    const refusal = await request.post(`${E2E_BASE_URL}/bureau/jsonrpc`, {
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'bureau.schedules.update',
        params: { scheduleId: id, spec: 'not a schedule' },
      },
    });
    const refused = (await refusal.json()) as { error?: { message?: string } };
    const message = refused.error?.message ?? '';
    expect(message).not.toBe('');

    const { app } = await open(page, request, { scheduleId: id });
    const when = app.getByLabel('When it runs');
    await expect(when).toHaveValue('1h');
    await when.fill('not a schedule');
    await app.getByRole('button', { name: 'Save changes' }).click();

    await expect(when).toHaveAttribute('aria-invalid', 'true');
    await expect(when).toHaveAccessibleDescription(new RegExp(escapeForPattern(message)));
    // The error is the cadence field's alone.
    await expect(app.getByLabel('Description')).not.toHaveAttribute('aria-invalid', 'true');
    await expect(app.getByRole('status')).toContainText('Not saved');
    const unchanged = await readBack(request, id);
    expect(unchanged.revision).toBe(1);
  });

  for (const scheme of SCHEMES) {
    test(`follows the host's ${scheme} theme and has no axe violations in it`, async ({
      page,
      request,
    }) => {
      const id = await fixtureSchedule(request);
      await page.emulateMedia({ colorScheme: scheme === 'dark' ? 'light' : 'dark' });
      const { app } = await open(page, request, { scheduleId: id }, scheme);
      await expect(app.getByLabel('When it runs')).toHaveValue('1h');
      await expectFollowsHost(app, scheme);
      const results = await new Axe({ page }).include('iframe').analyze();
      expect(results.violations.filter((violation) => violation.impact !== 'minor')).toEqual([]);
    });
  }
});

/** `text` as a pattern that matches exactly it. */
function escapeForPattern(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
