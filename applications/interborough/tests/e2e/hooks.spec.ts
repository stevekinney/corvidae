/**
 * `/hooks` (COR-1858): a hook is made in the editor from an event chosen in the searchable picker,
 * an address and a signing secret, and it fires: a test event reaches a receiver the spec runs,
 * signed, and a real event (a chat starting) reaches it too, and both deliveries show beside the
 * editor. The list reads each hook as a sentence, puts a failing hook first, and turns a hook off
 * with its switch. Hooks is in the sidebar, and `g` then `h` opens it. The pages pass axe at the
 * two widths. A hook limited to an agent in Only for fires for that agent and not another
 * (COR-1978), and is listed on that agent's Hooks tab.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { APIRequestContext, Page } from '@playwright/test';

import { HOOKS_COPY } from '../../src/routes/hooks/hook-copy.ts';
import { deleteChats, newThreadId, runToEnd } from './chat-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';
import { bureauCall } from './task-support.ts';
import { TEXT_ECHO_AGENT_NAME } from './text-echo-agent.ts';

const WIDTHS = [375, 1280] as const;
const SECRET = 'e2e-hooks-signing-secret-0123456789';
/** Every hook this spec makes carries the prefix, so cleanup removes those and no other. */
const PREFIX = 'e2e-hooks';

const copy = HOOKS_COPY.editor;

type Received = { headers: Record<string, string | string[] | undefined>; body: string };

/** A receiver on the host's loopback that answers `200` and keeps what it was sent. */
let receiver: Server;
let receiverUrl = '';
const received: Received[] = [];
const waiters: (() => void)[] = [];

