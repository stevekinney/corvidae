/**
 * The states of the Agents and Reviews pages that COR-2429 and COR-2426 drew and no other
 * specification opens, each captured for the design review (`design-review-capture.ts`): on an
 * agent, the Disable question, a disabled agent with Enable agent, the read-only composer of its
 * chat, the Forgot toast with Undo, a memory whose chat was deleted, the Restore question, an agent
 * with skills of its own (its header and Access tab) and one with reference documents; in Reviews,
 * the list loading, an approval resolved elsewhere leaving its row, more than one page of Done, a
 * workflow's review with its step and its author's message, and a denied approval under Done.
 *
 * Everything runs on the real host. Where a state depends on what another client did first (an
 * approval decided elsewhere, a memory's chat deleted, a Done list longer than a page, a workflow
 * review), the one Bureau answer that says so is stood in for in the page, and everything else is
 * real. Each case puts back
 * what it changed: the agent it disabled is enabled, the memory it forgot is kept, and the agents
 * and chats it made are removed.
 */
import type { APIRequestContext, Page, Route } from '@playwright/test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { designReviewCaptureDirectory } from '../../scripts/environment-configuration.ts';

import { AGENT_EDITOR_COPY, AGENT_PAGE_COPY } from '../../src/app/copy/agents.ts';
import { MEMORY_COPY } from '../../src/app/copy/memory.ts';
import { REVIEWS_COPY } from '../../src/app/copy/reviews.ts';
import { REVIEW_ALREADY_RESOLVED } from '../../src/lib/bureau-reviews.ts';
import {
  agentDirectory,
  bureau,
  createAgentFile,
  readAgent,
  removeAgent,
} from './agent-support.ts';
import { deleteChats, newThreadId, runToEnd } from './chat-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';
import { SINGLE_MODEL_AGENT_NAME } from './model-agents.ts';
import { E2E_SKILLS } from './skills-support.ts';
import { bureauCall, waitingReviewOf } from './task-support.ts';
import { TEXT_ECHO_AGENT_NAME } from './text-echo-agent.ts';

const WIDTHS = designReviewCaptureDirectory() === undefined ? [375, 1280] : [1280, 768, 375];
const SOURCE = 'agents-reviews-design-states.spec.ts';
const settingsCopy = AGENT_PAGE_COPY.settings;
const editorCopy = AGENT_EDITOR_COPY;

/** The chats a case started, deleted once it ends, whether it passed or not. */
const threads: string[] = [];

test.afterEach(async () => {
  await deleteChats(threads.splice(0));
});

/** A label no other case stores: it is both what the echo agent is sent and what it remembers. */
const uniqueLabel = (prefix: string) => `${prefix} ${crypto.randomUUID().slice(0, 8)}`;

/** Enables `id` again when a case left it disabled; an agent already enabled is left as it is. */
async function enableAgain(request: APIRequestContext, id: string): Promise<void> {
  await bureau(request, 'bureau.agents.enable', { id });
}

/**
 * Answers every Bureau call named `method` with `answer(route)`, and sends the rest on. The browser's
 * generated client posts to the host's composed `/jsonrpc`, so that is the route stood in for.
 */
async function standIn(
  page: Page,
  method: string,
  answer: (route: Route, call: { id?: unknown; params?: Record<string, unknown> }) => Promise<void>,
): Promise<void> {
  await page.route('**/jsonrpc', async (route) => {
    const call = route.request().postDataJSON() as {
      method?: string;
      id?: unknown;
      params?: Record<string, unknown>;
    };
    if (call.method !== method) {
      await route.fallback();
      return;
    }
    await answer(route, call);
  });
}

/** The real answer to a call, with its `result` changed by `change`. */
async function changedAnswer(route: Route, change: (result: Record<string, unknown>) => void) {
  const response = await route.fetch();
  const body = (await response.json()) as { result?: Record<string, unknown> };
  if (body.result !== undefined) change(body.result);
  await route.fulfill({ response, json: body });
}

