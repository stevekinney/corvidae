/**
 * An open chat's header and composer controls (COR-1967), against the real host: the model, the
 * reasoning effort and the permission mode are always shown, each changes from the composer and is
 * kept across a reload, the note says when a change applies, and the context-window ring reads
 * `bureau.contexts.window` and opens to what fills the window. The cases run at a phone's width and
 * a desktop's, with axe passing. COR-1968 adds the More menu (rename, branch, export, delete), editing
 * a sent message by fork, and the abort of a cancelled upload on the server.
 */
import type { Page } from '@playwright/test';

import { MODEL_SWITCHER_MODELS } from '@lostgradient/plugin-demo';
import { CHAT_COPY } from '../../src/app/copy.ts';
import { UPLOAD_CHUNK_BYTES } from '../../src/lib/bureau-assets.ts';
import { newThreadId, runToEnd } from './chat-support.ts';
import { E2E_BASE_URL } from './e2e-constants.ts';
import { IMAGE_ECHO_AGENT_NAME } from './echo-agent.ts';
import { expect, test } from './fixtures.ts';
import { SINGLE_MODEL_AGENT_NAME } from './model-agents.ts';

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 1280, height: 800 },
] as const;

const [SONNET, HAIKU] = MODEL_SWITCHER_MODELS;

const model = (page: Page) => page.getByRole('combobox', { name: 'Model' });
const effort = (page: Page) => page.getByRole('combobox', { name: 'Effort' });
const permission = (page: Page) => page.getByRole('combobox', { name: 'Permissions' });
const summary = (page: Page, setting: string) => page.locator(`[data-setting="${setting}"]`);
const note = (page: Page) => page.getByTestId('chat-settings-note');

async function open(page: Page, request: Parameters<typeof runToEnd>[0], agent: string) {
  const threadId = newThreadId('header');
  await runToEnd(request, agent, threadId, 'Hello');
  await page.goto(`/chats/${threadId}`);
  await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
  return threadId;
}

for (const viewport of VIEWPORTS) {
  test(`shows the model, effort and permission mode and changes each, at ${viewport.width} pixels`, async ({
    page,
    request,
    checkA11y,
  }) => {
    await page.setViewportSize(viewport);
    await open(page, request, 'demo:model-switcher');

    // The header says what the chat runs with before anything was changed.
    await expect(summary(page, 'model')).toHaveText(SONNET.model);
    await expect(summary(page, 'effort')).toHaveText('Agent default');
    await expect(summary(page, 'permission')).toHaveText('Ask on changes');
    await checkA11y(`the chat header, at ${viewport.width} pixels`);

    // The permission mode changes from the composer, and says when it applies.
    await permission(page).selectOption('read-only');
    await expect(summary(page, 'permission')).toHaveText('Read-only');
    await expect(permission(page)).toBeEnabled();
    await expect(note(page)).toContainText('Applies to the next run.');
    await expect(note(page)).toContainText('Every tool that is not read-only is denied.');

    // So does the model, and the header follows it.
    await model(page).selectOption({ label: HAIKU.model });
    await expect(summary(page, 'model')).toHaveText(HAIKU.model);
    await expect(model(page)).toBeEnabled();

    // A reload shows the chat kept both.
    await page.reload();
    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
    await expect(summary(page, 'permission')).toHaveText('Read-only');
    await expect(summary(page, 'model')).toHaveText(HAIKU.model);
    await expect(permission(page)).toHaveValue('read-only');
    await checkA11y(`the chat header after changes, at ${viewport.width} pixels`);
  });

  test(`reads the context window and opens to its breakdown, at ${viewport.width} pixels`, async ({
    page,
    request,
    checkA11y,
  }) => {
    await page.setViewportSize(viewport);
    await open(page, request, 'demo:model-switcher');

    const ring = page.locator('.weft-context-ring');
    await expect(ring).toBeVisible();
    await expect(ring).toHaveAttribute('aria-label', /^Context window: .* Opens the breakdown$/);

    await ring.click();
    const panel = page.getByTestId('context-window');
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-category]')).toHaveCount(5);
    await expect(panel.locator('[data-category]').first()).toContainText('Instructions');
    await checkA11y(`the context window breakdown, at ${viewport.width} pixels`);
  });
}

test('changes the effort, says when it applies, and keeps it across a reload', async ({
  page,
  request,
}) => {
  await open(page, request, 'demo:model-switcher');

  await effort(page).selectOption('low');
  await expect(summary(page, 'effort')).toHaveText('Low');
  await expect(effort(page)).toBeEnabled();
  await expect(note(page)).toContainText('Applies to the next run.');

  await page.reload();
  await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
  await expect(summary(page, 'effort')).toHaveText('Low');
  await expect(effort(page)).toHaveValue('low');
});