test.beforeAll(async () => {
  receiver = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(200).end('ok');
      for (const wake of waiters.splice(0)) wake();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${String((receiver.address() as AddressInfo).port)}/receive`;
});

test.afterAll(async ({ playwright }) => {
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
  const request = await playwright.request.newContext();
  try {
    await removeHooks(request);
  } finally {
    await request.dispose();
  }
});

/** Waits for a request to the receiver whose body names `kind`, and returns it. */
async function requestOfKind(kind: string): Promise<Received> {
  for (;;) {
    const found = received.find(
      (entry) => (JSON.parse(entry.body) as { kind: string }).kind === kind,
    );
    if (found !== undefined) return found;
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
}

async function removeHooks(request: APIRequestContext): Promise<void> {
  const listed = (await bureauCall(request, 'bureau.hooks.list', {})) as {
    hooks: { id: string; name: string | null }[];
  };
  for (const hook of listed.hooks) {
    if (hook.name?.startsWith(PREFIX) === true) {
      await bureauCall(request, 'bureau.hooks.delete', { hookId: hook.id });
    }
  }
}

/** Chooses an event in the picker by searching for it. */
async function chooseEvent(page: Page, search: string, name: string): Promise<void> {
  const picker = page.getByRole('combobox', { name: copy.event.label });
  await picker.click();
  await picker.fill(search);
  await page.getByRole('option', { name }).click();
  await expect(page.locator('[data-event]')).toContainText(name);
}

async function fillWebhook(page: Page, url: string, name: string): Promise<void> {
  await page.getByLabel(copy.webhook.urlLabel).fill(url);
  await page.getByLabel(copy.check.nameLabel).fill(name);
}

test('makes a hook in the editor, sends a test event to a receiver, and shows the delivery', async ({
  page,
  checkA11y,
}) => {
  const name = `${PREFIX} test event`;
  await page.goto('/hooks/new');
  await expect(page.getByRole('heading', { level: 1, name: copy.newTitle })).toBeVisible();
  await checkA11y('hooks — the new hook editor');

  await chooseEvent(page, 'review', 'A review is waiting');
  await fillWebhook(page, receiverUrl, name);
  await expect(page.getByTestId('hook-check-summary')).toContainText('A review is waiting');
  await page.getByRole('button', { name: copy.check.create }).click();

  // The hook is made and its page opens, where the delivery log is beside the steps.
  await expect(page).toHaveURL(/\/hooks\/(?!new$)[^/?]+$/);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  const deliveries = page.getByTestId('hook-deliveries');
  await expect(deliveries.getByText(copy.deliveries.none.title)).toBeVisible();
  // The secret the Bureau made is shown once, on this page, with the note that it cannot be seen again.
  await expect(page.getByTestId('hook-secret')).toContainText(copy.webhook.secretOnce);

  await page.getByRole('button', { name: copy.check.test }).click();
  await expect(page.getByTestId('hook-test-result')).toContainText('Test event sent.');

  const sent = await requestOfKind('hook.test');
  expect(sent.headers['x-signature']).toMatch(/^t=\d+,v1=[0-9a-f]+$/);
  expect(JSON.parse(sent.body)).toMatchObject({ kind: 'hook.test', test: true });
  await expect(deliveries.getByText(copy.deliveries.testEvent)).toBeVisible();
  await expect(deliveries).toContainText('Delivered, 200 OK');
  await checkA11y('hooks — the editor with a delivery');
});

test('fires for a real event, and shows that delivery beside the test', async ({
  page,
  request,
}) => {
  const name = `${PREFIX} real event`;
  await page.goto('/hooks/new');
  await chooseEvent(page, 'chat created', 'A chat starts');
  await fillWebhook(page, receiverUrl, name);
  await page.getByRole('button', { name: copy.check.create }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

  const thread = newThreadId('hooks');
  try {
    await runToEnd(request, TEXT_ECHO_AGENT_NAME, thread, 'Say something');
    const fired = await requestOfKind('session.created');
    expect(fired.headers['x-signature']).toMatch(/^t=\d+,v1=[0-9a-f]+$/);

    await page.reload();
    const deliveries = page.getByTestId('hook-deliveries');
    await expect(deliveries.getByText('A chat starts')).toBeVisible();
    await expect(deliveries).toContainText('Delivered, 200 OK');
  } finally {
    await deleteChats([thread]);
  }
});

test('limits a hook to one agent with Only for: it fires for that agent, and its tab lists it', async ({
  page,
  request,
}) => {
  const name = `${PREFIX} only for`;
  const other = await bureauCall(request, 'bureau.hooks.create', {
    name: `${PREFIX} only for another`,
    events: ['session.created'],
    scope: { kind: 'agent', id: 'an-agent-that-never-runs' },
    action: { type: 'notify' },
  });
  await page.goto('/hooks/new');
  await chooseEvent(page, 'chat created', 'A chat starts');
  await page.getByLabel(copy.onlyFor.label).selectOption('agent');
  const subject = page.getByLabel(copy.onlyFor.subject.agent, { exact: true });
  await expect(subject.locator(`option[value="${TEXT_ECHO_AGENT_NAME}"]`)).toBeAttached();
  await subject.selectOption(TEXT_ECHO_AGENT_NAME);
  await page.getByLabel(copy.webhook.urlLabel).fill(receiverUrl);
  await page.getByLabel(copy.check.nameLabel).fill(name);
  await page.getByRole('button', { name: copy.check.create }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await expect(page.getByTestId('hook-sentence')).toContainText('for the agent');

  const thread = newThreadId('hooks-only-for');
  try {
    await runToEnd(request, TEXT_ECHO_AGENT_NAME, thread, 'Say something');
    await page.goto(`/agents/${TEXT_ECHO_AGENT_NAME}/hooks`);
    const row = page.getByTestId('agent-hooks').locator('li[data-hook]', { hasText: name });
    await expect(row.locator('[data-status-word="Delivered"]')).toBeVisible();

    const { deliveries } = (await bureauCall(request, 'bureau.hooks.deliveries', {
      hookId: (other as { id: string }).id,
    })) as { deliveries: unknown[] };
    expect(deliveries).toEqual([]);
  } finally {
    await deleteChats([thread]);
  }
});

test('lists a failing hook first, reads each hook as a sentence, and turns one off with its switch', async ({
  page,
  request,
}) => {
  const good = (await bureauCall(request, 'bureau.hooks.create', {
    name: `${PREFIX} good`,
    events: ['review.requested'],
    action: { type: 'webhook', url: receiverUrl },
    signingSecret: SECRET,
  })) as { id: string };
  await bureauCall(request, 'bureau.hooks.test', { hookId: good.id });
  const broken = (await bureauCall(request, 'bureau.hooks.create', {
    name: `${PREFIX} broken`,
    events: ['goal.failed', 'goal.canceled'],
    // Nothing listens at the discard port, so the test delivery fails.
    action: { type: 'webhook', url: 'http://127.0.0.1:9/receive' },
    signingSecret: SECRET,
  })) as { id: string };
  await bureauCall(request, 'bureau.hooks.test', { hookId: broken.id });

  await page.goto('/hooks');
  await expect(page.locator('[data-view="hooks"]')).toHaveAttribute('data-state', 'ready');
  const brokenRow = page.locator(`li[data-hook="${broken.id}"]`);
  const goodRow = page.locator(`li[data-hook="${good.id}"]`);
  // A delivery that ended without reaching its end reads Failed, or Gave up once it spent its tries.
  await expect(brokenRow.locator('[data-status-word]')).toHaveAttribute(
    'data-status-word',
    /^(Failed|Gave up)$/,
  );
  await expect(goodRow.locator('[data-status-word="Delivered"]')).toBeVisible();
  // The failing hook comes before the one that delivered, though it was made after it.
  const order = await page
    .locator('li[data-hook]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-hook')));
  expect(order.indexOf(broken.id)).toBeLessThan(order.indexOf(good.id));
  // The hook's name is its title and its link; line two reads the hook as a sentence.
  await expect(brokenRow.getByRole('link', { name: `${PREFIX} broken` })).toBeVisible();
  await expect(brokenRow).toContainText(
    'When a goal fails or a goal is canceled, send a webhook to 127.0.0.1:9',
  );

  const toggle = goodRow.getByRole('switch');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await page.reload();
  await expect(page.locator(`li[data-hook="${good.id}"]`).getByRole('switch')).toHaveAttribute(
    'aria-checked',
    'false',
  );
});

for (const width of WIDTHS) {
  test(`lists the hooks at ${width} pixels, searches them, and passes axe`, async ({
    page,
    request,
    checkA11y,
  }) => {
    const hook = (await bureauCall(request, 'bureau.hooks.create', {
      name: `${PREFIX} listed ${String(width)}`,
      events: ['schedule.missed'],
      action: { type: 'notify', title: 'A fire was missed' },
    })) as { id: string };
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/hooks');

    await expect(page.locator('[data-view="hooks"]')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator(`li[data-hook="${hook.id}"]`)).toContainText(
      'When a schedule misses a run, notify me',
    );
    await page.getByRole('searchbox', { name: HOOKS_COPY.searchLabel }).fill('schedule missed');
    await expect(page.locator(`li[data-hook="${hook.id}"]`)).toBeVisible();
    await page.getByRole('searchbox', { name: HOOKS_COPY.searchLabel }).fill('no hook says this');
    await expect(
      page.getByRole('heading', { level: 2, name: HOOKS_COPY.list.noMatch.title }),
    ).toBeVisible();
    await page.getByRole('button', { name: HOOKS_COPY.clearAction }).click();
    await expect(page.locator(`li[data-hook="${hook.id}"]`)).toBeVisible();
    await checkA11y(`hooks — the list at ${width}px`);
  });
}

test('searches every event in the picker by its words, its kind, and its area', async ({
  page,
}) => {
  await page.goto('/hooks/new');
  const picker = page.getByRole('combobox', { name: copy.event.label });
  await picker.click();
  // The Bureau describes more than fifty events, and the picker offers each of them.
  await expect(page.locator('[role="option"]').nth(50)).toBeAttached();
  for (const [search, name] of [
    ['attempt evaluating', 'Goal attempt evaluating'],
    ['schedule.missed', 'A schedule misses a run'],
    ['memory', 'Memory governance'],
  ] as const) {
    await picker.fill(search);
    await expect(page.getByRole('option', { name })).toBeVisible();
  }
});

test('opens from the sidebar and from g then h', async ({ page }) => {
  await page.goto('/chats');
  await page
    .getByRole('navigation', { name: 'Views' })
    .getByRole('link', { name: 'Hooks' })
    .click();
  await expect(page).toHaveURL(/\/hooks$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Hooks' })).toBeVisible();

  await page.goto('/chats');
  await page.getByRole('heading', { level: 1 }).first().waitFor();
  await page.keyboard.press('g');
  await page.keyboard.press('k');
  await expect(page).toHaveURL(/\/hooks$/);
});

// ─── Default hooks and plugin hooks (COR-2181, rows R10-01 to R10-25) ───────────────────────────────
//
// Each state is drawn from answers the spec gives the page: the Bureau's hooks and contributions and
// the host's plugins are stubbed, so a default hook, a disabled plugin and a plugin that needs a
// secret exist without a plugin of their own. Every request the pages make that is not stubbed
// (the event catalog, the agents) goes to the real host. A state is named in brackets in its title,
// so `--grep "\[default-hooks\]"` runs one.

const SOURCE = 'hooks.spec.ts';
const BUREAU_CALLS = '**/bureau/jsonrpc';
const header = HOOKS_COPY.editor.header;
const defaults = HOOKS_COPY.defaultHook;
const standing = HOOKS_COPY.standing;

type Fault = { readonly status: number; readonly message: string; readonly data?: object };
type Answer = (params: Record<string, unknown>) => unknown;
type Call = { readonly method: string; readonly params: Record<string, unknown> };

/** Answers each Bureau method named, records the calls, and sends every other method on to the host. */
async function serveBureau(
  page: Page,
  answers: Readonly<Record<string, Answer | Fault>>,
): Promise<Call[]> {
  const calls: Call[] = [];
  await page.route(BUREAU_CALLS, async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      id: unknown;
      method?: string;
      params?: Record<string, unknown>;
    };
    const answer = body.method === undefined ? undefined : answers[body.method];
    if (answer === undefined || body.method === undefined) {
      await route.fallback();
      return;
    }
    calls.push({ method: body.method, params: body.params ?? {} });
    if (typeof answer !== 'function') {
      await route.fulfill({
        status: answer.status,
        json: {
          jsonrpc: '2.0',
          id: body.id,
          error: {
            code: -32000,
            message: answer.message,
            data: { weftCode: 'InvalidParams', httpStatus: answer.status, ...answer.data },
          },
        },
      });
      return;
    }
    await route.fulfill({
      json: { jsonrpc: '2.0', id: body.id, result: answer(body.params ?? {}) },
    });
  });
  return calls;
}

type SecretState = { key: string; set: boolean };

/** A plugin as `GET /host/plugins` lists it, with the fields the page reads. */
function pluginStanding(
  name: string,
  title: string,
  status: 'running' | 'needs-setup' | 'disabled',
  secrets: readonly SecretState[] = [],
) {
  return {
    descriptor: {
      name,
      title,
      version: '1.0.0',
      description: `${title} adds hooks.`,
      required: false,
      enabledByDefault: true,
    },
    source: 'package',
    location: `@example/${name}`,
    status,
    problems: [],
    contributions: [],
    enabled: status !== 'disabled',
    configuration: {},
    configurationSchema: null,
    running: { enabled: status !== 'disabled', configuration: {} },
    secrets: secrets.map(({ key, set }) => ({
      key,
      generated: false,
      set,
      location: `/home/secrets/${key}`,
    })),
    restartRequired: false,
  };
}

/** Answers `GET /host/plugins` with the plugins `read()` returns, and `PUT` of a secret with `onSecret`. */
async function serveHost(
  page: Page,
  read: () => readonly ReturnType<typeof pluginStanding>[] | Fault,
  onSecret: (plugin: string, key: string) => void = () => undefined,
): Promise<void> {
  await page.route('**/host/plugins', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    const answer = read();
    if (!Array.isArray(answer)) {
      await route.fulfill({ status: (answer as Fault).status, json: { error: 'The host broke.' } });
      return;
    }
    await route.fulfill({
      json: { configurationRevision: 'revision-1', plugins: answer, unloaded: [] },
    });
  });
  await page.route('**/host/plugins/*/secrets/*', async (route) => {
    const [, plugin = '', , key = ''] = new URL(route.request().url()).pathname
      .replace('/host/plugins/', '/')
      .split('/');
    onSecret(decodeURIComponent(plugin), decodeURIComponent(key));
    await route.fulfill({ status: 200, json: {} });
  });
}

const SLACK_TOKEN_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    channel: { type: 'string', title: 'Channel' },
    token: { type: 'string', title: 'Token', secret: true },
  },
  required: ['channel', 'token'],
};

function reaction(
  plugin: string,
  kind: string,
  over: { availability?: 'available' | 'needs-setup'; dryRun?: boolean } = {},
) {
  return {
    plugin,
    kind,
    description: `${kind} does it.`,
    version: '1',
    dryRun: over.dryRun ?? true,
    availability: over.availability ?? 'available',
    configuration: SLACK_TOKEN_SCHEMA,
  };
}

/** `bureau.plugins.contributions` with the reactions of the plugins that are on. */
function contributions(...reactions: ReturnType<typeof reaction>[]) {
  return () => ({ providers: [], triggers: [], reactions });
}

/** A hook as `bureau.hooks.get` and `bureau.hooks.list` answer it. */
function hookRecord(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    owner: 'anonymous:local',
    name: id,
    action: {
      type: 'plugin',
      plugin: 'slack',
      kind: 'post-message',
      configuration: { channel: 'ops', token: { $secret: 'slack-bot-token' } },
    },
    events: ['review.requested'],
    scope: null,
    declaredBy: { plugin: 'slack', ownerDisabled: false, withdrawn: false },
    enabled: true,
    createdAt: Date.UTC(2026, 10, 1),
    updatedAt: Date.UTC(2026, 10, 1),
    revision: 1,
    ...over,
  };
}

function listed(record: ReturnType<typeof hookRecord>, lastDelivery: unknown = null) {
  return { ...record, lastDelivery, problems: [] };
}

const DELIVERED = {
  id: 'delivery-1',
  kind: 'review.requested',
  test: false,
  status: 'delivered',
  lastAttempt: {
    number: 1,
    startedAt: Date.UTC(2026, 10, 2),
    finishedAt: Date.UTC(2026, 10, 2),
    outcome: 'completed',
    status: null,
    error: null,
  },
  createdAt: Date.UTC(2026, 10, 2),
  updatedAt: Date.UTC(2026, 10, 2),
};

const SLACK_KEYS: SecretState[] = [
  { key: 'slack-bot-token', set: true },
  { key: 'slack-signing-key', set: false },
];

const DEFAULT_ON = hookRecord('default-on', { name: 'Post settled runs' });
const DEFAULT_OFF = hookRecord('default-off', {
  name: 'Post started runs',
  enabled: false,
  declaredBy: { plugin: 'slack', ownerDisabled: true, withdrawn: false },
});
const DEFAULT_WITHDRAWN = hookRecord('default-withdrawn', {
  name: 'Post old runs',
  enabled: false,
  declaredBy: { plugin: 'slack', ownerDisabled: false, withdrawn: true },
});
const DEFAULT_DISABLED_PLUGIN = hookRecord('default-plugin-disabled', {
  name: 'Page on failures',
  action: { type: 'plugin', plugin: 'pager', kind: 'page', configuration: { channel: 'ops' } },
  declaredBy: { plugin: 'pager', ownerDisabled: false, withdrawn: false },
});
const DEFAULT_NEEDS_SETUP = hookRecord('default-needs-setup', {
  name: 'Add to the calendar',
  action: { type: 'plugin', plugin: 'calendar', kind: 'add', configuration: { channel: 'ops' } },
  declaredBy: { plugin: 'calendar', ownerDisabled: false, withdrawn: false },
});
const OWNER_PLUGIN_HOOK = hookRecord('owner-plugin', {
  name: 'My Slack post',
  declaredBy: null,
});

/** The plugins every state starts from: Slack on, Pager off, Calendar waiting for one key. */
const PLUGINS = () => [
  pluginStanding('slack', 'Slack', 'running', SLACK_KEYS),
  pluginStanding('pager', 'Pager', 'disabled'),
  pluginStanding('calendar', 'Calendar', 'needs-setup', [{ key: 'calendar-token', set: false }]),
];
const CONTRIBUTIONS = contributions(
  reaction('slack', 'post-message'),
  reaction('calendar', 'add', { availability: 'needs-setup' }),
);

/** Opens `path` with the Bureau's hooks stubbed by `hooks` and the host's plugins by `read`. */
async function openHooks(
  page: Page,
  path: string,
  hooks: readonly ReturnType<typeof hookRecord>[],
  extra: Record<string, Answer | Fault> = {},
  read: () => readonly ReturnType<typeof pluginStanding>[] | Fault = PLUGINS,
  onSecret?: (plugin: string, key: string) => void,
): Promise<Call[]> {
  const calls = await serveBureau(page, {
    'bureau.hooks.list': () => ({
      hooks: hooks.map((hook) => listed(hook, hook.enabled ? DELIVERED : null)),
    }),
    'bureau.hooks.get': (params) => hooks.find((hook) => hook.id === params['hookId']),
    'bureau.hooks.deliveries': () => ({ deliveries: [] }),
    'bureau.plugins.contributions': CONTRIBUTIONS,
    ...extra,
  });
  await serveHost(page, read, onSecret);
  await page.goto(path);
  return calls;
}

for (const width of WIDTHS) {
  test(`[default-hooks] the list marks what a plugin made with Plugin and shows one status per row, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await openHooks(page, '/hooks', [
      DEFAULT_ON,
      DEFAULT_OFF,
      DEFAULT_WITHDRAWN,
      DEFAULT_DISABLED_PLUGIN,
      DEFAULT_NEEDS_SETUP,
      OWNER_PLUGIN_HOOK,
    ]);
    await expect(page.locator('[data-view="hooks"]')).toHaveAttribute('data-state', 'ready');
    const row = (id: string) => page.locator(`li[data-hook="${id}"]`);
    await captureForDesignReview(page, { route: '/hooks', state: 'default-hooks', source: SOURCE });

    // R10-01: the badge reads Plugin after the name of each hook a plugin declared, and never on one the owner made.
    for (const id of [
      'default-on',
      'default-off',
      'default-withdrawn',
      'default-plugin-disabled',
      'default-needs-setup',
    ]) {
      await expect(row(id).getByTestId('hook-plugin-badge')).toHaveText(HOOKS_COPY.pluginBadge);
    }
    await expect(row('owner-plugin').getByTestId('hook-plugin-badge')).toHaveCount(0);

    // R10-02: one status word per row, in the order Off, Unavailable, Needs setup, then the delivery.
    const words = [
      ['default-on', 'Delivered'],
      ['default-off', 'Off'],
      ['default-withdrawn', 'Off'],
      ['default-plugin-disabled', 'Unavailable'],
      ['default-needs-setup', 'Needs setup'],
    ] as const;
    for (const [id, word] of words) {
      await expect(row(id).locator('.cinder-status-dot')).toHaveCount(1);
      await expect(row(id).locator('[data-status-word]')).toHaveAttribute('data-status-word', word);
    }

    // R10-03: a hook its plugin withdrew shows Off with its switch held, and the tooltip says why.
    const held = row('default-withdrawn').getByRole('switch');
    await expect(held).toHaveAttribute('aria-checked', 'false');
    await expect(held).toBeDisabled();
    await row('default-withdrawn').locator('.cinder-tooltip-wrapper').hover();
    await expect(
      page.getByRole('tooltip').filter({ hasText: standing.withdrawnSwitch('Slack') }),
    ).toBeVisible();
    await checkA11y(`hooks — default hooks in the list at ${width}px`);
  });
}