const ORDERS = ['4471', '4472', '4480', '4493', '4501'] as const;

/** Twenty-five approvals decided over the last day, latest first, as `bureau.reviews.list` gives them. */
function decidedApprovals(now: number): Record<string, unknown>[] {
  return Array.from({ length: 25 }, (_, index) => {
    const decidedAt = now - (index + 1) * 47 * 60_000;
    const denied = index % 4 === 1;
    const order = ORDERS[index % ORDERS.length] ?? '4471';
    return {
      source: 'bureau',
      kind: 'tool-approval',
      id: `design-decided-${String(index)}`,
      runId: `design-run-${String(index)}`,
      sessionId: `design-session-${String(index)}`,
      agentName: 'demo:tool-runner',
      requestedAt: decidedAt - 90_000,
      ageMilliseconds: now - decidedAt + 90_000,
      status: denied ? 'denied' : 'approved',
      round: 0,
      approval: {
        callId: `design-call-${String(index)}`,
        toolName: 'demo:issue-refund',
        arguments: { orderId: `order-${order}`, cents: 4200 + index * 100 },
        action: { type: 'approval', risk: 'medium', operation: { kind: 'other' } },
      },
      resolution: {
        decision: denied ? 'deny' : 'approve',
        decidedBy: 'anonymous:local',
        decidedAt,
        decisionSurface: 'reviews',
      },
    };
  });
}

