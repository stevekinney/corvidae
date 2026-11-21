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
import { readBoxes } from './read-boxes.ts';
import { bureauCall } from './task-support.ts';
import { TEXT_ECHO_AGENT_NAME } from './text-echo-agent.ts';
import { textLines } from './text-lines.ts';

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
const BUREAU_CALLS = '**/jsonrpc';
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
    // An answer may be held (a promise), so a test can show the page while a read is in flight.
    const result: unknown = await answer(body.params ?? {});
    await route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result } });
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

/**
 * The delivery `DELIVERED` summarises, as `bureau.hooks.deliveries` lists it for `hookId`, so a hook's
 * page says the same delivery word its list row does (R10-07).
 */
function deliveredRecord(hookId: string) {
  return {
    id: 'delivery-1',
    hookId,
    owner: 'anonymous:local',
    actionType: 'plugin',
    kind: 'review.requested',
    test: false,
    status: 'delivered',
    request: null,
    work: null,
    attempts: [
      {
        number: 1,
        startedAt: Date.UTC(2026, 10, 2),
        finishedAt: Date.UTC(2026, 10, 2),
        outcome: 'completed',
        status: null,
        responseExcerpt: null,
        responseTruncated: null,
        error: null,
      },
    ],
    maxAttempts: 5,
    createdAt: Date.UTC(2026, 10, 2),
    updatedAt: Date.UTC(2026, 10, 2),
  };
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
    // The same delivery the list's row summarises, so the row and the page say one word (R10-07).
    'bureau.hooks.deliveries': (params) => {
      const hook = hooks.find((candidate) => candidate.id === params['hookId']);
      return { deliveries: hook?.enabled === true ? [deliveredRecord(hook.id)] : [] };
    },
    'bureau.plugins.contributions': CONTRIBUTIONS,
    ...extra,
  });
  await serveHost(page, read, onSecret);
  await page.goto(path);
  return calls;
}