test('[default-hooks] a default hook’s switch turns it on and off through update with enabled only', async ({
  page,
}) => {
  const calls = await openHooks(page, '/hooks', [DEFAULT_ON], {
    'bureau.hooks.update': (params) => ({ ...DEFAULT_ON, enabled: params['enabled'] }),
  });
  const toggle = page.locator('li[data-hook="default-on"]').getByRole('switch');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect.poll(() => calls.some((call) => call.method === 'bureau.hooks.update')).toBe(true);
  const update = calls.find((call) => call.method === 'bureau.hooks.update');
  expect(update?.params).toEqual({ hookId: 'default-on', expectedRevision: 1, enabled: false });
});

test('[default-hook-toggle-failed] a switch the Bureau refuses says so in a toast and returns to its saved state', async ({
  page,
  pageErrors,
}) => {
  pageErrors.expectEvery({
    pattern: loggedFailedResponse(500, /\/bureau\/jsonrpc/),
    reason: 'the test answers the update with the failure the Bureau gives when it cannot save',
  });
  await openHooks(page, '/hooks', [DEFAULT_ON], {
    'bureau.hooks.update': { status: 500, message: 'The server broke.' },
  });
  await captureForDesignReview(page, {
    route: '/hooks',
    state: 'default-hook-toggle-failed',
    source: SOURCE,
  });
  const toggle = page.locator('li[data-hook="default-on"]').getByRole('switch');
  await toggle.click();
  // R10-24
  await expect(page.locator('.cinder-toast', { hasText: HOOKS_COPY.toggleFailed })).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
});