for (const width of WIDTHS) {
  test.describe(`/agents design states at ${width} pixels`, () => {
    test(`/agents/:agent/settings asks before Disable, offers Enable agent once disabled, and /chats/:chat of the agent is read-only, at ${width} pixels`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const threadId = newThreadId('design-disabled-agent');
      threads.push(threadId);
      await runToEnd(request, SINGLE_MODEL_AGENT_NAME, threadId, 'Which model is this?');
      try {
        await page.goto(`/agents/${SINGLE_MODEL_AGENT_NAME}/settings`);
        await page.getByRole('button', { name: settingsCopy.disable.action }).click();
        const question = page.getByRole('dialog');
        await expect(question).toBeVisible();
        await captureForDesignReview(page, {
          route: '/agents/:agent/settings',
          state: 'disable question',
          source: SOURCE,
        });

        await question.getByRole('button', { name: settingsCopy.disable.dialog.confirm }).click();
        await expect(
          page.getByRole('button', { name: settingsCopy.disable.enable, exact: true }),
        ).toBeVisible();
        await captureForDesignReview(page, {
          route: '/agents/:agent/settings',
          state: 'disabled, with Enable agent',
          source: SOURCE,
        });

        await page.goto(`/chats/${encodeURIComponent(threadId)}`);
        // The composer says so in place (its live region repeats it for a screen reader).
        await expect(
          page
            .getByRole('group', { name: 'Composer unavailable' })
            .getByText(/is disabled, so this chat is read-only/),
        ).toBeVisible();
        await captureForDesignReview(page, {
          route: '/chats/:chat',
          state: 'its agent disabled, read-only composer',
          source: SOURCE,
        });
      } finally {
        await enableAgain(request, SINGLE_MODEL_AGENT_NAME);
      }
    });

    test(`/agents/:agent/memory shows Forgot with Undo, and a memory whose chat was deleted, at ${width} pixels`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const forgotten = uniqueLabel('Order 4471 arrived damaged');
      const forgotThread = newThreadId('design-forgot');
      threads.push(forgotThread);
      await runToEnd(request, TEXT_ECHO_AGENT_NAME, forgotThread, forgotten);
      const orphan = uniqueLabel('Prefers refunds to store credit');
      const deletedThread = newThreadId('design-deleted-source');
      threads.push(deletedThread);
      await runToEnd(request, TEXT_ECHO_AGENT_NAME, deletedThread, orphan);
      // The chat it came from was deleted: the Bureau answers it as one it does not hold.
      await standIn(page, 'bureau.contexts.get', async (route, call) => {
        if (call.params?.['contextId'] !== deletedThread) {
          await route.fallback();
          return;
        }
        await route.fulfill({
          json: {
            jsonrpc: '2.0',
            id: call.id,
            error: {
              code: -32000,
              message: `No context with id "${deletedThread}"`,
              data: { httpStatus: 404, weftCode: 'NotFound', resource: 'session' },
            },
          },
        });
      });

      await page.goto(`/agents/${TEXT_ECHO_AGENT_NAME}/memory`);
      const detail = page.getByRole('region', { name: MEMORY_COPY.detail.heading });
      const rowOf = (text: string) => page.locator('[data-memory]', { hasText: text });

      await rowOf(orphan).locator('.ib-memory__content').click();
      await expect(detail.locator('h2', { hasText: orphan })).toBeVisible();
      await expect(detail).toContainText(MEMORY_COPY.detail.cameFrom.deleted);
      await captureForDesignReview(page, {
        route: '/agents/:agent/memory',
        state: 'a memory whose chat was deleted',
        source: SOURCE,
      });

      await page.goto(`/agents/${TEXT_ECHO_AGENT_NAME}/memory`);
      await rowOf(forgotten).locator('.ib-memory__content').click();
      await expect(detail.locator('h2', { hasText: forgotten })).toBeVisible();
      await detail.getByRole('button', { name: MEMORY_COPY.forget.iconLabel }).click();
      const toast = page.locator('.cinder-toast[data-cinder-undo]');
      await expect(toast).toContainText('Forgot');
      await captureForDesignReview(page, {
        route: '/agents/:agent/memory',
        state: 'forgot, with Undo',
        source: SOURCE,
      });
      // Undo keeps it, while the toast is still up; the captures can outlast it, and then the
      // memory, which only this case stored, is simply forgotten.
      const undo = toast.getByRole('button', { name: 'Undo' });
      if (await undo.isVisible()) {
        await undo.click();
        // At a phone width the open memory fills the page, so the list is read on its own.
        await page.goto(`/agents/${TEXT_ECHO_AGENT_NAME}/memory`);
        await expect(rowOf(forgotten)).toHaveCount(1);
      }
    });

    test(`/agents/:agent/settings asks before Restore, at ${width} pixels`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const id = `e2e-design-restore-${String(width)}`;
      try {
        const created = await createAgentFile(request, id, {
          name: 'Refund helper',
          instructions: 'Answer refund questions.',
        });
        const before = await readAgent(request, id);
        const saved = await bureau(request, 'bureau.agents.definitions.update', {
          id,
          expectedHash: created.hash,
          definition: {
            ...before.definition,
            instructions: 'Answer refund questions.\nRefunds over $25 need approval.',
          },
        });
        expect(saved.fault).toBeUndefined();

        await page.goto(`/agents/${id}/settings`);
        const versions = page.getByTestId('agent-versions');
        await expect(versions.locator('[data-revision]')).toHaveCount(2);
        await versions
          .getByRole('button', { name: AGENT_PAGE_COPY.versions.restoreLabel(1) })
          .click();
        await expect(page.getByRole('dialog', { name: 'Restore Version 1?' })).toBeVisible();
        await captureForDesignReview(page, {
          route: '/agents/:agent/settings',
          state: 'restore question',
          source: SOURCE,
        });
      } finally {
        await removeAgent(request, id);
      }
    });

    test(`/agents/:agent, /agents/:agent/access and /agents/:agent/instructions show the agent’s own skills in its header and on Access, and its reference documents, at ${width} pixels`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const id = `e2e-design-skills-${String(width)}`;
      const directory = await agentDirectory(request);
      const references = join(directory, 'references');
      await mkdir(references, { recursive: true });
      const policy = join(references, `refund-policy-${String(width)}.md`);
      await writeFile(policy, '# Refund policy\n\nRefunds over $25 need approval.\n');
      try {
        await createAgentFile(request, id, {
          name: 'Support lead',
          skills: [E2E_SKILLS.summarize.name],
          references: [`references/refund-policy-${String(width)}.md`],
        });

        await page.goto(`/agents/${id}/access`);
        await expect(page.getByTestId('agent-header')).toBeVisible();
        await expect(
          page
            .getByTestId('agent-access-skills')
            .locator(`[data-skill="${E2E_SKILLS.summarize.name}"] input[type="checkbox"]`),
        ).toBeChecked();
        await captureForDesignReview(page, {
          route: '/agents/:agent/access',
          state: 'its own skills',
          source: SOURCE,
        });

        await page.goto(`/agents/${id}/instructions`);
        await expect(page.getByTestId('agent-references')).toContainText('refund-policy');
        await captureForDesignReview(page, {
          route: '/agents/:agent/instructions',
          state: 'with reference documents',
          source: SOURCE,
        });
      } finally {
        await removeAgent(request, id);
        await rm(policy, { force: true });
      }
    });
  });

  test.describe(`/reviews design states at ${width} pixels`, () => {
    test(`/reviews loads, and an approval resolved elsewhere leaves its row, then is Denied under Done, at ${width} pixels`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      // Held until the capture is taken, so the list is still loading.
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await standIn(page, 'bureau.reviews.list', async (route) => {
        await held;
        await route.fallback();
      });
      await page.goto('/reviews');
      // The page draws its own loading (row 26a): its heading and segments at once, and three
      // placeholder rows in the list.
      await expect(
        page.getByRole('main').getByRole('heading', { name: REVIEWS_COPY.heading, level: 1 }),
      ).toBeVisible();
      await expect(page.locator('.cinder-list-detail__loading')).toBeVisible();
      await captureForDesignReview(page, {
        route: '/reviews',
        state: 'loading',
        source: SOURCE,
      });
      release();
      await page.unrouteAll({ behavior: 'wait' });

      const threadId = newThreadId('design-resolved-elsewhere');
      threads.push(threadId);
      await runToEnd(request, 'demo:tool-runner', threadId, 'Refund order-1001');
      const review = await waitingReviewOf(request, threadId);
      // Another client denies it first, for real, so the Bureau no longer lists it, and the page's
      // decision is answered as one already resolved, as the Bureau answers it.
      await standIn(page, 'bureau.reviews.resolve', async (route, call) => {
        await bureauCall(request, 'bureau.reviews.resolve', {
          id: review.id,
          decision: 'deny',
          reason: 'Not this order',
        });
        await route.fulfill({
          json: {
            jsonrpc: '2.0',
            id: call.id,
            error: {
              code: -32000,
              message: 'Review is already resolved',
              data: {
                httpStatus: 409,
                weftCode: 'Conflict',
                reason: `${REVIEW_ALREADY_RESOLVED}: Review is already resolved`,
              },
            },
          },
        });
      });
      await page.goto(`/reviews?review=${encodeURIComponent(`bureau:${review.id}`)}`);
      const pane = page.locator('.ib-review-pane');
      await expect(pane).toContainText('Refund order order-1001');
      await pane.getByRole('button', { name: 'Approve' }).click();
      await expect(page.getByTestId('review-gone')).toBeVisible();
      await captureForDesignReview(page, {
        route: '/reviews',
        state: 'resolved elsewhere, row leaving',
        source: SOURCE,
      });
      // After a moment the row leaves the list, and that is announced as a decision is (row 26h).
      await expect(page.locator(`[data-review-row="bureau:${review.id}"]`)).toHaveCount(0);
      await expect(page.getByTestId('reviews-announcement')).toContainText('Refund order');
      await captureForDesignReview(page, {
        route: '/reviews',
        state: 'resolved elsewhere, row left',
        source: SOURCE,
      });
      await page.unrouteAll({ behavior: 'wait' });

      await page.goto('/reviews?tab=done');
      await expect(page.locator(`[data-review-row="bureau:${review.id}"]`)).toContainText('Denied');
      await captureForDesignReview(page, {
        route: '/reviews',
        tab: 'done',
        state: 'a denied approval',
        source: SOURCE,
      });
    });

    test(`/reviews shows a workflow’s review with its step and message, and a Done list longer than a page, at ${width} pixels`, async ({
      page,
      pageErrors,
    }) => {
      pageErrors.expect({
        pattern: loggedFailedResponse(500, /reviews\/[^/]+\/decision/),
        reason: 'the test answers the workflow review’s decision with a 500, for its error toast',
      });
      await page.setViewportSize({ width, height: 900 });
      const now = Date.now();
      const workflowReview = {
        source: 'engine',
        kind: 'engine-review',
        id: 'design-release-notes-review',
        runId: 'release-notes-7f3a',
        requestedAt: now - 12 * 60_000,
        ageMilliseconds: 12 * 60_000,
        status: 'pending',
        reviewType: 'content',
        reviewers: ['you'],
        allowPartial: false,
        workflowName: 'release-notes',
        step: 'Collect merged changes',
        message: 'Here is the draft. Approve it to publish, or send it back with a note.',
        artifact: {
          title: 'Release 4.2',
          summary: 'Faster refunds, a clearer Reviews page, and agents you can disable.',
        },
      };
      await standIn(page, 'bureau.reviews.list', async (route, call) => {
        const resolved = call.params?.['status'] === 'resolved';
        await changedAnswer(route, (result) => {
          if (resolved) {
            // A first page of 25 of the 40 decided, the real ones first.
            const real = Array.isArray(result['reviews']) ? result['reviews'] : [];
            result['reviews'] = [...real, ...decidedApprovals(now)].slice(0, 25);
            result['total'] = 40;
            result['nextPageToken'] = 'design-next-page';
            return;
          }
          const reviews = Array.isArray(result['reviews']) ? result['reviews'] : [];
          result['reviews'] = [workflowReview, ...reviews];
          if (typeof result['total'] === 'number') result['total'] += 1;
        });
      });

      await page.goto(`/reviews?review=${encodeURIComponent(`engine:${workflowReview.id}`)}`);
      await expect(page.getByTestId('review-intro')).toHaveText(workflowReview.message);
      // The list row says the draft's title, as the pane's heading does (row 25o).
      await expect(page.getByRole('heading', { level: 2, name: 'Release 4.2' })).toBeVisible();
      // On a phone, Send back and Approve are in view above the tab bar before anything is
      // scrolled (row 25q).
      const approve = page.locator('.cinder-docked-action-bar').getByRole('button', {
        name: 'Approve',
      });
      await expect(approve).toBeInViewport();
      // Both edges read in one pass: the Approve button ends above where the tab bar starts.
      const overlap = await page.evaluate(() => {
        const tabs = document.querySelector('.weft-shell-tab-bar');
        const buttons = [...document.querySelectorAll('.cinder-docked-action-bar button')];
        const button = buttons.find((candidate) => candidate.textContent?.trim() === 'Approve');
        if (tabs === null || button === undefined || tabs.getBoundingClientRect().height === 0) {
          return 0;
        }
        return button.getBoundingClientRect().bottom - tabs.getBoundingClientRect().top;
      });
      expect(overlap).toBeLessThanOrEqual(0);
      await captureForDesignReview(page, {
        route: '/reviews',
        state: 'a workflow review',
        source: SOURCE,
      });

      // The decision fails: an error toast that stays until it is dismissed comes up while the
      // docked Send back and Approve are on screen, so the two are drawn together (design review 3).
      await page.route('**/reviews/*/decision', async (route) => {
        await route.fulfill({ status: 500, json: { error: 'The engine broke.' } });
      });
      await approve.click();
      const toast = page.locator('.cinder-toast').first();
      await expect(toast).toBeVisible();
      await toast.evaluate((element) =>
        Promise.all(
          element.getAnimations({ subtree: true }).map((animation) => animation.finished),
        ),
      );
      await captureForDesignReview(page, {
        route: '/reviews',
        state: 'a workflow review, with an error toast',
        source: SOURCE,
      });
      await page.unroute('**/reviews/*/decision');

      await page.goto('/reviews?tab=done');
      await expect(page.getByRole('button', { name: REVIEWS_COPY.loadMore })).toBeVisible();
      await captureForDesignReview(page, {
        route: '/reviews',
        tab: 'done',
        state: 'more than one page',
        source: SOURCE,
      });
    });
  });
}

