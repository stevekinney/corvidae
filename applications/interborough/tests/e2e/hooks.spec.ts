/**
 * `/hooks` (COR-1858): a hook is made in the editor from an event chosen in the searchable picker,
 * an address and a signing secret, and it fires: a test event reaches a receiver the spec runs,
 * signed, and a real event (a chat starting) reaches it too, and both deliveries show beside the
 * editor. The list reads each hook as a sentence, puts a failing hook first, and turns a hook off
 * with its switch. Hooks is in the sidebar, and `g` then `h` opens it. The pages pass axe at the
 * two widths.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { APIRequestContext, Page } from '@playwright/test';

import { HOOKS_COPY } from '../../src/routes/hooks/hook-copy.ts';
import { deleteChats, newThreadId, runToEnd } from './chat-support.ts';
import { expect, test } from './fixtures.ts';
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
  await page.getByLabel(copy.webhook.secretLabel).fill(SECRET);
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

  await chooseEvent(page, 'review', 'Review requested');
  await fillWebhook(page, receiverUrl, name);
  await expect(page.getByTestId('hook-sentence')).toContainText(
    `When Review requested, send a signed message to ${receiverUrl}`,
  );
  await page.getByRole('button', { name: copy.check.create }).click();

  // The hook is made and its page opens, where the delivery log is beside the steps.
  await expect(page).toHaveURL(/\/hooks\/(?!new$)[^/?]+$/);
  await expect(page.getByRole('heading', { level: 1, name: copy.editTitle })).toBeVisible();
  const deliveries = page.getByTestId('hook-deliveries');
  await expect(deliveries.getByText(copy.deliveries.none)).toBeVisible();
  // The secret is never shown again.
  await expect(page.getByLabel(copy.webhook.secretLabel)).toHaveValue('');
  await expect(page.getByText(copy.check.testReaches(receiverUrl))).toBeVisible();

  await page.getByRole('button', { name: copy.check.test }).click();

  const sent = await requestOfKind('hook.test');
  expect(sent.headers['x-signature']).toMatch(/^t=\d+,v1=[0-9a-f]+$/);
  expect(JSON.parse(sent.body)).toMatchObject({ kind: 'hook.test', test: true });
  await expect(deliveries.getByText(copy.deliveries.testEvent)).toBeVisible();
  await expect(deliveries.getByText('Answered 200')).toBeVisible();
  await checkA11y('hooks — the editor with a delivery');
});

test('fires for a real event, and shows that delivery beside the test', async ({
  page,
  request,
}) => {
  const name = `${PREFIX} real event`;
  await page.goto('/hooks/new');
  await chooseEvent(page, 'chat created', 'Chat created');
  await fillWebhook(page, receiverUrl, name);
  await page.getByRole('button', { name: copy.check.create }).click();
  await expect(page.getByRole('heading', { level: 1, name: copy.editTitle })).toBeVisible();

  const thread = newThreadId('hooks');
  try {
    await runToEnd(request, TEXT_ECHO_AGENT_NAME, thread, 'Say something');
    const fired = await requestOfKind('session.created');
    expect(fired.headers['x-signature']).toMatch(/^t=\d+,v1=[0-9a-f]+$/);

    await page.reload();
    const deliveries = page.getByTestId('hook-deliveries');
    await expect(deliveries.getByText('Chat created')).toBeVisible();
    await expect(deliveries.getByText('Answered 200').first()).toBeVisible();
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
  const brokenRow = page.locator(`tr[data-hook="${broken.id}"]`);
  const goodRow = page.locator(`tr[data-hook="${good.id}"]`);
  await expect(brokenRow.locator('[data-status-word="Failed"]')).toBeVisible();
  await expect(goodRow.getByText('Answered 200')).toBeVisible();
  // The failing hook comes before the one that delivered, though it was made after it.
  const order = await page
    .locator('tr[data-hook]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-hook')));
  expect(order.indexOf(broken.id)).toBeLessThan(order.indexOf(good.id));
  await expect(
    brokenRow.getByRole('link', {
      name: 'When Goal failed or Goal canceled, send a signed message to http://127.0.0.1:9/receive',
    }),
  ).toBeVisible();

  const toggle = goodRow.getByRole('switch');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await page.reload();
  await expect(page.locator(`tr[data-hook="${good.id}"]`).getByRole('switch')).toHaveAttribute(
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
    await expect(page.locator(`tr[data-hook="${hook.id}"]`)).toContainText(
      'When Schedule missed, notify me',
    );
    await page.getByRole('searchbox', { name: HOOKS_COPY.searchLabel }).fill('schedule missed');
    await expect(page.locator(`tr[data-hook="${hook.id}"]`)).toBeVisible();
    await page.getByRole('searchbox', { name: HOOKS_COPY.searchLabel }).fill('no hook says this');
    await expect(
      page.getByRole('heading', { level: 2, name: HOOKS_COPY.noMatch.title }),
    ).toBeVisible();
    await page.getByRole('button', { name: HOOKS_COPY.clearAction }).click();
    await expect(page.locator(`tr[data-hook="${hook.id}"]`)).toBeVisible();
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
    ['schedule.missed', 'Schedule missed'],
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
  await page.keyboard.press('h');
  await expect(page).toHaveURL(/\/hooks$/);
});