for (const width of WIDTHS) {
  test(`[default-hook-on] a default hook’s page is read only, with the switch, Duplicate, one note and its configuration as pairs, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await openHooks(page, '/hooks/default-on', [DEFAULT_ON]);
    const head = page.getByTestId('hook-header');
    await expect(head.getByRole('heading', { level: 1, name: 'Post settled runs' })).toBeVisible();
    await captureForDesignReview(page, {
      route: '/hooks/:hook',
      state: 'default-hook-on',
      source: SOURCE,
    });

    // R10-04: the switch and a secondary small Duplicate button; no More actions menu, no Delete.
    await expect(head.getByRole('switch')).toBeVisible();
    const duplicate = head.getByRole('button', { name: defaults.duplicate, exact: true });
    await expect(duplicate).toHaveAttribute('data-cinder-variant', 'secondary');
    // R10-05: drawn no taller than 36 px, with the 44 pixel hit area Cinder gives a compact button
    // (the page asks for size sm; Cinder draws it as its compact size).
    await expect(duplicate).toHaveAttribute('data-cinder-hit-target', '44');
    const drawn = await duplicate.boundingBox();
    expect(drawn?.height ?? Infinity).toBeLessThanOrEqual(36);
    await expect(page.getByRole('button', { name: header.menuLabel })).toHaveCount(0);
    await expect(page.getByText(HOOKS_COPY.editor.check.delete, { exact: true })).toHaveCount(0);

    // R10-06: one note above step 1, with the plugin as a link to its Settings page; nothing repeats it.
    const note = page.getByTestId('hook-provenance');
    await expect(note).toContainText(`Slack${defaults.provenance.untouched}`);
    await expect(note.getByRole('link', { name: 'Slack', exact: true })).toHaveAttribute(
      'href',
      '/settings/plugins?plugin=slack',
    );
    await expect(page.getByTestId('hook-provenance')).toHaveCount(1);

    // R10-08: the steps are text; no Edit button, no Name field, no Save hook, no input in the configuration.
    await expect(page.getByRole('button', { name: HOOKS_COPY.editor.steps.edit })).toHaveCount(0);
    await expect(page.getByLabel(HOOKS_COPY.editor.check.nameLabel)).toHaveCount(0);
    await expect(page.getByRole('button', { name: HOOKS_COPY.editor.check.save })).toHaveCount(0);
    const configuration = page.getByTestId('contributed-action');
    await expect(configuration.locator('input, select, textarea, [role="combobox"]')).toHaveCount(
      0,
    );
    await expect(configuration.locator('dt', { hasText: 'Channel' })).toBeVisible();
    await expect(configuration.locator('dd', { hasText: 'ops' })).toBeVisible();

    // R10-13 and R10-12: the secret is its key in monospace beside a Set dot, never a value.
    const key = configuration.locator('code[data-cinder-secret-key]');
    await expect(key).toHaveText('slack-bot-token');
    await expect(configuration.locator('.cinder-status-dot')).toHaveText('Set');
    await checkA11y(`hooks — a default hook at ${width}px`);
  });
}

test('[default-hook-off] a hook the owner turned off says so after Off', async ({ page }) => {
  await openHooks(page, '/hooks/default-off', [DEFAULT_OFF]);
  const head = page.getByTestId('hook-header');
  await expect(head.locator('[data-status-word="Off"]')).toBeVisible();
  await expect(head.getByTestId('hook-standing-sentence')).toHaveText(standing.ownerOff);
  await captureForDesignReview(page, {
    route: '/hooks/:hook',
    state: 'default-hook-off',
    source: SOURCE,
  });
});

test('[default-hook-withdrawn] a hook its plugin withdrew stays off, its switch is held and the note says why once', async ({
  page,
}) => {
  await openHooks(page, '/hooks/default-withdrawn', [DEFAULT_WITHDRAWN]);
  const head = page.getByTestId('hook-header');
  await expect(head.locator('[data-status-word="Off"]')).toBeVisible();
  await expect(head.getByRole('switch')).toBeDisabled();
  await expect(page.getByTestId('hook-provenance')).toContainText(
    `Slack${defaults.provenance.withdrawn}`,
  );
  await expect(head.getByTestId('hook-standing-sentence')).toHaveCount(0);
  await captureForDesignReview(page, {
    route: '/hooks/:hook',
    state: 'default-hook-withdrawn',
    source: SOURCE,
  });
});

test('[default-hook-plugin-disabled] a hook of a disabled plugin is Unavailable, links to the plugin, and cannot be tested', async ({
  page,
}) => {
  await openHooks(page, '/hooks/default-plugin-disabled', [DEFAULT_DISABLED_PLUGIN]);
  const head = page.getByTestId('hook-header');
  // R10-07
  await expect(head.locator('[data-status-word="Unavailable"]')).toBeVisible();
  await expect(head.getByTestId('hook-standing-sentence')).toHaveText(standing.disabled('Pager'));
  await expect(
    head.getByRole('link', { name: standing.openPlugin('Pager'), exact: true }),
  ).toHaveAttribute('href', '/settings/plugins?plugin=pager');
  // R10-17: the test is off before it is pressed, and the reason links Settings.
  const test = page.getByRole('button', { name: HOOKS_COPY.editor.check.test });
  await expect(test).toHaveAttribute('aria-disabled', 'true');
  const reason = page.getByTestId('hook-test-reason');
  await expect(reason).toHaveText('Turn on Pager in Settings to test this action.');
  await expect(reason.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
  await captureForDesignReview(page, {
    route: '/hooks/:hook',
    state: 'default-hook-plugin-disabled',
    source: SOURCE,
  });
});

test('[default-hook-needs-setup] a hook whose plugin needs one key says Needs setup with Add the key, and cannot be tested yet', async ({
  page,
}) => {
  await openHooks(page, '/hooks/default-needs-setup', [DEFAULT_NEEDS_SETUP]);
  const head = page.getByTestId('hook-header');
  await expect(head.locator('[data-status-word="Needs setup"]')).toBeVisible();
  await expect(head.getByTestId('hook-standing-sentence')).toHaveText(
    standing.needsSetup('Calendar'),
  );
  await expect(head.getByRole('button', { name: standing.addKey, exact: true })).toBeVisible();
  const test = page.getByRole('button', { name: HOOKS_COPY.editor.check.test });
  await expect(test).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('hook-test-reason')).toHaveText(
    HOOKS_COPY.editor.check.testPluginNeedsSetup('Calendar'),
  );
  await captureForDesignReview(page, {
    route: '/hooks/:hook',
    state: 'default-hook-needs-setup',
    source: SOURCE,
  });
});

test('[default-hook-duplicated] Duplicate makes an off copy named “<name> copy”, opens it, and says so', async ({
  page,
}) => {
  const copyRecord = hookRecord('default-copy', {
    name: 'Post settled runs copy',
    enabled: false,
    declaredBy: null,
  });
  const calls = await openHooks(page, '/hooks/default-on', [DEFAULT_ON, copyRecord], {
    'bureau.hooks.duplicate': () => ({ ...copyRecord, signingSecret: null }),
  });
  await page
    .getByTestId('hook-header')
    .getByRole('button', { name: defaults.duplicate, exact: true })
    .click();

  // R10-09
  await expect(page).toHaveURL(/\/hooks\/default-copy$/);
  expect(calls.find((call) => call.method === 'bureau.hooks.duplicate')?.params).toEqual({
    hookId: 'default-on',
    name: 'Post settled runs copy',
  });
  await expect(page.locator('.cinder-toast', { hasText: defaults.duplicated })).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Post settled runs copy' }),
  ).toBeVisible();
  await expect(page.getByTestId('hook-header').getByRole('switch')).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await captureForDesignReview(page, {
    route: '/hooks/:hook',
    state: 'default-hook-duplicated',
    source: SOURCE,
  });
});

test('[default-hook-duplicate-failed] a Duplicate the Bureau refuses says so in a toast and stays on the default hook', async ({
  page,
  pageErrors,
}) => {
  pageErrors.expectEvery({
    pattern: loggedFailedResponse(500, /\/bureau\/jsonrpc/),
    reason: 'the test answers the duplicate with the failure the Bureau gives when it cannot save',
  });
  await openHooks(page, '/hooks/default-on', [DEFAULT_ON], {
    'bureau.hooks.duplicate': { status: 500, message: 'The server broke.' },
  });
  await page
    .getByTestId('hook-header')
    .getByRole('button', { name: defaults.duplicate, exact: true })
    .click();

  await expect(page.locator('.cinder-toast', { hasText: defaults.duplicateFailed })).toBeVisible();
  await expect(page).toHaveURL(/\/hooks\/default-on$/);
  await captureForDesignReview(page, {
    route: '/hooks/:hook',
    state: 'default-hook-duplicate-failed',
    source: SOURCE,
  });
});

for (const width of WIDTHS) {
  test(`[plugin-hook-configuration] a hook the owner made shows its configuration as fields, with the secret as a Select of keys, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const calls = await openHooks(page, '/hooks/owner-plugin', [OWNER_PLUGIN_HOOK], {
      'bureau.hooks.update': (params) => ({ ...OWNER_PLUGIN_HOOK, ...params, revision: 2 }),
    });
    const action = page.getByTestId('contributed-action');
    await expect(action.getByLabel('Channel')).toHaveValue('ops');
    await captureForDesignReview(page, {
      route: '/hooks/:hook',
      state: 'plugin-hook-configuration',
      source: SOURCE,
    });

    // R10-10: the action is text, and its configuration is Cinder SchemaForm fields.
    await expect(page.getByTestId('hook-plugin-action')).toHaveText('Post message from Slack');
    // R10-11 and R10-12: the secret is a Select of keys, with the help; no text or password input draws it.
    const token = action.getByRole('combobox', { name: /^Token/ });
    await expect(token).toContainText('slack-bot-token');
    await expect(action.locator('input[type="password"]')).toHaveCount(0);
    await expect(action.getByText(HOOKS_COPY.secrets.help)).toBeVisible();
    await token.click();
    await expect(page.getByRole('option', { name: /^slack-bot-token/ })).toContainText('Set');
    await expect(page.getByRole('option', { name: /^slack-signing-key/ })).toContainText('Missing');
    await expect(page.locator('.cinder-select__group').filter({ hasText: 'Slack' })).toBeVisible();
    await page.keyboard.press('Escape');

    // Save hook sends the changed configuration through update, the secret as its reference alone.
    await action.getByLabel('Channel').fill('alerts');
    await page.getByRole('button', { name: HOOKS_COPY.editor.check.save }).click();
    await expect.poll(() => calls.some((call) => call.method === 'bureau.hooks.update')).toBe(true);
    const update = calls.find((call) => call.method === 'bureau.hooks.update');
    expect(update?.params['action']).toEqual({
      type: 'plugin',
      plugin: 'slack',
      kind: 'post-message',
      configuration: { channel: 'alerts', token: { $secret: 'slack-bot-token' } },
    });
    await checkA11y(`hooks — a plugin hook’s configuration at ${width}px`);
  });
}