test.describe('Agent shared FormActions', () => {
  for (const width of WIDTHS) {
    test(`captures a saved agent's shared FormActions at ${width} pixels`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const id = `e2e-design-shared-actions-${String(width)}`;
      try {
        await createAgentFile(request, id, {
          name: 'Shared actions agent',
          instructions: 'Answer the question.',
        });
        await page.goto(`/agents/${id}/edit`);
        const actions = page.getByRole('group', { name: 'Form actions' });
        await expect(actions).toBeVisible();
        await expect(actions.getByRole('switch', { name: editorCopy.a2aLabel })).toBeVisible();
        await expect(actions.getByText(editorCopy.a2aDescription, { exact: true })).toBeVisible();
        await expect(actions.getByRole('button')).toHaveText([
          editorCopy.cancelAction,
          editorCopy.saveAction,
        ]);
        await captureForDesignReview(page, {
          route: '/agents/:agent/edit',
          state: 'shared FormActions, saved agent',
          source: SOURCE,
        });
      } finally {
        await removeAgent(request, id);
      }
    });
  }

  for (const width of WIDTHS) {
    test(`keeps the shared FormActions beside a duplicate refusal at ${width} pixels`, async ({
      page,
      pageErrors,
    }) => {
      pageErrors.expectEvery({
        pattern: loggedFailedResponse(409, /\/jsonrpc/),
        reason: 'the Bureau refuses the identifier that the new agent name generated',
      });
      await page.setViewportSize({ width, height: 900 });
      let attempts = 0;
      await standIn(page, 'bureau.agents.definitions.create', async (route, call) => {
        attempts += 1;
        await route.fulfill({
          status: 409,
          json: {
            jsonrpc: '2.0',
            id: call.id,
            error: {
              code: -32000,
              message: 'That identifier is taken.',
              data: {
                weftCode: 'Conflict',
                httpStatus: 409,
                reason: 'agent-file-exists',
              },
            },
          },
        });
      });
      await page.goto('/agents/new');
      const name = page.getByRole('textbox', { name: editorCopy.nameLabel });
      await name.fill('Shared refusal');
      await page
        .getByRole('textbox', { name: editorCopy.instructionsLabel })
        .fill('Keep the refused draft visible.');
      const create = page.getByRole('button', { name: editorCopy.createAction });
      await create.click();
      await expect(name).toBeInvalid();
      await expect(name).toHaveAccessibleDescription(
        editorCopy.newAgent.nameTaken('Shared refusal'),
      );
      expect(attempts).toBe(1);
      await expect(create).toBeEnabled();
      await captureForDesignReview(page, {
        route: '/agents/new',
        state: 'shared FormActions, duplicate refusal',
        source: SOURCE,
      });
    });
  }

  for (const width of WIDTHS) {
    test(`keeps the shared FormActions visible while saving at ${width} pixels`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const id = `e2e-design-shared-actions-held-${String(width)}`;
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let attempts = 0;
      try {
        await createAgentFile(request, id, {
          name: 'Held shared actions',
          instructions: 'Answer the question.',
        });
        await standIn(page, 'bureau.agents.definitions.update', async (route) => {
          attempts += 1;
          await held;
          await changedAnswer(route, () => undefined);
        });
        await page.goto(`/agents/${id}/edit`);
        const description = page.getByRole('textbox', { name: editorCopy.descriptionLabel });
        await description.fill('Keep this saving state visible.');
        const save = page.getByRole('button', { name: editorCopy.saveAction });
        await save.click();
        await expect(save).toHaveAttribute('data-cinder-loading', '');
        expect(attempts).toBe(1);
        await captureForDesignReview(page, {
          route: '/agents/:agent/edit',
          state: 'shared FormActions, held save',
          source: SOURCE,
        });
        release();
        await expect(save).not.toHaveAttribute('data-cinder-loading', '');
      } finally {
        release();
        await removeAgent(request, id);
      }
    });
  }

  for (const width of [320, 375]) {
    test.describe(`at ${width} pixels with a coarse pointer`, () => {
      test.use({ viewport: { width, height: 640 }, hasTouch: true, isMobile: true });

      test('keeps the shared FormActions actions reachable above phone navigation', async ({
        page,
      }) => {
        await page.goto('/agents/new');
        const actions = page.getByRole('group', { name: 'Form actions' });
        const instructions = page.getByRole('textbox', { name: editorCopy.instructionsLabel });
        await instructions.scrollIntoViewIfNeeded();
        await expect(instructions).toBeInViewport();
        expect(
          await instructions.evaluate((field) => {
            const box = field.getBoundingClientRect();
            return field.contains(
              document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2),
            );
          }),
        ).toBe(true);
        await expect(actions.getByTestId('agent-save-status')).toHaveText(
          editorCopy.try.notSavedYet,
        );
        await expect(actions).toHaveCSS('position', 'sticky');
        for (const name of [editorCopy.cancelAction, editorCopy.createAction]) {
          const action = actions.getByRole('button', { name });
          await action.scrollIntoViewIfNeeded();
          await expect(action).toBeInViewport();
          const reachability = await action.evaluate((button) => {
            const box = button.getBoundingClientRect();
            const centerX = box.left + box.width / 2;
            const centerY = box.top + box.height / 2;
            const halfTouchTarget = 21.5;
            const touchPoints = [
              [centerX - halfTouchTarget, centerY],
              [centerX + halfTouchTarget, centerY],
              [centerX, centerY - halfTouchTarget],
              [centerX, centerY + halfTouchTarget],
            ] as const;
            return {
              coarse: matchMedia('(pointer: coarse)').matches,
              receivesPointer: touchPoints.every(([x, y]) =>
                button.contains(document.elementFromPoint(x, y)),
              ),
            };
          });
          expect(reachability.coarse).toBe(true);
          expect(reachability.receivesPointer).toBe(true);
        }
        await captureForDesignReview(page, {
          route: '/agents/new',
          state: `shared FormActions, ${width} coarse pointer`,
          source: SOURCE,
        });
        await page.setViewportSize({ width, height: 480 });
        await expect(actions).toHaveCSS('position', 'static');
        await captureForDesignReview(page, {
          route: '/agents/new',
          state: `shared FormActions, ${width} short viewport`,
          source: SOURCE,
        });
      });
    });
  }

  test('keeps the same shared FormActions after Try it opens and closes at 768 pixels', async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 768, height: 900 });
    const id = 'e2e-design-shared-actions-try';
    try {
      await createAgentFile(request, id, {
        name: 'Shared actions trial',
        instructions: 'Answer the question.',
      });
      await page.goto(`/agents/${id}/edit`);
      const actions = page.getByRole('group', { name: 'Form actions' });
      await expect(actions).toBeVisible();
      const description = page.getByRole('textbox', { name: editorCopy.descriptionLabel });
      await description.fill('Keep this form state while trying the agent.');
      await page.getByRole('button', { name: editorCopy.try.action }).click();
      const trial = page.getByRole('dialog', { name: editorCopy.try.title });
      await expect(trial).toBeVisible();
      await trial.getByRole('button', { name: editorCopy.try.closeSheet }).click();
      await expect(trial).toBeHidden();
      await expect(actions).toBeVisible();
      await expect(description).toHaveValue('Keep this form state while trying the agent.');
      await captureForDesignReview(page, {
        route: '/agents/:agent/edit',
        state: 'shared FormActions, Try it closed at 768',
        source: SOURCE,
      });
    } finally {
      await removeAgent(request, id);
    }
  });
});