for (const width of WIDTHS) {
  test(`[default-hooks] /hooks: the list marks what a plugin made with Plugin and shows one status per row, at ${width} pixels`, async ({
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

// R10-01 and R10-02 on the narrowest phones, measured: the status word whole, the Plugin badge just
// after the name it marks, and the time broken only between its day and its clock.
for (const width of [320, 375] as const) {
  test(`[default-hooks] at ${width} pixels each status word is whole and each Plugin badge sits just after its name`, async ({
    page,
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
    const rows = page.locator('li[data-hook]');
    await expect(rows).toHaveCount(6);
    for (const row of await rows.all()) {
      const id = await row.getAttribute('data-hook');
      const word = row.locator('[data-status-word]');
      if ((await word.count()) > 0) {
        const { lines } = await textLines(word);
        expect(lines, `${id}: the status word is one line`).toBe(1);
        await expect(
          row.locator(
            '.cinder-stacked-list-item__status, .cinder-stacked-list-item__status-inline',
          ),
          `${id}: the row renders one status`,
        ).toHaveCount(1);
        // A phone draws the word inline at the start of line two (no column cell); it does not
        // clip, so its box must lie inside line two's box. A column cell must not clip it.
        const whole = await word.evaluate((element) => {
          const column = element.closest('.cinder-stacked-list-item__status');
          if (column !== null) return column.scrollWidth <= column.clientWidth + 0.5;
          const lineTwo = element
            .closest('.cinder-stacked-list-item')
            ?.querySelector('.cinder-stacked-list-item__line-two');
          if (!lineTwo) return false;
          const box = element.getBoundingClientRect();
          const frame = lineTwo.getBoundingClientRect();
          return (
            box.left >= frame.left - 0.5 &&
            box.right <= frame.right + 0.5 &&
            box.top >= frame.top - 0.5 &&
            box.bottom <= frame.bottom + 0.5
          );
        });
        expect(whole, `${id}: the status word is whole`).toBe(true);
      }
      for (const part of await row.locator('.cinder-stacked-list-item__time-part').all()) {
        const { lines } = await textLines(part);
        expect(lines, `${id}: a day or a clock is never broken`).toBe(1);
      }
      // The time gives way before the name: its column is no wider than its widest line, the day
      // or the clock, so the name keeps the rest of line one.
      const time = row.locator('.cinder-stacked-list-item__time-text');
      if ((await time.count()) > 0) {
        const spare = await time.evaluate((text) => {
          const widest = Math.max(
            ...[...text.querySelectorAll('.cinder-stacked-list-item__time-part')].map(
              (part) => part.getBoundingClientRect().width,
            ),
          );
          return text.getBoundingClientRect().width - widest;
        });
        expect(spare, `${id}: the time is no wider than its widest line`).toBeLessThanOrEqual(1);
      }
      const badge = row.getByTestId('hook-plugin-badge');
      if ((await badge.count()) === 0) continue;
      const titleBox = row.locator('.cinder-stacked-list-item__title');
      if (width === 375 && id === 'default-on') {
        // "Post settled runs" beside its badge, its time and its switch is drawn whole at 375.
        await expect(titleBox).toHaveText('Post settled runs');
        const cut = await titleBox.evaluate((cell) => cell.scrollWidth > cell.clientWidth + 0.5);
        expect(cut, `${id}: the name is not cut at 375`).toBe(false);
      }
      const title = await textLines(titleBox);
      const mark = await badge.boundingBox();
      expect(title.lines, `${id}: a name beside its badge is one line`).toBe(1);
      // From the last character drawn (or the ellipsis that ends the name) to the badge's edge.
      const gap = (mark?.x ?? Number.NaN) - title.right;
      expect(gap, `${id}: the badge follows the name`).toBeGreaterThanOrEqual(0);
      expect(gap, `${id}: the badge is within 8px of the name`).toBeLessThanOrEqual(8);
    }
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

test('[default-hook-toggle-failed] /hooks: a switch the Bureau refuses says so in a toast and returns to its saved state', async ({
  page,
  pageErrors,
}) => {
  pageErrors.expectEvery({
    pattern: loggedFailedResponse(500, /\/jsonrpc/),
    reason: 'the test answers the update with the failure the Bureau gives when it cannot save',
  });
  await openHooks(page, '/hooks', [DEFAULT_ON], {
    'bureau.hooks.update': { status: 500, message: 'The server broke.' },
  });
  const toggle = page.locator('li[data-hook="default-on"]').getByRole('switch');
  await toggle.click();
  // R10-24
  await expect(page.locator('.cinder-toast', { hasText: HOOKS_COPY.toggleFailed })).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  // Captured once the toast says so and the switch is back, not while the list is still loading.
  await captureForDesignReview(page, {
    route: '/hooks',
    state: 'default-hook-toggle-failed',
    source: SOURCE,
  });
});

// R10-25: a default hook appears in each list state like any other hook.
for (const width of WIDTHS) {
  test(`[default-hooks-loading] /hooks: a list holding a default hook keeps its header while it loads, then draws the hook with Plugin, at ${width} pixels`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await openHooks(page, '/hooks', [DEFAULT_ON, OWNER_PLUGIN_HOOK], {
      'bureau.hooks.list': async () => {
        await held;
        return { hooks: [listed(DEFAULT_ON, DELIVERED), listed(OWNER_PLUGIN_HOOK, DELIVERED)] };
      },
    });
    const main = page.locator('main');
    await expect(main.getByRole('heading', { level: 1, name: 'Hooks' })).toBeVisible();
    await expect(main.locator('.cinder-skeleton-row').first()).toBeVisible();
    await captureForDesignReview(page, {
      route: '/hooks',
      state: 'default-hooks-loading',
      source: SOURCE,
    });
    release();
    await expect(main.locator('li[data-hook]')).toHaveCount(2);
    await expect(
      main.locator('li[data-hook="default-on"]').getByTestId('hook-plugin-badge'),
    ).toHaveText(HOOKS_COPY.pluginBadge);
  });

  test(`[default-hooks-filtered] /hooks: a search keeps a default hook that matches, with Plugin, at ${width} pixels`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await openHooks(page, '/hooks?q=settled', [DEFAULT_ON, OWNER_PLUGIN_HOOK]);
    const main = page.locator('main');
    await expect(main.locator('li[data-hook]')).toHaveCount(1);
    await expect(
      main.locator('li[data-hook="default-on"]').getByTestId('hook-plugin-badge'),
    ).toHaveText(HOOKS_COPY.pluginBadge);
    await captureForDesignReview(page, {
      route: '/hooks',
      state: 'default-hooks-filtered',
      source: SOURCE,
    });
  });

  test(`[hook-page-loading] /hooks/:hook: a hook's page shows placeholders while it is read, at ${width} pixels`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await openHooks(page, '/hooks/default-on', [DEFAULT_ON], {
      'bureau.hooks.get': async () => {
        await held;
        return DEFAULT_ON;
      },
    });
    const loading = page.getByTestId('hook-loading');
    await expect(loading).toBeAttached();
    await expect(loading.locator('.cinder-skeleton').first()).toBeVisible();
    await captureForDesignReview(page, {
      route: '/hooks/:hook',
      state: 'hook-page-loading',
      source: SOURCE,
    });
    release();
    await expect(
      page.getByTestId('hook-header').getByRole('heading', { level: 1, name: 'Post settled runs' }),
    ).toBeVisible();
  });

  test(`[hook-page-error] /hooks/:hook: a hook's page that could not be read says so, at ${width} pixels`, async ({
    page,
    pageErrors,
  }) => {
    pageErrors.expectEvery({
      pattern: loggedFailedResponse(500, /\/jsonrpc/),
      reason:
        'the test answers the read of the hook with the failure the Bureau gives when it breaks',
    });
    await page.setViewportSize({ width, height: 900 });
    await openHooks(page, '/hooks/default-on', [DEFAULT_ON], {
      'bureau.hooks.get': { status: 500, message: 'The server broke.' },
    });
    await expect(page.locator('main')).toContainText(copy.loadFailed);
    await captureForDesignReview(page, {
      route: '/hooks/:hook',
      state: 'hook-page-error',
      source: SOURCE,
    });
  });
}

for (const width of WIDTHS) {
  test(`[default-hook-on] /hooks/:hook: a default hook’s page is read only, with the switch, Duplicate, one note and its configuration as pairs, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await openHooks(page, '/hooks/default-on', [DEFAULT_ON]);
    const head = page.getByTestId('hook-header');
    await expect(head.getByRole('heading', { level: 1, name: 'Post settled runs' })).toBeVisible();
    // R10-07: the page says the delivery word its row in the list says.
    await expect(head.locator('[data-status-word]')).toHaveAttribute(
      'data-status-word',
      'Delivered',
    );
    await captureForDesignReview(page, {
      route: '/hooks/:hook',
      state: 'default-hook-on',
      source: SOURCE,
    });

    // R10-04: the switch and a secondary small Duplicate button; no More actions menu, no Delete.
    await expect(head.getByRole('switch')).toBeVisible();
    const duplicate = head.getByRole('button', { name: defaults.duplicate, exact: true });
    await expect(duplicate).toContainClass('button-variant-secondary');
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

test('[default-hook-phone] /hooks/:hook: at 320 by 640 the switch and Duplicate share one row at the leading edge, 8 pixels apart', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openHooks(page, '/hooks/default-on', [DEFAULT_ON]);
  const head = page.getByTestId('hook-header');
  const heading = head.getByRole('heading', { level: 1, name: 'Post settled runs' });
  await expect(heading).toBeVisible();
  const duplicate = head.getByRole('button', { name: defaults.duplicate, exact: true });
  await expect(duplicate).toBeVisible();
  await captureForDesignReview(page, {
    route: '/hooks/:hook',
    state: 'default-hook-phone',
    source: SOURCE,
  });

  // Read together, from one layout.
  const {
    title,
    toggle,
    duplicate: button,
  } = await readBoxes(page, {
    title: heading,
    toggle: head.locator('.ib-hook-identity__actions > *').first(),
    duplicate,
  });
  // R10-05: one row: the switch and Duplicate share a centre line.
  expect(
    Math.abs(toggle.y + toggle.height / 2 - (button.y + button.height / 2)),
  ).toBeLessThanOrEqual(1);
  // At the leading edge, under the title.
  expect(Math.abs(toggle.x - title.x)).toBeLessThanOrEqual(1);
  // 8 pixels apart, give or take 2.
  const gap = button.x - (toggle.x + toggle.width);
  expect(gap).toBeGreaterThanOrEqual(6);
  expect(gap).toBeLessThanOrEqual(10);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('[default-hook-off] /hooks/:hook: a hook the owner turned off says so after Off', async ({
  page,
}) => {
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

test('[default-hook-withdrawn] /hooks/:hook: a hook its plugin withdrew stays off, its switch is held and the note says why once', async ({
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
  // The held switch says why in a tooltip, as its list row does.
  await head.locator('.ib-hook-identity__actions .cinder-tooltip-wrapper').hover();
  await expect(
    page.getByRole('tooltip').filter({ hasText: standing.withdrawnSwitch('Slack') }),
  ).toBeVisible();
  await captureForDesignReview(page, {
    route: '/hooks/:hook',
    state: 'default-hook-withdrawn',
    source: SOURCE,
  });
});

test('[default-hook-plugin-disabled] /hooks/:hook: a hook of a disabled plugin is Unavailable, links to the plugin, and cannot be tested', async ({
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
  // R10-08: the action is not offered, so its saved configuration is shown as pairs, read only.
  const stored = page.getByTestId('stored-configuration');
  await expect(stored.locator('dt', { hasText: /^channel$/i })).toBeVisible();
  // With no schema, a saved string may be writeOnly, so it reads Hidden, never in clear.
  await expect(stored.locator('dd', { hasText: 'Hidden' }).first()).toBeVisible();
  await expect(stored).not.toContainText('ops');
  await expect(stored.locator('input, select, textarea, [role="combobox"]')).toHaveCount(0);
  await captureForDesignReview(page, {
    route: '/hooks/:hook',
    state: 'default-hook-plugin-disabled',
    source: SOURCE,
  });
});

test('[default-hook-needs-setup] /hooks/:hook: a hook whose plugin needs one key says Needs setup with Add the key, and cannot be tested yet', async ({
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

test('[default-hook-duplicated] /hooks/:hook: Duplicate makes an off copy named “<name> copy”, opens it, and says so', async ({
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

test('[default-hook-duplicate-failed] /hooks/:hook: a Duplicate the Bureau refuses says so in a toast and stays on the default hook', async ({
  page,
  pageErrors,
}) => {
  pageErrors.expectEvery({
    pattern: loggedFailedResponse(500, /\/jsonrpc/),
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
  test(`[plugin-hook-configuration] /hooks/:hook: a hook the owner made shows its configuration as fields, with the secret as a Select of keys, at ${width} pixels`, async ({
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
    // R10-13: only keys are monospace. The field's label and help are set in the page's face, and
    // the trigger draws the chosen key in monospace, cut in its middle.
    const fontOf = (locator: typeof token) =>
      locator.evaluate((node) => {
        const probe = document.createElement('span');
        probe.style.fontFamily = 'var(--cinder-font-mono)';
        node.append(probe);
        const fonts = [getComputedStyle(node).fontFamily, getComputedStyle(probe).fontFamily];
        probe.remove();
        return fonts;
      });
    const [helpFont, helpMono] = await fontOf(action.getByText(HOOKS_COPY.secrets.help));
    expect(helpFont).not.toBe(helpMono);
    const chosenKey = token.locator('.cinder-select__value .cinder-text');
    await expect(chosenKey).toHaveAttribute('data-cinder-truncate', 'middle');
    const [chosenFont, chosenMono] = await fontOf(chosenKey);
    expect(chosenFont).toBe(chosenMono);
    await token.click();
    // A key's option is named by its whole key, never the two boxes of its middle cut.
    const keyOption = (key: string) => page.getByRole('option', { name: new RegExp(`^${key}`) });
    await expect(keyOption('slack-bot-token')).toContainText('Set');
    await expect(keyOption('slack-signing-key')).toContainText('Missing');
    await expect(page.locator('.cinder-select__group').filter({ hasText: 'Slack' })).toBeVisible();
    // R10-13: each key row draws its key in the monospace face, cut only in its middle when long.
    for (const key of ['slack-bot-token', 'slack-signing-key']) {
      const drawn = keyOption(key).locator('.cinder-select__option-label .cinder-text');
      await expect(drawn).toHaveAttribute('data-cinder-truncate', 'middle');
      const [font, mono] = await drawn.evaluate((node) => {
        const probe = document.createElement('span');
        probe.style.fontFamily = 'var(--cinder-font-mono)';
        node.append(probe);
        const fonts = [getComputedStyle(node).fontFamily, getComputedStyle(probe).fontFamily];
        probe.remove();
        return fonts;
      });
      expect(font).toBe(mono);
    }
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

test('[plugin-hook-secret-missing] /hooks/:hook: a chosen key that is Missing is warned about, and Add the key saves it without a reload', async ({
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
  const dialog = page.getByRole('dialog', { name: 'Save Slack signing key' });
  await dialog.getByLabel('Value').fill('a-secret-the-page-never-shows');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // Saved: the option reads Set and the warning is gone, with no reload.
  await expect(warning).toHaveCount(0);
  await expect(page.getByText('a-secret-the-page-never-shows')).toHaveCount(0);
});

test('[plugin-hook-no-secrets] /hooks/:hook: with no secret a plugin names, the Select is disabled and says where one is saved', async ({
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
  ).toHaveAttribute('href', '/settings/plugins?plugin=slack');
  await captureForDesignReview(page, {
    route: '/hooks/:hook',
    state: 'plugin-hook-no-secrets',
    source: SOURCE,
  });
});

test('[plugin-hook-secrets-failed] /hooks/:hook: when the keys cannot be read the field says so with Try again, and the other fields stay usable', async ({
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

test('[plugin-hook-testing] /hooks/:hook: while a test runs, Send a test event shows its loading state', async ({
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

test('[plugin-hook-save-failed] /hooks/:hook: a refused save keeps every value and shows the refusal on the field', async ({
  page,
  pageErrors,
}) => {
  pageErrors.expectEvery({
    pattern: loggedFailedResponse(400, /\/jsonrpc/),
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

// ─── Receipts and problems (COR-2182) ─────────────────────────────────────────────────────────────

/** A delivery of a plugin hook whose reaction answered with a receipt, as `bureau.hooks.deliveries` lists it. */
const RECEIPTED = {
  id: 'delivery-receipt',
  hookId: 'owner-plugin',
  owner: 'anonymous:local',
  actionType: 'plugin',
  kind: 'review.requested',
  test: false,
  status: 'delivered',
  request: null,
  work: null,
  attempts: [
    {
      number: 1,
      startedAt: Date.UTC(2026, 10, 2, 15),
      finishedAt: Date.UTC(2026, 10, 2, 15, 0, 1),
      outcome: 'completed',
      status: null,
      responseExcerpt: null,
      responseTruncated: null,
      error: null,
      receipt: {
        runId: null,
        notificationId: null,
        id: 'C0SAMPLE/1730559600.000100',
        url: 'https://slack.example/archives/C0SAMPLE/p1730559600000100',
        summary: 'Posted the review to #ops',
      },
    },
  ],
  maxAttempts: 5,
  createdAt: Date.UTC(2026, 10, 2, 15),
  updatedAt: Date.UTC(2026, 10, 2, 15, 0, 1),
};

// At 375 the capture also takes the 320 phone, so each of these states is seen at 320 and 1280.
for (const width of WIDTHS) {
  test(`[hook-delivery-receipt] /hooks/:hook: a delivery whose reaction made something shows its summary, a link to it and its reference, at ${width} pixels`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await openHooks(page, '/hooks/owner-plugin', [OWNER_PLUGIN_HOOK], {
      'bureau.hooks.deliveries': () => ({ deliveries: [RECEIPTED] }),
    });
    const item = page
      .getByTestId('hook-deliveries')
      .locator('li[data-delivery="delivery-receipt"]');
    await item.locator('button[aria-expanded]').first().click();
    const facts = item.getByTestId('hook-delivery-facts');
    await expect(facts.getByText('Posted the review to #ops')).toBeVisible();
    await expect(facts.getByRole('link', { name: 'slack.example' })).toHaveAttribute(
      'href',
      'https://slack.example/archives/C0SAMPLE/p1730559600000100',
    );
    // The reference is one line of monospace, cut only in its middle, never broken mid-token.
    const reference = facts.locator('code.cinder-text[data-cinder-truncate="middle"]');
    await expect(reference.locator('.cinder-text__head')).toHaveText(/^C0SAMPLE/);
    await expect(reference.locator('.cinder-text__tail')).toHaveText(/100$/);
    const { lines } = await textLines(reference);
    expect(lines, 'the reference is one line').toBe(1);
    // The Event fact is not drawn: the row above already says the event in words.
    await expect(
      facts.locator('dt').filter({ hasText: new RegExp(`^${copy.deliveries.facts.event}$`) }),
    ).toHaveCount(0);
    // R10-23: the event is its words; its raw kind is no visible word in the row or the facts.
    await expect(page.getByTestId('hook-deliveries')).not.toContainText('review.requested');
    await captureForDesignReview(page, {
      route: '/hooks/:hook',
      state: 'hook-delivery-receipt',
      source: SOURCE,
    });
  });
}

const UNAVAILABLE_HOOK = hookRecord('owner-unavailable', {
  name: 'My Slack post that lost its action',
  declaredBy: null,
});
const INVALID_HOOK = hookRecord('owner-invalid', {
  name: 'My Slack post the upgrade broke',
  declaredBy: null,
});

for (const width of WIDTHS) {
  for (const [state, record, problem, word] of [
    [
      'hook-reaction-unavailable',
      UNAVAILABLE_HOOK,
      { code: 'reaction-unavailable' },
      'Unavailable',
    ],
    [
      'hook-configuration-invalid',
      INVALID_HOOK,
      { code: 'configuration-invalid', issues: [{ path: ['channel'], code: 'invalid_type' }] },
      'Needs attention',
    ],
  ] as const) {
    test(`[${state}] /hooks and /hooks/:hook: a hook the Bureau lists with a ${problem.code} problem says ${word} in its row and its page, at ${width} pixels`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await openHooks(page, '/hooks', [record], {
        'bureau.hooks.list': () => ({
          hooks: [{ ...record, lastDelivery: DELIVERED, problems: [problem] }],
        }),
        // A reaction the Bureau does not register is one its plugin no longer contributes.
        ...(problem.code === 'reaction-unavailable'
          ? {
              'bureau.plugins.contributions': contributions(
                reaction('calendar', 'add', { availability: 'needs-setup' }),
              ),
            }
          : {}),
      });
      await expect(page.locator('[data-view="hooks"]')).toHaveAttribute('data-state', 'ready');
      const row = page.locator(`li[data-hook="${record.id}"]`);
      await expect(row.locator('.cinder-status-dot')).toHaveCount(1);
      await expect(row.locator('[data-status-word]')).toHaveAttribute('data-status-word', word);
      await captureForDesignReview(page, { route: '/hooks', state, source: SOURCE });

      // The hook's own page says the same word in its header.
      await page.goto(`/hooks/${record.id}`);
      const head = page.getByTestId('hook-header');
      await expect(head.locator('[data-status-word]')).toHaveAttribute('data-status-word', word);
      if (problem.code === 'reaction-unavailable') {
        // R10-17: one verdict. The stored pairs read only, and Send a test event is off with its reason.
        await expect(page.getByTestId('hook-test-reason')).toHaveText(
          copy.check.testNoLongerOffered('Slack'),
        );
        await expect(page.getByRole('button', { name: copy.check.test })).toHaveAttribute(
          'aria-disabled',
          'true',
        );
        await expect(page.getByTestId('contributed-action')).toHaveCount(0);
        await expect(page.getByTestId('stored-configuration')).toContainText(
          copy.action.storedConfiguration,
        );
      } else {
        // COR-2182: the sentence ends in the next step, and the field the Bureau names is marked.
        await expect(head.getByTestId('hook-standing-sentence')).toHaveText(
          standing.configurationInvalid('Slack', 'Post message', true),
        );
        const action = page.getByTestId('contributed-action');
        await expect(action.getByLabel('Channel')).toHaveAttribute('aria-invalid', 'true');
        await expect(action).toContainText(copy.action.configurationIssue('Slack'));
      }
      await captureForDesignReview(page, { route: '/hooks/:hook', state, source: SOURCE });
    });
  }
}

// R10-19: a saved plugin action with no dry run says why it has no test.
test('[plugin-hook-no-test] /hooks/:hook: a saved hook whose action has no test says so, and Send a test event is off', async ({
  page,
}) => {
  await openHooks(page, '/hooks/owner-plugin', [OWNER_PLUGIN_HOOK], {
    'bureau.plugins.contributions': contributions(
      reaction('slack', 'post-message', { dryRun: false }),
      reaction('calendar', 'add', { availability: 'needs-setup' }),
    ),
  });
  await expect(page.getByTestId('hook-test-reason')).toHaveText(copy.check.testNotOffered);
  await expect(page.getByRole('button', { name: copy.check.test })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await captureForDesignReview(page, {
    route: '/hooks/:hook',
    state: 'plugin-hook-no-test',
    source: SOURCE,
  });
});

// R10-13 and R10-11: the secret's list open, with one long key cut in its middle.
test('[plugin-hook-secret-list] /hooks/:hook: the secret Select lists the keys by plugin with Set or Missing, a long key cut in its middle', async ({
  page,
}) => {
  const longKey = 'slack-workspace-admin-bot-token-for-the-reviews-channel';
  await page.setViewportSize({ width: 1280, height: 900 });
  await openHooks(page, '/hooks/owner-plugin', [OWNER_PLUGIN_HOOK], {}, () => [
    pluginStanding('slack', 'Slack', 'running', [...SLACK_KEYS, { key: longKey, set: true }]),
    pluginStanding('pager', 'Pager', 'disabled'),
    pluginStanding('calendar', 'Calendar', 'needs-setup', [{ key: 'calendar-token', set: false }]),
  ]);
  const token = page.getByTestId('contributed-action').getByRole('combobox', { name: /^Token/ });
  await token.click();
  const long = page.getByRole('option', { name: new RegExp(`^${longKey}`) });
  await expect(long).toContainText('Set');
  await expect(long.locator('.cinder-text')).toHaveAttribute('data-cinder-truncate', 'middle');
  await captureForDesignReview(page, {
    route: '/hooks/:hook',
    state: 'plugin-hook-secret-list',
    source: SOURCE,
  });
  await page.keyboard.press('Escape');
});

// R10-13 at 320: a long key chosen in the secret Select is cut in its middle in the trigger, which
// stays inside the screen, and keeps the key's start and end.
test('[plugin-hook-secret-long-key] /hooks/:hook: a long key chosen at 320 pixels is cut in its middle in the trigger', async ({
  page,
}) => {
  const longKey = 'slack-workspace-admin-bot-token-for-the-reviews-channel';
  await page.setViewportSize({ width: 320, height: 900 });
  await openHooks(page, '/hooks/owner-plugin', [OWNER_PLUGIN_HOOK], {}, () => [
    pluginStanding('slack', 'Slack', 'running', [...SLACK_KEYS, { key: longKey, set: true }]),
    pluginStanding('pager', 'Pager', 'disabled'),
    pluginStanding('calendar', 'Calendar', 'needs-setup', [{ key: 'calendar-token', set: false }]),
  ]);
  const token = page.getByTestId('contributed-action').getByRole('combobox', { name: /^Token/ });
  await token.click();
  await page.getByRole('option', { name: new RegExp(`^${longKey}`) }).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
  const chosen = token.locator('.cinder-select__value .cinder-text');
  await expect(chosen).toHaveAttribute('data-cinder-truncate', 'middle');
  await expect(chosen.locator('.cinder-text__head')).toHaveText(/^slack-/);
  // The tail always shows; the head is what gives way, its box narrower than its text.
  await expect(chosen.locator('.cinder-text__tail')).toHaveText(/nnel$/);
  await expect
    .poll(() =>
      chosen.locator('.cinder-text__head').evaluate((head) => head.scrollWidth > head.clientWidth),
    )
    .toBe(true);
  const box = await token.boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(320);
  await captureForDesignReview(page, {
    route: '/hooks/:hook',
    state: 'plugin-hook-secret-long-key',
    source: SOURCE,
  });
});

// R10-23: the event picker's list open, each event in words.
for (const width of WIDTHS) {
  test(`[new-hook-event-picker] /hooks/new: the event picker lists events in words, at ${width} pixels`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await openHooks(page, '/hooks/new', []);
    const picker = page.getByRole('combobox', { name: copy.event.label });
    await picker.click();
    await expect(page.locator('[role="option"]').nth(5)).toBeVisible();
    await expect(page.getByRole('option', { name: 'A schedule misses a run' })).toBeAttached();
    await captureForDesignReview(page, {
      route: '/hooks/new',
      state: 'new-hook-event-picker',
      source: SOURCE,
    });
    await page.keyboard.press('Escape');
  });
}

// R10-20 holds at the narrowest phone too.
for (const width of [320, ...WIDTHS] as const) {
  test(`[new-hook-plugin-action] /hooks/new: every action choice is on screen, and a plugin’s action is chosen from a grouped Select, at ${width} pixels`, async ({
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
    // R10-21: the Action list open, grouped by plugin, at the smallest phone and on a desktop.
    if (width !== 375) {
      await captureForDesignReview(page, {
        route: '/hooks/new',
        state: 'new-hook-plugin-action-open',
        source: SOURCE,
      });
    }
    await page.getByRole('option', { name: /^Post message/ }).click();
    await expect(page.getByTestId('contributed-action').getByLabel('Channel')).toBeVisible();
    await checkA11y(`hooks — a new hook that runs a plugin’s action at ${width}px`);
  });
}

// ─── Plugin event kinds (COR-2226, critique rows R1 to R10) ────────────────────────────────────────
//
// The Bureau's catalog is stubbed with a few of its own kinds and the kinds two plugins declare, one
// name in both, so the picker's plugin groups, a chosen kind with its pin, and a saved hook whose
// kind is missing are drawn without a plugin that publishes. The plugins' titles come from the host.

/** A kind of the Bureau's catalog, or one a plugin declares when `source` and `version` are given. */
function catalogKind(kind: string, source?: string, version?: string) {
  return {
    kind,
    description: `What ${kind} means.`,
    origin: source === undefined ? 'run' : 'unattributed',
    payload: [],
    scopes: [],
    ...(source === undefined ? {} : { source, version }),
  };
}

const PLUGIN_EVENT_CATALOG = () => ({
  events: [
    catalogKind('review.requested'),
    catalogKind('run.settled'),
    catalogKind('schedule.missed'),
    catalogKind('reports:digest-ready', 'reports', '1.0.0'),
    catalogKind('reports:summary-sent', 'reports', '1.0.0'),
    catalogKind('archive:digest-ready', 'archive', '2.0.0'),
  ],
});

/** Slack as every state has it, and the two plugins that declare the kinds, under their titles. */
const EVENT_PLUGINS = () => [
  ...PLUGINS(),
  pluginStanding('reports', 'Weekly reports', 'running'),
  pluginStanding('archive', 'Archive', 'running'),
];

const DIGEST_HOOK = hookRecord('owner-digest', {
  name: 'Tell me when the digest is ready',
  action: { type: 'notify', title: null },
  events: ['reports:digest-ready@1.0.0', 'review.requested'],
  declaredBy: null,
});

// R1, R2, R8, R9: the picker open on the plugins' groups, at the smallest phone and on a desktop.
for (const width of [320, ...WIDTHS] as const) {
  test(`[new-hook-plugin-event-picker] /hooks/new: the event picker groups each plugin’s kinds under its title, after the Bureau’s areas, at ${width} pixels`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await openHooks(
      page,
      '/hooks/new',
      [],
      { 'bureau.events.catalog': PLUGIN_EVENT_CATALOG },
      EVENT_PLUGINS,
    );
    const picker = page.getByRole('combobox', { name: copy.event.label });
    await picker.click();
    const reports = page.getByRole('group', { name: /^Weekly reports/ });
    await expect(reports).toBeVisible();
    await expect(reports.getByRole('option')).toHaveCount(2);
    await expect(page.getByRole('group', { name: /^Archive/ }).getByRole('option')).toHaveCount(1);
    // The raw kind wraps rather than pushing the page sideways (R9).
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await captureForDesignReview(page, {
      route: '/hooks/new',
      state: 'new-hook-plugin-event-picker',
      source: SOURCE,
    });
    // R8: typing the plugin's title finds its kinds alone.
    await picker.fill('weekly');
    await expect(page.locator('[role="option"]')).toHaveCount(2);
    await captureForDesignReview(page, {
      route: '/hooks/new',
      state: 'new-hook-plugin-event-search',
      source: SOURCE,
    });
    await page.keyboard.press('Escape');
  });
}

/** A kind longer than a 320-pixel panel is wide (62 characters), under the Weekly reports title. */
const LONG_KIND = 'reports:weekly-digest-ready-for-every-workspace-member-to-read';

// R9: a raw kind longer than the phone's panel drops under its words and wraps there, whole words
// in its label, and nothing pushes the page sideways.
test('[new-hook-plugin-event-long] /hooks/new: a raw kind too long for the phone’s panel drops under its words, which stay whole, at 320 pixels', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await openHooks(
    page,
    '/hooks/new',
    [],
    {
      'bureau.events.catalog': () => ({
        events: [...PLUGIN_EVENT_CATALOG().events, catalogKind(LONG_KIND, 'reports', '1.0.0')],
      }),
    },
    EVENT_PLUGINS,
  );
  const picker = page.getByRole('combobox', { name: copy.event.label });
  await picker.click();
  await picker.fill('every workspace');
  const option = page.getByRole('option', { name: /^Weekly digest ready for every workspace/ });
  await expect(option).toBeVisible();
  const geometry = await option.evaluate((row) => {
    const label = row.querySelector('.cinder-combobox__option-label');
    const code = row.querySelector('.cinder-combobox__option-code');
    if (label === null || code === null) throw new Error('The option has no label or code.');
    const labelBox = label.getBoundingClientRect();
    const codeBox = code.getBoundingClientRect();
    // Each word of the label sits on one line: none is broken across two.
    const text = label.firstChild;
    const words: boolean[] = [];
    if (text !== null && text.nodeType === Node.TEXT_NODE) {
      for (const match of (text.textContent ?? '').matchAll(/\S+/g)) {
        const range = document.createRange();
        range.setStart(text, match.index);
        range.setEnd(text, match.index + match[0].length);
        words.push(
          new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size === 1,
        );
      }
    }
    return {
      codeBelowLabel: codeBox.top >= labelBox.bottom - 1,
      codeAtLabelStart: Math.abs(codeBox.left - labelBox.left) <= 1,
      labelWordsWhole: words.length > 0 && words.every(Boolean),
      rowRight: row.getBoundingClientRect().right,
      codeRight: codeBox.right,
    };
  });
  expect(geometry.codeBelowLabel).toBe(true);
  expect(geometry.codeAtLabelStart).toBe(true);
  expect(geometry.labelWordsWhole).toBe(true);
  expect(geometry.codeRight).toBeLessThanOrEqual(geometry.rowRight);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await captureForDesignReview(page, {
    route: '/hooks/new',
    state: 'new-hook-plugin-event-long',
    source: SOURCE,
  });
  await page.keyboard.press('Escape');
});

// R3, R4: a chosen plugin kind reads with its plugin's title first, and its raw kind carries its pin,
// muted; the Check line joins the chosen events, a comma only between two (B2).
for (const width of [320, ...WIDTHS] as const) {
  test(`[new-hook-plugin-event-chosen] /hooks/new: two plugins’ kinds of one name, chosen, never read the same, at ${width} pixels`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await openHooks(
      page,
      '/hooks/new',
      [],
      { 'bureau.events.catalog': PLUGIN_EVENT_CATALOG },
      EVENT_PLUGINS,
    );
    const picker = page.getByRole('combobox', { name: copy.event.label });
    for (const group of ['Weekly reports', 'Archive']) {
      await picker.click();
      await page
        .getByRole('group', { name: new RegExp(`^${group}`) })
        .getByRole('option', { name: /^Digest ready/ })
        .click();
    }
    const chosen = page.getByTestId('hook-events').locator('li.ib-hook-events__item');
    await expect(chosen.locator('.ib-hook-events__name')).toHaveText([
      'Weekly reports: digest ready',
      'Archive: digest ready',
    ]);
    await expect(chosen.locator('.ib-hook-events__kind')).toHaveText([
      'reports:digest-ready@1.0.0',
      'archive:digest-ready@2.0.0',
    ]);
    // B5: every row has one shape, and Remove sits at the same end edge on each, beside its text.
    const removeNamed = (name: string) =>
      chosen.getByRole('button', { name: copy.event.remove(name), exact: true });
    const boxes = await readBoxes(page, {
      first: chosen.nth(0),
      second: chosen.nth(1),
      firstRemove: removeNamed('Weekly reports: digest ready'),
      secondRemove: removeNamed('Archive: digest ready'),
      firstKind: chosen.nth(0).locator('.ib-hook-events__kind'),
      secondKind: chosen.nth(1).locator('.ib-hook-events__kind'),
    });
    const end = (box: { x: number; width: number }): number => box.x + box.width;
    expect(Math.abs(end(boxes.firstRemove) - end(boxes.secondRemove))).toBeLessThanOrEqual(1);
    expect(Math.abs(boxes.first.x - boxes.second.x)).toBeLessThanOrEqual(1);
    for (const [row, remove, kind] of [
      [boxes.first, boxes.firstRemove, boxes.firstKind],
      [boxes.second, boxes.secondRemove, boxes.secondKind],
    ] as const) {
      // Within its row, beside the text and never on a line of its own under it.
      expect(remove.y).toBeGreaterThanOrEqual(row.y);
      expect(remove.y + remove.height).toBeLessThanOrEqual(row.y + row.height);
      expect(end(kind)).toBeLessThanOrEqual(remove.x);
    }
    await captureForDesignReview(page, {
      route: '/hooks/new',
      state: 'new-hook-plugin-event-chosen',
      source: SOURCE,
    });
    const check = page.getByTestId('hook-check-events');
    await expect(check).toHaveText('Weekly reports: digest ready, Archive: digest ready');
    await check.scrollIntoViewIfNeeded();
    await captureForDesignReview(page, {
      route: '/hooks/new',
      state: 'new-hook-plugin-event-check',
      source: SOURCE,
    });
  });
}

// R4, R10: a saved hook on a plugin's kind, in its row and on its page.
for (const width of WIDTHS) {
  test(`[hook-plugin-event] /hooks and /hooks/:hook: a saved hook on a plugin’s kind names the plugin in its sentence and its pin on the locked When row, at ${width} pixels`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await openHooks(
      page,
      '/hooks',
      [DIGEST_HOOK],
      { 'bureau.events.catalog': PLUGIN_EVENT_CATALOG },
      EVENT_PLUGINS,
    );
    const row = page.locator(`li[data-hook="${DIGEST_HOOK.id}"]`);
    await expect(row).toContainText(
      'When Weekly reports: digest ready or a review is waiting, notify me',
    );
    await expect(row).not.toContainText('@1.0.0');
    await captureForDesignReview(page, {
      route: '/hooks',
      state: 'hook-plugin-event',
      source: SOURCE,
    });

    await page.goto(`/hooks/${DIGEST_HOOK.id}`);
    // A phone folds a saved hook's When step to a summary; Edit opens it on the locked row.
    if (width < 640) {
      await page
        .getByTestId('hook-step-summary-when')
        .getByRole('button', { name: copy.steps.edit })
        .click();
    }
    const locked = page.getByTestId('hook-event-locked');
    await expect(locked.locator('.ib-hook-events__kind')).toHaveText('reports:digest-ready@1.0.0');
    // Two events read as two: the plugin's title leads its kind (B2), and a Bureau event after the
    // first is lower-cased (N6).
    await expect(locked).toContainText('Weekly reports: digest ready, a review is waiting');
    await expect(page.getByTestId('hook-missing-events')).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/hooks/:hook',
      state: 'hook-plugin-event',
      source: SOURCE,
    });
  });
}

// R5, R6: a saved hook whose plugin kind is missing, its plugin gone or loaded at another version.
for (const width of WIDTHS) {
  for (const [state, loadedVersion, cause] of [
    ['hook-event-missing', null, copy.event.missing.notLoaded],
    ['hook-event-other-version', '1.1.0', copy.event.missing.otherVersion('1.0.0', '1.1.0')],
  ] as const) {
    test(`[${state}] /hooks and /hooks/:hook: a saved hook whose plugin kind is missing says Missing and why on its page, and why on line two of its row, at ${width} pixels`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const problem = { code: 'event-missing', kind: 'reports:digest-ready@1.0.0', loadedVersion };
      await openHooks(
        page,
        '/hooks',
        [DIGEST_HOOK],
        {
          'bureau.events.catalog': PLUGIN_EVENT_CATALOG,
          'bureau.hooks.list': () => ({
            hooks: [{ ...DIGEST_HOOK, lastDelivery: DELIVERED, problems: [problem] }],
          }),
        },
        EVENT_PLUGINS,
      );
      const row = page.locator(`li[data-hook="${DIGEST_HOOK.id}"]`);
      await expect(row.locator('.ib-hooks__line')).toContainText(cause);
      // No badge on line one: the hook is on, and its word is its last delivery's.
      await expect(row.locator('[data-status-word]')).toHaveAttribute(
        'data-status-word',
        'Delivered',
      );
      await captureForDesignReview(page, { route: '/hooks', state, source: SOURCE });

      await page.goto(`/hooks/${DIGEST_HOOK.id}`);
      const missing = page.getByTestId('hook-missing-events');
      await expect(missing).toContainText('Weekly reports: digest ready');
      await expect(missing.locator('[data-status-word="Missing"]')).toBeVisible();
      await expect(missing).toContainText(cause);
      // The cause is whole on line two, wrapped rather than ended in an ellipsis (B7).
      const causeText = missing.locator('.cinder-stacked-list-item__meta');
      await expect(causeText).toHaveText(cause);
      const cut = await causeText.evaluate(
        (cell) =>
          cell.scrollWidth > cell.clientWidth + 0.5 || cell.scrollHeight > cell.clientHeight + 0.5,
      );
      expect(cut, `${state}: the cause is not cut at ${width}`).toBe(false);
      await captureForDesignReview(page, { route: '/hooks/:hook', state, source: SOURCE });
    });
  }
}

// B6: on a phone the When step's Edit stays at the top inline end beside its summary and the
// Missing line, where the Then step's Edit sits, however long the text it sits beside.
test('[hook-event-missing-edit] /hooks/:hook: at 320 pixels the When step’s Edit sits at the top inline end, beside Missing, where the Then step’s Edit sits', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const problem = {
    code: 'event-missing',
    kind: 'reports:digest-ready@1.0.0',
    loadedVersion: null,
  };
  await openHooks(
    page,
    `/hooks/${DIGEST_HOOK.id}`,
    [DIGEST_HOOK],
    {
      'bureau.events.catalog': PLUGIN_EVENT_CATALOG,
      'bureau.hooks.list': () => ({
        hooks: [{ ...DIGEST_HOOK, lastDelivery: DELIVERED, problems: [problem] }],
      }),
    },
    EVENT_PLUGINS,
  );
  const when = page.getByTestId('hook-step-summary-when');
  const then = page.getByTestId('hook-step-summary-then');
  await expect(when.getByTestId('hook-missing-events')).toContainText(copy.event.missing.notLoaded);
  const whenEdit = when.getByRole('button', { name: copy.steps.edit });
  const thenEdit = then.getByRole('button', { name: copy.steps.edit });
  await expect(whenEdit).toBeVisible();
  await expect(thenEdit).toBeVisible();

  // Read together, from one layout.
  const boxes = await readBoxes(page, {
    summary: when,
    text: when.locator('.ib-hook-step__summary-text'),
    whenEdit,
    thenEdit,
  });
  const end = (box: { x: number; width: number }): number => box.x + box.width;
  // At the summary's inline end, and at the same edge as the Then step's Edit.
  expect(Math.abs(end(boxes.whenEdit) - end(boxes.summary))).toBeLessThanOrEqual(1);
  expect(Math.abs(end(boxes.whenEdit) - end(boxes.thenEdit))).toBeLessThanOrEqual(1);
  // At the top, beside the first line, never on a line of its own under the text.
  expect(Math.abs(boxes.whenEdit.y - boxes.summary.y)).toBeLessThanOrEqual(1);
  expect(end(boxes.text)).toBeLessThanOrEqual(boxes.whenEdit.x);
});