test('[plugin-hook-secret-missing] a chosen key that is Missing is warned about, and Add the key saves it without a reload', async ({
  page,
}) => {
  const keys: SecretState[] = [
    { key: 'slack-bot-token', set: true },
    { key: 'slack-signing-key', set: false },
  ];
  const record = hookRecord('owner-missing', {
    name: 'My Slack post',
    declaredBy: null,
    action: {
      type: 'plugin',
      plugin: 'slack',
      kind: 'post-message',
      configuration: { channel: 'ops', token: { $secret: 'slack-signing-key' } },
    },
  });
  await openHooks(
    page,
    '/hooks/owner-missing',
    [record],
    {},
    () => [
      pluginStanding('slack', 'Slack', 'running', keys),
      pluginStanding('pager', 'Pager', 'disabled'),
    ],
    (_plugin, key) => {
      const found = keys.find((candidate) => candidate.key === key);
      if (found !== undefined) found.set = true;
    },
  );
  const action = page.getByTestId('contributed-action');
  const warning = action.locator('.cinder-schema-form__secret-warning');
  // R10-14
  await expect(warning).toContainText(HOOKS_COPY.secrets.missing('slack-signing-key'));
  await captureForDesignReview(page, {
    route: '/hooks/:hook',
    state: 'plugin-hook-secret-missing',
    source: SOURCE,
  });
  await warning.getByRole('button', { name: HOOKS_COPY.secrets.addKey, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Save slack-signing-key' });
  await dialog.getByLabel('Value').fill('a-secret-the-page-never-shows');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // Saved: the option reads Set and the warning is gone, with no reload.
  await expect(warning).toHaveCount(0);
  await expect(page.getByText('a-secret-the-page-never-shows')).toHaveCount(0);
});

test('[plugin-hook-no-secrets] with no secret a plugin names, the Select is disabled and says where one is saved', async ({
  page,
}) => {
  // No key is chosen: a chosen key the host does not list would be a row of its own, drawn Missing.
  const unchosen = hookRecord('owner-unchosen', {
    name: 'My Slack post',
    declaredBy: null,
    action: {
      type: 'plugin',
      plugin: 'slack',
      kind: 'post-message',
      configuration: { channel: 'ops' },
    },
  });
  await openHooks(page, '/hooks/owner-unchosen', [unchosen], {}, () => [
    pluginStanding('slack', 'Slack', 'running'),
  ]);
  const action = page.getByTestId('contributed-action');
  const token = action.getByRole('combobox', { name: /^Token/ });
  // R10-15
  await expect(token).toBeDisabled();
  await expect(token).toContainText('No secrets to choose');
  await expect(action.locator('.cinder-schema-form__secret-help')).toHaveText(
    `${HOOKS_COPY.secrets.emptyHelp} ${HOOKS_COPY.secrets.manage}${HOOKS_COPY.secrets.emptyHelpEnd}`,
  );
  await expect(
    action.getByRole('link', { name: HOOKS_COPY.secrets.manage, exact: true }),
  ).toHaveAttribute('href', '/settings/plugins');
  await captureForDesignReview(page, {
    route: '/hooks/:hook',
    state: 'plugin-hook-no-secrets',
    source: SOURCE,
  });
});

test('[plugin-hook-secrets-failed] when the keys cannot be read the field says so with Try again, and the other fields stay usable', async ({
  page,
  pageErrors,
}) => {
  pageErrors.expectEvery({
    pattern: loggedFailedResponse(500, /\/host\/plugins/),
    reason: 'the test answers every read of the host’s plugins with a failure until Try again',
  });
  let failing = true;
  await openHooks(page, '/hooks/owner-plugin', [OWNER_PLUGIN_HOOK], {}, () =>
    failing ? { status: 500, message: 'The host broke.' } : PLUGINS(),
  );
  const action = page.getByTestId('contributed-action');
  // R10-16
  await expect(action.locator('.cinder-schema-form__secret-failed')).toContainText(
    HOOKS_COPY.secrets.failed,
  );
  await captureForDesignReview(page, {
    route: '/hooks/:hook',
    state: 'plugin-hook-secrets-failed',
    source: SOURCE,
  });
  await action.getByLabel('Channel').fill('alerts');
  await expect(action.getByLabel('Channel')).toHaveValue('alerts');
  failing = false;
  await action.getByRole('button', { name: HOOKS_COPY.secrets.retry, exact: true }).click();
  await expect(action.getByRole('combobox', { name: /^Token/ })).toContainText('slack-bot-token');
});

test('[plugin-hook-testing] while a test runs, Send a test event shows its loading state', async ({
  page,
}) => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(BUREAU_CALLS, async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { id: unknown; method?: string };
    if (body.method !== 'bureau.hooks.test') {
      await route.fallback();
      return;
    }
    await held;
    await route.fulfill({
      json: {
        jsonrpc: '2.0',
        id: body.id,
        result: {
          id: 'test-1',
          hookId: 'owner-plugin',
          owner: 'anonymous:local',
          actionType: 'plugin',
          kind: 'hook.test',
          test: true,
          status: 'delivered',
          request: null,
          work: null,
          attempts: [],
          maxAttempts: 1,
          nextAttemptAt: null,
          createdAt: 1,
          updatedAt: 1,
        },
      },
    });
  });
  await openHooks(page, '/hooks/owner-plugin', [OWNER_PLUGIN_HOOK]);
  const test = page.getByRole('button', { name: HOOKS_COPY.editor.check.test });
  await expect(test).toBeEnabled();
  await test.click();
  // R10-18
  await expect(test).toHaveAttribute('data-cinder-loading', '');
  await captureForDesignReview(page, {
    route: '/hooks/:hook',
    state: 'plugin-hook-testing',
    source: SOURCE,
  });
  release();
  await expect(test).not.toHaveAttribute('data-cinder-loading', '');
});

