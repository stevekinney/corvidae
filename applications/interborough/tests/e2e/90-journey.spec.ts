/**
 * The journey (COR-1496): one person, signed in as nobody because the host asks for no sign-in,
 * goes through the whole application in the order a first day would. The file is serial and holds
 * one `test()` per stage, so each stage has its own timeout and a failure names the stage. A stage
 * builds on the ones before it, so a run that is cut short fails at the first stage it cannot do.
 *
 * It opens the journey's own host (`e2e-server.ts`): the Bureau's engine is its console, which the
 * Workflows area needs to show a schedule's fire, and its agents and barrier are its own. Every
 * model is scripted, so no provider key is read: the human-input agent, the barrier, and the echoes
 * are the seeded and extra agents, the author the journey defines in the editor runs through the
 * scripted provider resolver (`journey-agent.ts`), and the workflow it writes runs `assistant`.
 *
 * Nothing waits on a clock. A wait is for something the page shows, or for a route of the harness
 * (the barrier's), and the only one that waits on time at all is the run of a 5 second schedule:
 * the runs page opened before the first fire shows no runs, asks again every few seconds, and the
 * journey waits for its first row.
 */
import type { APIRequestContext, Page } from '@playwright/test';

import {
  AGENT_EDITOR_COPY,
  MEMORY_COPY,
  SCHEDULE_COPY,
  TASK_COPY,
  WORKFLOW_COPY,
} from '../../src/app/copy.ts';
import { describeCadence } from '../../src/routes/schedules/cadence.ts';
import { bureau, readAgent, removeAgent } from './agent-support.ts';
import { conversation } from './chat-support.ts';
import { E2E_BARRIER_URL, E2E_JOURNEY_URL } from './e2e-constants.ts';
import { IMAGE_ECHO_AGENT_NAME } from './echo-agent.ts';
import { expect, test } from './fixtures.ts';
import {
  JOURNEY_AUTHOR_REPLY,
  JOURNEY_MARKER,
  JOURNEY_TOOL_NAME,
  JOURNEY_WORKFLOW_CADENCE,
  JOURNEY_WORKFLOW_ID,
  RECALL_AGENT_NAME,
} from './journey-agent.ts';
import { jsonEditor, jsonEditorSource } from './json-editor-support.ts';
import { expectEngineMissesForRuns, waitingReviewOf } from './task-support.ts';
import { removeWorkflow } from './workflow-support.ts';

test.use({ baseURL: E2E_JOURNEY_URL, viewport: { width: 1280, height: 900 } });
test.describe.configure({ mode: 'serial' });

const AUTHOR_ID = 'journey-author';
const AUTHOR_NAME = 'Journey author';
const BARRIER_REPLY = 'The barrier opened.';
const FOLLOW_UP_REPLY = 'The follow-up was delivered.';
const QUESTION = 'Which environment should the release go to?';
/** What the person types into the inbox, and so what the run must be given. */
const ENVIRONMENT_ANSWER = 'staging';
const THANKS = 'Thanks, the release will go to the environment you named.';

/** A 1 x 1 PNG: real bytes, so the Bureau detects its type and a browser decodes it. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** A token no other run of the journey uses, so the labels it stores are its own. */
const RUN = crypto.randomUUID().slice(0, 8);

/** A row of the transcript the agent wrote. */
const ASSISTANT_ROW = '.chat-message-wrapper[data-role="assistant"]';

const composer = (page: Page) => page.getByRole('textbox');

async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

/** The session the address names. */
function sessionOf(page: Page): string {
  return decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1) ?? '');
}

const sessionAddress = /\/chats\/(?!new(?:$|\?))[^/?]+$/;

/** Sends a follow-up and waits for the Bureau to answer it, so what follows acts on an admitted input. */
async function sendFollowUp(page: Page, text: string): Promise<void> {
  const answered = page.waitForResponse(
    (response) =>
      response.url().endsWith('/bureau/jsonrpc') &&
      (response.request().postData() ?? '').includes('"bureau.contexts.input"'),
  );
  await send(page, text);
  await answered;
}

/** The journey host's barrier: how many runs are held on it, and a release of all of them. */
async function waitingOnBarrier(request: APIRequestContext): Promise<number> {
  const response = await request.get(`${E2E_BARRIER_URL}/journey/waiting`);
  return ((await response.json()) as { waiting: number }).waiting;
}

