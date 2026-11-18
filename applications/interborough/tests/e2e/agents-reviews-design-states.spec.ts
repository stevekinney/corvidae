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

import { AGENT_PAGE_COPY } from '../../src/app/copy/agents.ts';
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
import { expect, test } from './fixtures.ts';
import { SINGLE_MODEL_AGENT_NAME } from './model-agents.ts';
import { E2E_SKILLS } from './skills-support.ts';
import { bureauCall, waitingReviewOf } from './task-support.ts';
import { TEXT_ECHO_AGENT_NAME } from './text-echo-agent.ts';

const WIDTHS = [375, 1280] as const;
const SOURCE = 'agents-reviews-design-states.spec.ts';
const settingsCopy = AGENT_PAGE_COPY.settings;

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

/** Answers every Bureau call named `method` with `answer(route)`, and sends the rest on. */
async function standIn(
  page: Page,
  method: string,
  answer: (route: Route, call: { id?: unknown; params?: Record<string, unknown> }) => Promise<void>,
): Promise<void> {
  await page.route('**/bureau/jsonrpc', async (route) => {
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
        await expect(page.getByText(/is disabled, so this chat is read-only/)).toBeVisible();
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

    test(`/agents/:agent shows the agent’s own skills in its header and on Access, and its reference documents, at ${width} pixels`, async ({
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
    }) => {
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
      await captureForDesignReview(page, {
        route: '/reviews',
        state: 'a workflow review',
        source: SOURCE,
      });

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