test('[plugin-hook-save-failed] a refused save keeps every value and shows the refusal on the field', async ({
  page,
  pageErrors,
}) => {
  pageErrors.expectEvery({
    pattern: loggedFailedResponse(400, /\/bureau\/jsonrpc/),
    reason:
      'the test answers the update with the refusal the Bureau gives a configuration it rejects',
  });
  await openHooks(page, '/hooks/owner-plugin', [OWNER_PLUGIN_HOOK], {
    'bureau.hooks.update': {
      status: 400,
      message: 'The configuration is refused.',
      data: {
        issues: [
          {
            path: ['action', 'configuration', 'channel'],
            message: 'That channel is not one this workspace has.',
            code: 'custom',
          },
        ],
      },
    },
  });
  const action = page.getByTestId('contributed-action');
  await action.getByLabel('Channel').fill('nowhere');
  await page.getByRole('button', { name: HOOKS_COPY.editor.check.save }).click();

  // R10-22
  const failure = page.getByTestId('hook-failure');
  await expect(failure).toContainText(HOOKS_COPY.editor.saveFailed);
  await expect(failure).toContainText(HOOKS_COPY.editor.saveFailedKept);
  await expect(action.getByLabel('Channel')).toHaveValue('nowhere');
  await expect(action).toContainText('That channel is not one this workspace has.');
  await captureForDesignReview(page, {
    route: '/hooks/:hook',
    state: 'plugin-hook-save-failed',
    source: SOURCE,
  });
});