async function expectWaiting(request: APIRequestContext, count: number): Promise<void> {
  await expect.poll(() => waitingOnBarrier(request)).toBe(count);
}

async function releaseBarrier(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${E2E_BARRIER_URL}/journey/release`);
  expect(response.ok()).toBe(true);
}

/** The transcript's text, so the order of what it shows can be asserted. */
async function transcriptText(page: Page): Promise<string> {
  return (await page.locator('[data-session]').textContent()) ?? '';
}

/** The sessions this run of the journey makes, in the order it makes them. */
const sessions: { followUp?: string; second?: string } = {};

/** Forgets what `echo-recall` remembers, so a run recalls only what it stored itself. */
async function forgetEverythingRecalled(request: APIRequestContext): Promise<void> {
  const listed = await bureau(request, 'bureau.memory.list', {
    agentId: RECALL_AGENT_NAME,
    limit: 100,
  });
  const { memories } = (listed.result ?? { memories: [] }) as { memories: Array<{ id: string }> };
  for (const { id } of memories) {
    await bureau(request, 'bureau.memory.forget', { agentId: RECALL_AGENT_NAME, id });
  }
}

test.beforeAll(async ({ playwright }) => {
  // Playwright starts its own host for every run, so nothing is left over; this keeps a run that
  // is pointed at a host which was used before from tripping over what that host holds.
  const request = await playwright.request.newContext({ baseURL: E2E_JOURNEY_URL });
  try {
    await removeAgent(request, AUTHOR_ID);
    await removeWorkflow(request, JOURNEY_WORKFLOW_ID);
    await forgetEverythingRecalled(request);
  } finally {
    await request.dispose();
  }
});

test.afterAll(async ({ playwright }) => {
  // Whatever a failed stage left held on the barrier ends with the run.
  const request = await playwright.request.newContext();
  try {
    await request.post(`${E2E_BARRIER_URL}/journey/release`);
  } finally {
    await request.dispose();
  }
});

test('chats with the barrier agent, sends a follow-up while it works, and sees it delivered', async ({
  page,
  request,
}) => {
  await page.goto('/agents/barrier');
  await page.getByRole('link', { name: 'New chat' }).first().click();
  await expect(page).toHaveURL(/\/chats\/new\?agent=barrier$/);

  await send(page, 'Start the journey');
  await expect(page).toHaveURL(sessionAddress);
  sessions.followUp = sessionOf(page);
  await expectWaiting(request, 1);

  await sendFollowUp(page, 'Also this');
  await releaseBarrier(request);

  // The same run answers the follow-up after the reply it arrived during.
  await expect(conversation(page).getByText(FOLLOW_UP_REPLY)).toBeVisible();
  const text = await transcriptText(page);
  expect(text.indexOf(BARRIER_REPLY)).toBeLessThan(text.indexOf('Also this'));
  expect(text.indexOf('Also this')).toBeLessThan(text.indexOf(FOLLOW_UP_REPLY));
  await expect(conversation(page).getByText('Also this')).toHaveCount(1);
  await expectWaiting(request, 0);
});

test('lands in the session it just made when it starts from /', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveURL(new RegExp(`/chats/${sessions.followUp}$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Start the journey');
});

test('starts a second session with the same agent from the agent’s page, and returns to the first from /chats', async ({
  page,
  request,
}) => {
  await page.goto('/agents/barrier');
  await page.getByRole('link', { name: 'New chat' }).first().click();
  await send(page, 'A second journey');
  await expect(page).toHaveURL(sessionAddress);
  sessions.second = sessionOf(page);
  expect(sessions.second).not.toBe(sessions.followUp);
  await expectWaiting(request, 1);
  await releaseBarrier(request);
  await expect(conversation(page).getByText(BARRIER_REPLY)).toBeVisible();

  await page.goto('/chats');
  await page
    .getByRole('region', { name: 'Chats' })
    .getByRole('button', { name: /Start the journey/ })
    .click();

  await expect(page).toHaveURL(new RegExp(`/chats/${sessions.followUp}$`));
  await expect(conversation(page).getByText(FOLLOW_UP_REPLY)).toBeVisible();
  await expect(conversation(page).getByText('Also this')).toHaveCount(1);
});

