/**
 * An open chat's composer controls (COR-1967), against the real host: the model, the reasoning
 * effort and the permission mode are ghost selects on the composer's control row, each changes from
 * there and is kept across a reload, the line under the composer says when a change applies, and the
 * context meter and the header's context-window ring read
 * `bureau.contexts.window` and opens to what fills the window. The cases run at a phone's width and
 * a desktop's, with axe passing. COR-1968 adds the More menu (rename, branch, export, delete), editing
 * a sent message by fork, and the abort of a cancelled upload on the server.
 */
import type { Page } from '@playwright/test';

import { MODEL_SWITCHER_MODELS } from '@lostgradient/plugin-demo';
import { CHAT_COPY } from '../../src/app/copy/chat.ts';
import { UPLOAD_CHUNK_BYTES } from '../../src/lib/bureau-assets.ts';
import { hideModelPicker, newThreadId, revealSettings, runToEnd } from './chat-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
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
/** Opens a ghost select and chooses the option with these words. */
async function choose(page: Page, select: ReturnType<typeof model>, label: string) {
  await select.click();
  await page.getByRole('option', { name: label }).click();
}
const note = (page: Page) => page.locator('.chat-input-status');

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
    // A composer too narrow for the three values in full folds them into one Settings control; open it.
    await revealSettings(page, [
      { name: 'Model', text: SONNET.model },
      { name: 'Effort', text: 'Agent default' },
      { name: /Permissions/, text: 'On changes asks' },
    ]);

    // The composer says what the chat runs with before anything was changed.
    await expect(model(page)).toContainText(SONNET.model);
    await expect(effort(page)).toContainText('Agent default');
    await expect(permission(page)).toContainText('On changes asks');
    await checkA11y(`the chat composer, at ${viewport.width} pixels`);

    // The permission mode changes from the composer, and says when it applies.
    await choose(page, permission(page), 'Read-only');
    await expect(permission(page)).toContainText('Read-only');
    await expect(permission(page)).toBeEnabled();
    await expect(note(page)).toHaveText('Permissions Read-only applies to the next run.');

    // So does the model.
    await choose(page, model(page), HAIKU.model);
    await expect(model(page)).toContainText(HAIKU.model);
    await expect(model(page)).toBeEnabled();

    // A reload shows the chat kept both.
    await page.reload();
    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
    await revealSettings(page, [
      { name: /Permissions/, text: 'Read-only' },
      { name: 'Model', text: HAIKU.model },
    ]);
    await expect(permission(page)).toContainText('Read-only');
    await expect(model(page)).toContainText(HAIKU.model);
    await checkA11y(`the chat composer after changes, at ${viewport.width} pixels`);
  });

  test(`reads the context window and opens to its breakdown, at ${viewport.width} pixels`, async ({
    page,
    request,
    checkA11y,
  }) => {
    await page.setViewportSize(viewport);
    await open(page, request, 'demo:model-switcher');

    // One meter, by Send in the composer, reading a percentage (COR-2438); the header has none.
    await expect(page.locator('[data-testid="chat-header"] .weft-context-meter')).toHaveCount(0);
    const meter = page.locator('.chat-input-footer-right .weft-context-meter');
    await expect(meter).toBeVisible();
    await expect(meter).toHaveAttribute('aria-label', /^Context window: .* Opens the breakdown$/);
    await expect(meter.locator('.weft-context-meter__reading')).toHaveText(/^\d+%$/);

    await meter.click();
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
  await revealSettings(page, [
    { name: 'Model', text: SONNET.model },
    { name: 'Effort', text: 'Agent default' },
  ]);

  await choose(page, effort(page), 'Low');
  await expect(effort(page)).toContainText('Low');
  await expect(effort(page)).toBeEnabled();
  await expect(note(page)).toHaveText('Effort Low applies to the next run.');

  await page.reload();
  await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
  await revealSettings(page, [
    { name: 'Model', text: SONNET.model },
    { name: 'Effort', text: 'Low' },
  ]);
  await expect(effort(page)).toContainText('Low');
});