for (const width of WIDTHS) {
  test(`[new-hook-plugin-action] every action choice is on screen, and a plugin’s action is chosen from a grouped Select, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await openHooks(page, '/hooks/new', []);
    const action = HOOKS_COPY.editor.action;
    const labels = [action.webhook, action.startWorkflow, action.notify, action.plugin];
    // R10-20: the four choices are all visible with no sideways scroll, as a strip or, when it does not fit, a Select.
    const strip = page.getByRole('radiogroup', { name: action.label });
    if (width >= 1280) {
      await expect(strip).toBeVisible();
      for (const label of labels) {
        await expect(page.getByRole('radio', { name: label, exact: true })).toBeInViewport();
      }
    } else {
      const select = page.getByLabel(action.label, { exact: true });
      await expect(select).toBeVisible();
      await expect(select.locator('option')).toHaveText(labels);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await captureForDesignReview(page, {
      route: '/hooks/new',
      state: 'new-hook-plugin-action',
      source: SOURCE,
    });

    // R10-21: choosing it shows one Select labelled Action, grouped by plugin title.
    if (width >= 1280) {
      await page.getByRole('radio', { name: action.plugin, exact: true }).click();
    } else {
      await page.getByLabel(action.label, { exact: true }).selectOption('plugin');
    }
    const choice = page.getByRole('combobox', { name: /^Action/ });
    await choice.click();
    await expect(page.locator('.cinder-select__group').filter({ hasText: 'Slack' })).toBeVisible();
    await expect(
      page.locator('.cinder-select__group').filter({ hasText: 'Calendar' }),
    ).toBeVisible();
    // An action whose plugin needs setup shows the note and can still be chosen.
    const needsSetup = page.getByRole('option', { name: /^Add/ });
    await expect(needsSetup).toContainText(action.needsSetup);
    await page.getByRole('option', { name: /^Post message/ }).click();
    await expect(page.getByTestId('contributed-action').getByLabel('Channel')).toBeVisible();
    await checkA11y(`hooks — a new hook that runs a plugin’s action at ${width}px`);
  });
}