test('reloads while an agent waits on a question, and answers it from the reviews inbox', async ({
  page,
  request,
  checkA11y,
}) => {
  await page.goto('/chats/new?agent=request-human-input');
  await send(page, 'Ship it');
  await expect(page).toHaveURL(sessionAddress);
  const threadId = sessionOf(page);
  const question = page.getByRole('alert').filter({ hasText: QUESTION });
  await expect(question).toBeVisible();

  await page.reload();
  await expect(question).toBeVisible();

  const review = await waitingReviewOf(request, threadId, E2E_JOURNEY_URL);
  await page.goto(`/reviews?review=${encodeURIComponent(`bureau:${review.id}`)}`);
  const row = page.locator(`[data-review-row="bureau:${review.id}"]`);
  const pane = page.locator('.ib-review-pane');
  await expect(row).toContainText(QUESTION);
  await expect(pane).toContainText(QUESTION);
  await checkA11y('the question in the reviews inbox');
  await pane.getByLabel('Your answer').fill(ENVIRONMENT_ANSWER);
  await pane.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(row).toHaveCount(0);

  // The run went on with the answer: its session ends on the thanks, and the answer it was given
  // is the one typed, as the run's conversation holds it.
  await page.goto(`/chats/${threadId}`);
  await expect(conversation(page).getByText(THANKS)).toBeVisible();
  await expect(question).toHaveCount(0);
  const thread = await request.get(
    `/bureau/ag-ui/threads/${encodeURIComponent(threadId)}/messages`,
  );
  expect(thread.ok()).toBe(true);
  const { messages } = (await thread.json()) as { messages: Array<{ content?: string }> };
  const answers = messages.filter((message) => message.content?.startsWith('[signal:environment]'));
  expect(answers.map((message) => message.content)).toEqual([
    `[signal:environment] ${JSON.stringify(ENVIRONMENT_ANSWER)}`,
  ]);
});

test('defines an agent in the editor with the workflow tool, and chats with it until it writes a scheduled workflow', async ({
  page,
  request,
}) => {
  await page.goto('/agents/new');
  await expect(page.locator('[data-view="agent-editor"]')).toHaveAttribute('data-state', 'ready');
  await page.getByRole('textbox', { name: /^Name/ }).fill(AUTHOR_NAME);
  await expect(page.getByRole('textbox', { name: /^Identifier/ })).toHaveValue(AUTHOR_ID);
  await page
    .getByRole('textbox', { name: /^Instructions/ })
    .fill('Write the workflows a person asks for, with the workflow tools.');
  await page.getByRole('checkbox', { name: new RegExp(JOURNEY_TOOL_NAME) }).check();
  await page.getByRole('button', { name: AGENT_EDITOR_COPY.createAction }).click();
  await expect(page).toHaveURL(new RegExp(`/agents/${AUTHOR_ID}$`));

  // `bureau:workflows-create` changes the deployment, so a new agent asks before each call, and no one in
  // this journey answers the inbox for it. The file sets the tool to `never`, as a person who
  // trusts the agent with it would, through the management plane the editor saves with.
  const created = await readAgent(request, AUTHOR_ID);
  const approved = await bureau(request, 'bureau.agents.definitions.update', {
    id: AUTHOR_ID,
    expectedHash: created.hash,
    definition: { ...created.definition, toolApproval: { [JOURNEY_TOOL_NAME]: 'never' } },
  });
  expect(approved.fault, 'setting the tool to never').toBeUndefined();

  // A new agent takes a chat as soon as it is saved: nothing has to be switched on first.
  await page.getByRole('link', { name: 'New chat' }).first().click();
  await expect(page).toHaveURL(new RegExp(`/chats/new\\?agent=${AUTHOR_ID}$`));

  await send(page, `${JOURNEY_MARKER} Write me a digest that runs on a schedule.`);

  await expect(conversation(page).getByText(JOURNEY_AUTHOR_REPLY)).toBeVisible();
  await expect(
    conversation(page)
      .getByText(/workflows-create/)
      .first(),
  ).toBeVisible();
  // The agent wrote the file, which the Bureau reports as an agent-authored workflow of its own.
  const written = await bureau(request, 'bureau.workflows.get', { id: JOURNEY_WORKFLOW_ID });
  expect(written.fault).toBeUndefined();
  expect(written.result).toMatchObject({
    id: JOURNEY_WORKFLOW_ID,
    state: 'ready',
    agent: AUTHOR_ID,
  });
});