test('shows the model of an agent that allows one, or none, though it offers no choice', async ({
  page,
  request,
}) => {
  await open(page, request, SINGLE_MODEL_AGENT_NAME);
  await expect(summary(page, 'model')).toHaveText(SONNET.model);
  await expect(model(page)).toBeDisabled();
  await expect(model(page).locator('option')).toHaveText([SONNET.model]);

  await open(page, request, 'demo:echo');
  await expect(summary(page, 'model')).toHaveText('Agent default');
  await expect(model(page)).toBeDisabled();
});

// The header's More menu and editing a sent message (COR-1968).
const MORE = CHAT_COPY.more;
const USER_ROW = '[data-message-role="user"]';
const ASSISTANT_ROW = '[data-message-role="assistant"]';

const moreButton = (page: Page) => page.getByRole('button', { name: MORE.label });
const header = (page: Page) => page.getByTestId('chat-header');

/** A chat of `demo:model-switcher` with two finished turns, opened on its page. */
async function openTwoTurns(
  page: Page,
  request: Parameters<typeof runToEnd>[0],
  label: string,
): Promise<string> {
  const threadId = newThreadId(label);
  await runToEnd(request, 'demo:model-switcher', threadId, 'First question');
  await runToEnd(request, 'demo:model-switcher', threadId, 'Second question');
  await page.goto(`/chats/${threadId}`);
  await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator(ASSISTANT_ROW)).toHaveCount(2);
  return threadId;
}

/** The Bureau's answer to `method`, as JSON. */
async function bureauCall(
  request: Parameters<typeof runToEnd>[0],
  method: string,
  params: Record<string, unknown>,
): Promise<{ result?: Record<string, unknown>; error?: { data?: { weftCode?: string } } }> {
  const response = await request.post(`${E2E_BASE_URL}/bureau/jsonrpc`, {
    data: { jsonrpc: '2.0', id: 1, method, params },
  });
  return (await response.json()) as never;
}

for (const viewport of VIEWPORTS) {
  test(`renames the chat from the More menu and keeps the title across a reload, at ${viewport.width} pixels`, async ({
    page,
    request,
    checkA11y,
  }) => {
    await page.setViewportSize(viewport);
    const threadId = await open(page, request, 'demo:model-switcher');

    await moreButton(page).click();
    await expect(page.getByRole('menuitem')).toHaveText([
      new RegExp(MORE.rename),
      new RegExp(MORE.branch),
      new RegExp(MORE.export),
      new RegExp(MORE.delete),
    ]);
    await checkA11y(`the chat's More menu, at ${viewport.width} pixels`);
    await page.getByRole('menuitem', { name: MORE.rename }).click();
    const field = page.getByRole('textbox', { name: MORE.renameDialog.label });
    await expect(field).toHaveValue('Hello');
    await field.fill('Quarterly plan');
    await checkA11y(`the rename dialog, at ${viewport.width} pixels`);
    await page.getByRole('button', { name: MORE.renameDialog.save }).click();

    await expect(header(page).getByRole('heading', { level: 1 })).toHaveText('Quarterly plan');
    await expect(field).toHaveCount(0);
    await page.reload();
    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
    await expect(header(page).getByRole('heading', { level: 1 })).toHaveText('Quarterly plan');
    const renamed = await bureauCall(request, 'bureau.contexts.get', { contextId: threadId });
    expect(renamed.result).toMatchObject({ title: 'Quarterly plan' });
  });
}

test('branches from the last reply with the More menu', async ({ page, request }) => {
  const parentId = await openTwoTurns(page, request, 'more-branch');

  await moreButton(page).click();
  await page.getByRole('menuitem', { name: MORE.branch }).click();

  await expect(page).toHaveURL(
    (url) => url.pathname.startsWith('/chats/') && url.pathname !== `/chats/${parentId}`,
  );
  await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator(USER_ROW)).toHaveCount(2);
  await expect(page.locator(ASSISTANT_ROW)).toHaveCount(2);
  await expect(page.locator('.weft-chat-header__origin')).toContainText(
    CHAT_COPY.branch.branchedFrom,
  );
});

test('exports the conversation as a Markdown file', async ({ page, request }) => {
  await openTwoTurns(page, request, 'export');

  await moreButton(page).click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: MORE.export }).click();
  const file = await download;

  expect(file.suggestedFilename()).toMatch(/^First question-\d{4}-\d{2}-\d{2}\.md$/);
  const stream = await file.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  expect(text).toContain('# First question');
  expect(text).toContain('## You\n\nFirst question');
  expect(text).toContain('## You\n\nSecond question');
  expect(text).toContain('## Assistant');
});