test('shows the model of an agent that allows one, or none, though it offers no choice', async ({
  page,
  request,
}) => {
  await open(page, request, SINGLE_MODEL_AGENT_NAME);
  await revealSettings(page, [{ name: 'Model', text: SONNET.model }]);
  await expect(model(page)).toContainText(SONNET.model);
  await expect(model(page)).toBeDisabled();

  // A scripted agent runs on no model, so its composer has Permissions only.
  await hideModelPicker(page);
  await open(page, request, 'demo:echo');
  await revealSettings(page);
  await expect(permission(page)).toBeVisible();
  await expect(model(page)).toHaveCount(0);
  await expect(effort(page)).toHaveCount(0);
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
      // Anchored: "Archive" is also the end of "Unarchive".
      new RegExp(`^\\s*${MORE.archive}\\s*$`),
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

/**
 * In one layout: the vertical centre of the first line box of the chat's title, measured on its
 * words rather than the h1, how many lines show and whether words are cut off, the More menu's
 * centre, the status Badge's box and tone, and the header band's rule against the route's edges.
 */
async function headerCentres(page: Page) {
  return header(page).evaluate((root, moreLabel) => {
    const heading = root.querySelector('h1');
    if (heading === null) throw new Error('The header has no title.');
    const headingBox = heading.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(heading);
    const rects = [...range.getClientRects()].filter((rect) => rect.height > 0);
    const first = rects[0];
    if (first === undefined) throw new Error('The title has no line boxes.');
    // A clamped title lays out its hidden lines too: only the lines inside the heading show. A line
    // is inside when its centre is: a glyph box is taller than the title's tight line (28px against
    // 27.6px at 1280), so the first hidden line's top sits just above the heading's bottom edge.
    const shown = rects.filter((rect) => rect.top + rect.height / 2 < headingBox.bottom);
    const more = [...root.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === moreLabel,
    );
    if (more === undefined) throw new Error('The More menu is missing.');
    const moreBox = more.getBoundingClientRect();
    const badge = root.querySelector('.cinder-page-header__status .cinder-badge');
    const badgeBox = badge?.getBoundingClientRect();
    const band = root.closest('.weft-chat-head');
    const route = root.closest('.weft-chat-route');
    const bandBox = band?.getBoundingClientRect();
    const routeBox = route?.getBoundingClientRect();
    return {
      title: first.top + first.height / 2,
      titleBottom: first.bottom,
      headingBottom: headingBox.bottom,
      lines: new Set(shown.map((rect) => Math.round(rect.top))).size,
      cut: rects.length > shown.length || heading.scrollWidth > heading.clientWidth + 0.5,
      more: moreBox.top + moreBox.height / 2,
      status:
        badgeBox === undefined
          ? undefined
          : {
              centre: badgeBox.top + badgeBox.height / 2,
              top: badgeBox.top,
              tone: badge?.getAttribute('data-cinder-variant') ?? '',
              dot: root.querySelector('.cinder-page-header__status .cinder-status-dot') !== null,
            },
      rule:
        band === null || route === null || bandBox === undefined || routeBox === undefined
          ? undefined
          : {
              width: getComputedStyle(band).borderBottomWidth,
              left: bandBox.left - routeBox.left,
              right: routeBox.right - bandBox.right,
            },
      boxed: getComputedStyle(root).borderTopWidth !== '0px',
    };
  }, MORE.label);
}

// COR-2438: the title keeps one line and takes the free space first; the More menu shares the
// centre of its line, and the status Badge does too while it fits beside the title, or else sits
// under it. No box frames the header, and its rule runs edge to edge of the conversation pane.
// 768 and 375 are the narrow header, where the status sits under the one-line title and the More
// menu keeps the title's line (the review captured it on the status's line, 30px lower).
for (const width of [1280, 1920, 900, 768, 375]) {
  test(`keeps the title to one line, the More menu and the status on its centre line or the status under it, at ${width} pixels`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const threadId = newThreadId('header-align');
    await runToEnd(
      request,
      'demo:model-switcher',
      threadId,
      'Which agents are on this Bureau? Use your discover-agents tool to find out, then list each of them with what it does and who may run it.',
    );
    await page.goto(`/chats/${threadId}`);
    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
    await expect(moreButton(page)).toBeVisible();

    const measured = await headerCentres(page);
    // 18a: one line, cut with an ellipsis, the full title in its tooltip.
    expect(measured.lines).toBe(1);
    expect(measured.cut).toBe(true);
    // 18f and 15: the More menu centres on the title's first line.
    expect(
      Math.abs(measured.more - measured.title),
      `More at ${measured.more}, the title's first line at ${measured.title}`,
    ).toBeLessThanOrEqual(2);
    // 18b: the status is a Badge, never a dot; beside the title it shares the line, or it is under.
    expect(measured.status).toBeDefined();
    expect(measured.status!.dot).toBe(false);
    expect(measured.status!.tone).toBe('success');
    if (measured.status!.top < measured.titleBottom) {
      expect(Math.abs(measured.status!.centre - measured.title)).toBeLessThanOrEqual(2);
    } else {
      expect(measured.status!.top).toBeGreaterThanOrEqual(measured.headingBottom - 0.5);
    }
    // 18e: no box, and the rule spans the pane.
    expect(measured.boxed).toBe(false);
    expect(measured.rule).toBeDefined();
    expect(measured.rule!.width).toBe('1px');
    expect(Math.abs(measured.rule!.left)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(measured.rule!.right)).toBeLessThanOrEqual(0.5);
    // 18d and 19: one meter, by Send, reading a percentage.
    await expect(header(page).locator('.weft-context-meter, .weft-context-ring')).toHaveCount(0);
    await expect(page.locator('.chat-input-footer-right .weft-context-meter')).toHaveCount(1);
    await expect(page.locator('.chat-input-hint')).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: `header with a long title at ${width} pixels`,
      source: 'tests/e2e/chat-header.spec.ts',
    });
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

test('aborts the upload on the server when the person cancels an attachment', async ({
  page,
  request,
}) => {
  const uploads: Array<{ method: string; uploadId: string | undefined }> = [];
  let held: (() => void) | undefined;
  const secondChunkReached = new Promise<void>((resolve) => (held = resolve));
  let appends = 0;
  await page.route('**/jsonrpc', async (route) => {
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