test('opens the workflow from /workflows, waits for the schedule’s fire to be listed as a run, and opens that run', async ({
  page,
}) => {
  await page.goto('/workflows');
  const row = page.locator(`[data-workflow="${JOURNEY_WORKFLOW_ID}"]`);
  await expect(row).toHaveAttribute('data-kind', 'agent-authored');
  await row.getByRole('link', { name: JOURNEY_WORKFLOW_ID, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/workflows/${JOURNEY_WORKFLOW_ID}$`));
  const detail = page.locator('[data-page="workflow-detail"]');
  await expect(detail.getByTestId('workflow-trigger')).toHaveText(
    describeCadence({ intervalMs: 5_000 }),
  );
  await expect(detail.getByTestId('workflow-agent')).toContainText(AUTHOR_ID);

  // The schedule fires every few seconds. This page may open before the first fire, says there are
  // no runs, and asks again until there is one, so the wait is for its first row.
  await detail.getByRole('tab', { name: WORKFLOW_COPY.page.tabs.runs }).click();
  await detail.getByRole('link', { name: WORKFLOW_COPY.runsAction, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/workflows/${JOURNEY_WORKFLOW_ID}/runs$`));
  const runs = page.locator('tbody tr');
  await expect(runs.first()).toBeVisible({ timeout: 30_000 });
  for (const text of await runs.allTextContents()) expect(text).toContain(JOURNEY_WORKFLOW_ID);

  await runs.first().getByRole('link').first().click();
  await expect(page).toHaveURL(/\/runs\/[^/]+$/);
  // The run's page also links its schedule, `bureau-workflow-schedule:journey-digest:1`, and its
  // breadcrumb names the workflow, so the type's link is the one named exactly inside the Details rail.
  await expect(
    page
      .getByRole('complementary', { name: 'Details' })
      .getByRole('link', { name: JOURNEY_WORKFLOW_ID, exact: true }),
  ).toHaveAttribute('href', `/workflows/${JOURNEY_WORKFLOW_ID}`);
});

test('follows the schedule’s link to the workflow editor, changes its cadence to one hour, and sees it on /schedules', async ({
  page,
}) => {
  await page.goto('/schedules');
  const file = page
    .locator('li[data-kind="workflow-file"]')
    .filter({ has: page.getByRole('link', { name: JOURNEY_WORKFLOW_ID, exact: true }) });
  await expect(file).toContainText(describeCadence({ intervalMs: 5_000 }));
  // A workflow file's schedule has no Edit of its own: its cadence is the trigger in the file.
  await file.getByRole('button', { name: /^Actions for / }).click();
  const workflowEditor = page.getByRole('menuitem', { name: SCHEDULE_COPY.editWorkflowAction });
  await expect(workflowEditor).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Edit', exact: true })).toHaveCount(0);
  await workflowEditor.click();
  await expect(page).toHaveURL(new RegExp(`/workflows/${JOURNEY_WORKFLOW_ID}/edit$`));

  const root = page.locator('[data-page="workflow-editor"]');
  const editor = await jsonEditor(root, WORKFLOW_COPY.editor.textLabel);
  const document = JSON.parse(await jsonEditorSource(editor)) as Record<string, unknown>;
  expect(document['trigger']).toEqual({ kind: 'schedule', spec: JOURNEY_WORKFLOW_CADENCE });
  document['trigger'] = { kind: 'schedule', spec: '1h' };
  await editor.fill(JSON.stringify(document, null, 2));
  await root.getByRole('button', { name: WORKFLOW_COPY.editor.saveAction }).click();
  await expect(page).toHaveURL(new RegExp(`/workflows/${JOURNEY_WORKFLOW_ID}$`));

  // The schedule follows the file, which also ends the fire every few seconds.
  await page.goto('/schedules');
  const hourly = page
    .locator('li[data-kind="workflow-file"]')
    .filter({ has: page.getByRole('link', { name: JOURNEY_WORKFLOW_ID, exact: true }) });
  await expect(hourly).toContainText(describeCadence({ intervalMs: 3_600_000 }));
  await expect(hourly).not.toContainText(describeCadence({ intervalMs: 5_000 }));
});