test('deletes the chat after asking, and returns to the list', async ({
  page,
  request,
  checkA11y,
}) => {
  const threadId = await open(page, request, 'demo:model-switcher');

  await moreButton(page).click();
  await page.getByRole('menuitem', { name: MORE.delete }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(MORE.deleteDialog.title('Hello'));
  await checkA11y('the delete confirmation');
  // Keeping the chat sends nothing.
  await dialog.getByRole('button', { name: MORE.deleteDialog.cancel }).click();
  await expect(dialog).toHaveCount(0);
  const kept = await bureauCall(request, 'bureau.contexts.get', { contextId: threadId });
  expect(kept.result).toBeDefined();

  await moreButton(page).click();
  await page.getByRole('menuitem', { name: MORE.delete }).click();
  await page.getByRole('dialog').getByRole('button', { name: MORE.deleteDialog.confirm }).click();

  await expect(page).toHaveURL(/\/chats$/);
  const gone = await bureauCall(request, 'bureau.contexts.get', { contextId: threadId });
  expect(gone.error?.data?.weftCode).toBe('NotFound');
});

test('editing a sent message resends by fork, and leaves the original chat as it was', async ({
  page,
  request,
  checkA11y,
}) => {
  const parentId = await openTwoTurns(page, request, 'edit');

  const second = page.locator(USER_ROW).filter({ hasText: 'Second question' });
  await second.hover();
  await page.getByRole('button', { name: 'Edit message' }).last().click();
  const editor = page.getByRole('textbox', { name: 'Edit message content' });
  await editor.fill('A better second question');
  await checkA11y('editing a sent message');
  await page.getByRole('button', { name: 'Save & Resend' }).click();

  await expect(page).toHaveURL(
    (url) => url.pathname.startsWith('/chats/') && url.pathname !== `/chats/${parentId}`,
  );
  await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
  const rows = page.locator(USER_ROW);
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('First question');
  await expect(rows.last()).toContainText('A better second question');
  await expect(page.locator(ASSISTANT_ROW)).toHaveCount(2);
  await expect(page.locator('.weft-chat-header__origin')).toContainText(
    CHAT_COPY.branch.branchedFrom,
  );

  // The chat it was edited in still holds the question as it was sent.
  await page.goto(`/chats/${parentId}`);
  await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator(USER_ROW).last()).toContainText('Second question');
  await expect(page.locator(USER_ROW).last()).not.toContainText('better');
});

test('aborts the upload on the server when the person cancels an attachment', async ({
  page,
  request,
}) => {
  const uploads: Array<{ method: string; uploadId: string | undefined }> = [];
  let held: (() => void) | undefined;
  const secondChunkReached = new Promise<void>((resolve) => (held = resolve));
  let appends = 0;
  await page.route('**/bureau/jsonrpc', async (route) => {
    const body = route.request().postDataJSON() as {
      method: string;
      params?: { uploadId?: string };
    };
    if (body.method.startsWith('bureau.assets.uploads.')) {
      uploads.push({ method: body.method, uploadId: body.params?.uploadId });
    }
    if (body.method === 'bureau.assets.uploads.append' && (appends += 1) === 2) {
      // The second chunk is left unanswered, so the upload is mid-flight when it is cancelled.
      held?.();
      return;
    }
    return route.continue();
  });
  await page.goto(`/chats/new?agent=${IMAGE_ECHO_AGENT_NAME}`);
  await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');

  await page.locator('input[type="file"]').setInputFiles({
    name: 'big.png',
    mimeType: 'image/png',
    buffer: Buffer.alloc(UPLOAD_CHUNK_BYTES * 3, 1),
  });
  await secondChunkReached;
  await page.getByRole('button', { name: 'Remove big.png' }).click();

  await expect
    .poll(() => uploads.map((upload) => upload.method))
    .toContain('bureau.assets.uploads.abort');
  const uploadId = uploads.find(
    (upload) => upload.method === 'bureau.assets.uploads.append',
  )?.uploadId;
  expect(uploadId).toBeDefined();
  expect(uploads.filter((upload) => upload.method === 'bureau.assets.uploads.append')).toHaveLength(
    2,
  );
  // The session is gone on the Bureau: it takes no more chunks.
  const late = await bureauCall(request, 'bureau.assets.uploads.append', {
    uploadId,
    chunk: btoa('x'),
  });
  expect(late.error?.data?.weftCode).toBe('NotFound');
});