test('attaches an image to the echo agent and sees the image it returns', async ({ page }) => {
  await page.goto(`/chats/new?agent=${IMAGE_ECHO_AGENT_NAME}`);
  await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PIXEL });
  await expect(page.locator('.chat-attachment-preview')).toHaveAttribute('data-state', 'ready');

  await send(page, 'Say it back');

  await expect(conversation(page).getByText('Echoed 1 image.')).toBeVisible();
  const returned = page.locator('ul.weft-chat-assets[data-role="assistant"] img');
  await expect(returned).toHaveAttribute('src', /\/bureau\/assets\/[^/]+\/content$/);
  await expect
    .poll(() => returned.evaluate((image) => (image as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
});

test('corrects what an agent remembers, and a new chat recalls the correction and not the original', async ({
  page,
}) => {
  const original = `Original ${RUN} seat 12A`;
  const correction = `Corrected ${RUN} seat 14C`;
  const memoryAddress = `/agents/${RECALL_AGENT_NAME}/memories`;

  // With nothing recalled the agent echoes the label, and the chat stores that answer.
  await page.goto(`/chats/new?agent=${RECALL_AGENT_NAME}`);
  await send(page, original);
  await expect(page).toHaveURL(sessionAddress);
  await expect(page.locator(ASSISTANT_ROW).last()).toContainText(original);

  await page.goto(memoryAddress);
  const stored = page.locator('.weft-memory__content', { hasText: original });
  await expect(stored).toHaveText(original);
  // The correction starts from the row itself: hover it, then press its Correct.
  const row = page.locator('[data-memory]', { hasText: original });
  await row.hover();
  await row.getByRole('button', { name: new RegExp(`^${MEMORY_COPY.correct.action}:`) }).click();
  const dialog = page.getByRole('dialog', { name: MEMORY_COPY.correct.dialog.title });
  await dialog.getByLabel(MEMORY_COPY.correct.dialog.label).fill(correction);
  await dialog.getByRole('button', { name: MEMORY_COPY.correct.dialog.submit }).click();
  await expect(page.getByText(MEMORY_COPY.correct.saved.title, { exact: true })).toBeVisible();
  await expect(page.locator('.weft-memory__content', { hasText: correction })).toHaveText(
    correction,
  );
  await expect(page.locator('.weft-memory__content', { hasText: original })).toHaveCount(0);

  // A new chat that names the label is answered with what the agent remembers now.
  await page.goto(`/chats/new?agent=${RECALL_AGENT_NAME}`);
  await send(page, `Recall ${RUN}`);
  await expect(page).toHaveURL(sessionAddress);
  const reply = page.locator(ASSISTANT_ROW).last();
  await expect(reply).toContainText(correction);
  await expect(reply).not.toContainText(original);
});

test('starts a run it does not release, reaches it from the chat’s run sentence, and cancels it', async ({
  page,
  request,
  pageErrors,
}) => {
  expectEngineMissesForRuns(pageErrors);
  await page.goto(`/chats/new?agent=barrier`);
  await send(page, 'Hold this task');
  await expect(page).toHaveURL(sessionAddress);
  await expectWaiting(request, 1);

  await page.getByRole('link', { name: '1 run is working' }).click();
  await expect(page).toHaveURL(/\/runs\/[^/]+$/);
  await expect(
    page.locator('[data-run-header]').getByText('Running', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Cancel run', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel run', exact: true }).click();

  await expect(page.getByText(TASK_COPY.cancel['cleaned-up'])).toBeVisible();
  await expect(
    page.locator('[data-run-header]').getByText('Canceled', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel run' })).toHaveCount(0);
  // Cancelling ended the run that was held, so nothing is left on the barrier.
  await expectWaiting(request, 0);
});

test('opens the workers screen from Health, which the sidebar opens', async ({ page }) => {
  await page.goto('/agents');
  await page
    .getByRole('navigation', { name: 'Views' })
    .getByRole('link', { name: /^Health/ })
    .click();
  await expect(page).toHaveURL(/\/health$/);
  await page
    .getByRole('navigation', { name: 'Health sections' })
    .getByRole('link', { name: 'Workers' })
    .click();

  await expect(page).toHaveURL(/\/health\/workers$/);
  await expect(page.locator('[data-view="workers"]')).toHaveAttribute('data-state', 'ready');
});
