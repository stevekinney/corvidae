/** Real-host proofs for Chat's ended-answer regeneration and expired approval retry. */
import type { Locator, Page } from '@playwright/test';

import { newThreadId, runToEnd } from './chat-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_BARRIER_URL, E2E_BASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';
import {
  EXPIRING_APPROVAL_AGENT,
  EXPIRING_APPROVAL_TOOL,
  REGENERATION_PROOF_AGENT,
  REGENERATION_PROOF_TOOL,
} from './regeneration-proof-agent.ts';
import { threadMessages } from './task-support.ts';

const VIEWPORTS = [
  { width: 1280, height: 900, label: 'desktop' },
  { width: 390, height: 820, label: 'coarse phone' },
] as const;

function recordRequests(page: Page) {
  const regeneration: Array<Record<string, unknown>> = [];
  const starts: Array<Record<string, unknown>> = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    if (request.url().endsWith('/bureau/jsonrpc')) {
      const body = request.postDataJSON() as { method?: string; params?: Record<string, unknown> };
      if (body.method === 'bureau.contexts.regenerate') regeneration.push(body.params ?? {});
    }
    if (request.url().includes('/bureau/ag-ui/agents/')) starts.push(request.postDataJSON());
  });
  return { regeneration, starts };
}

function approvalCard(page: Page, rawCallId: string) {
  return page.locator(
    `.cinder-approval-card[data-cinder-tool-approval-call-id$=":call:${rawCallId}"]`,
  );
}

function toolRow(page: Page, reviewId: string) {
  return page.locator(`[data-cinder-tool-call-row^="${reviewId}:"]`);
}

function completedToolRow(page: Page, callId: string) {
  return page.locator(`[data-cinder-tool-call-row="${callId}"]`);
}

async function assertCanonicalCallPair(page: Page, rawCallId: string, reviewId: string) {
  const card = approvalCard(page, rawCallId);
  try {
    await expect(card).toHaveCount(1);
  } catch (error) {
    const cardCount = await card.count();
    const renderedCards = await page.locator('.cinder-approval-card').evaluateAll((cards) =>
      cards.map((candidate) => ({
        approvalCallId: candidate.getAttribute('data-cinder-tool-approval-call-id'),
        state: candidate.getAttribute('data-cinder-state'),
        text: candidate.textContent?.replace(/\s+/g, ' ').trim(),
      })),
    );
    throw new Error(
      `expected one canonical approval card for raw call ${rawCallId}, found ${cardCount}; ` +
        `rendered approval identities: ${JSON.stringify(renderedCards)}`,
      { cause: error },
    );
  }
  const callId = await card.getAttribute('data-cinder-tool-approval-call-id');
  if (callId === null) throw new Error(`approval card omitted canonical call ID for ${rawCallId}`);
  const row = toolRow(page, reviewId);
  try {
    await expect(row).toHaveCount(1);
  } catch (error) {
    const rowCount = await row.count();
    const renderedRows = await page.locator('[data-cinder-tool-call-row]').evaluateAll((rows) =>
      rows.map((candidate) => ({
        rowId: candidate.getAttribute('data-cinder-tool-call-row'),
        status: candidate.parentElement?.getAttribute('data-cinder-status'),
        text: candidate.textContent?.replace(/\s+/g, ' ').trim(),
      })),
    );
    throw new Error(
      `expected one canonical tool row for review ${reviewId}, found ${rowCount}; ` +
        `rendered rail identities: ${JSON.stringify(renderedRows)}`,
      { cause: error },
    );
  }
  const railKey = await row.getAttribute('data-cinder-tool-call-row');
  if (railKey === null) throw new Error(`approval rail omitted review key for ${reviewId}`);
  expect(railKey).toMatch(new RegExp(`^${reviewId}:`));
  return { card, callId, railKey, row };
}

async function assertToolIdentifierTooltip(
  page: Page,
  row: Locator,
  identifier: string,
): Promise<void> {
  const describedBy = await row.getAttribute('aria-describedby');
  expect(describedBy).toBeTruthy();
  if (describedBy === null) return;
  const tooltip = page.locator(`[id="${describedBy}"]`);
  await row.focus();
  try {
    await expect(tooltip).toBeVisible();
  } catch (error) {
    const diagnostics = await page.evaluate(
      ({ rowId, tooltipId }) => {
        const row = document.querySelector<HTMLElement>(`[data-cinder-tool-call-row="${rowId}"]`);
        const panel = document.getElementById(tooltipId);
        const rect = (element: HTMLElement | null) => {
          const box = element?.getBoundingClientRect();
          return box === undefined
            ? undefined
            : { x: box.x, y: box.y, width: box.width, height: box.height };
        };
        return {
          activeElement: document.activeElement?.outerHTML.slice(0, 300),
          rowConnected: row?.isConnected,
          rowRect: rect(row ?? null),
          rowDescribedBy: row?.getAttribute('aria-describedby'),
          tooltipConnected: panel?.isConnected,
          tooltipHidden: panel?.getAttribute('aria-hidden'),
          tooltipVisible: panel?.getAttribute('data-cinder-visible'),
          tooltipPositionReady: panel?.getAttribute('data-cinder-position-ready'),
          tooltipRect: rect(panel),
        };
      },
      { rowId: await row.getAttribute('data-cinder-tool-call-row'), tooltipId: describedBy },
    );
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(diagnostics)}`,
      { cause: error },
    );
  }
  await expect(tooltip).toContainText(identifier);
}

/** Traverses the live approval card with real Tab events until a decision control is focused. */
async function reachApprovalDecision(page: Page, card: Locator): Promise<void> {
  const focusableSelector =
    'button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])';
  const focusableCount = await card.locator(focusableSelector).count();
  if (focusableCount === 0) throw new Error('approval card has no keyboard-focusable controls');
  const seenFocusIndexes = new Set<number>();
  let reachedDecision = false;
  for (let tab = 0; tab < focusableCount + 1; tab += 1) {
    await page.keyboard.press('Tab');
    const focused = await card.evaluate((cardElement, selector) => {
      const focusables = Array.from(cardElement.querySelectorAll<HTMLElement>(selector));
      const active = cardElement.ownerDocument.activeElement;
      const index = active === null ? -1 : focusables.indexOf(active as HTMLElement);
      return {
        index,
        inside: active !== null && cardElement.contains(active),
        approve: active?.tagName === 'BUTTON' && active.textContent?.trim() === 'Approve',
      };
    }, focusableSelector);
    expect(focused.inside).toBe(true);
    if (focused.index < 0) throw new Error('keyboard focus escaped the approval card');
    if (seenFocusIndexes.has(focused.index)) {
      throw new Error(`keyboard focus cycled before reaching a decision at index ${focused.index}`);
    }
    seenFocusIndexes.add(focused.index);
    if (focused.approve) {
      reachedDecision = true;
      break;
    }
  }
  expect(reachedDecision).toBe(true);
}

/** Re-establishes the real Review-to-decision path after a capture helper viewport change. */
async function prepareApprovalCapture(page: Page, card: Locator): Promise<void> {
  const reviewApproval = page.getByRole('button', { name: 'Review approval', exact: true }).last();
  if ((await reviewApproval.count()) > 0 && (await reviewApproval.isVisible())) {
    await reviewApproval.click();
    await expect(card).toBeFocused();
    await expect(card).toBeVisible();
    await expect(card).toBeInViewport();
    await reachApprovalDecision(page, card);
  } else {
    await expect(card).toBeVisible();
    await expect(card).toBeInViewport();
  }
  const approve = card.getByRole('button', { name: 'Approve', exact: true });
  await expect(approve).toBeInViewport({
    ratio: 1,
  });
}

async function assertNoOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

async function chatHeaderStatus(page: Page): Promise<string> {
  const text = await page.getByTestId('chat-header').innerText();
  return (
    ['Waiting on you', 'Running', 'Failed', 'Ended', 'Done'].find((word) => text.includes(word)) ??
    ''
  );
}

async function reviewsNavigationCount(page: Page): Promise<number> {
  const link = page
    .getByRole('navigation', { name: 'Views' })
    .getByRole('link', { name: /^Reviews(?:, \d+ need you)?$/ });
  await expect(link).toHaveCount(1);
  const label = (await link.getAttribute('aria-label')) ?? (await link.innerText());
  const count = label.match(/^Reviews, (\d+) need you$/)?.[1];
  return count === undefined ? 0 : Number(count);
}

async function chatListWaitingCount(page: Page): Promise<number> {
  const segment = page
    .getByRole('radiogroup', { name: 'Status' })
    .getByRole('radio', { name: /Waiting on you/ });
  await expect(segment).toHaveCount(1);
  const segmentText = await segment.innerText();
  const count = segmentText.match(/Waiting on you\s*,?\s*(\d+)/)?.[1];
  if (count === undefined) throw new Error('Chats list omitted the Waiting on you count');
  return Number(count);
}

async function assertChatListStatus(
  page: Page,
  threadId: string,
  waiting: boolean,
): Promise<number | undefined> {
  await page.goto('/chats');
  const row = page.locator(`[data-chat="${threadId}"]`);
  await expect(row).toHaveCount(1);
  if (waiting) await expect(row).toContainText('Waiting on you');
  else await expect(row).not.toContainText('Waiting on you');
  const count = viewportIsDesktop(page) ? await chatListWaitingCount(page) : undefined;
  await page.goto(`/chats/${threadId}`);
  return count;
}

function viewportIsDesktop(page: Page): boolean {
  return page.viewportSize()?.width !== undefined && (page.viewportSize()?.width ?? 0) >= 500;
}

async function assertInteractionProfile(page: Page, isCoarsePhone: boolean): Promise<void> {
  const profile = await page.evaluate(() => ({
    coarsePointer: matchMedia('(pointer: coarse)').matches,
    touchPoints: navigator.maxTouchPoints,
  }));
  expect(profile.coarsePointer).toBe(isCoarsePhone);
  expect(profile.touchPoints > 0).toBe(isCoarsePhone);
}

for (const viewport of VIEWPORTS) {
  test.describe(`real ${viewport.label} interaction profile`, () => {
    test.use({
      hasTouch: viewport.width < 500,
      isMobile: viewport.width < 500,
      viewport: { width: viewport.width, height: viewport.height },
    });

    test(`regenerates the latest ended answer through the real Bureau RPC at ${viewport.label}`, async ({
      page,
      request,
      checkA11y,
    }) => {
      await assertInteractionProfile(page, viewport.width < 500);
      const threadId = newThreadId('regeneration-proof');
      await runToEnd(request, REGENERATION_PROOF_AGENT, threadId, 'Verify the proof record');
      const before = await threadMessages(request, threadId);
      expect(JSON.stringify(before)).toContain(REGENERATION_PROOF_TOOL);
      expect(JSON.stringify(before)).toContain('real-host-tool-step');
      const beforeNonTargetMessages = before.filter(
        (message) =>
          !JSON.stringify(message).includes(
            'The verified answer is retained after the real tool step.',
          ),
      );

      await page.goto(`/chats/${threadId}`);
      const conversationRegion = page.getByRole('region', {
        name: 'Chat conversation',
        exact: true,
      });
      await expect(conversationRegion).toContainText(
        'The verified answer is retained after the real tool step.',
      );
      const requests = recordRequests(page);
      const answer = conversationRegion.getByText(
        'The verified answer is retained after the real tool step.',
        { exact: true },
      );
      await answer.hover();
      const regenerationResponsePromise = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' && response.url().endsWith('/bureau/jsonrpc'),
      );
      await page.getByRole('button', { name: 'Regenerate', exact: true }).click();
      const regenerationResponse = await regenerationResponsePromise;
      expect(regenerationResponse.ok()).toBe(true);
      const regenerationBody = (await regenerationResponse.json()) as {
        result?: unknown;
        error?: unknown;
      };
      expect(regenerationBody.error).toBeUndefined();
      expect(regenerationBody.result).toEqual(expect.anything());

      await expect(conversationRegion).toContainText(
        'The regenerated answer is distinct after the real tool step.',
      );
      await expect.poll(() => requests.regeneration.length).toBe(1);
      expect(requests.regeneration[0]).toMatchObject({
        contextId: threadId,
        commandId: expect.any(String),
        messageId: expect.any(String),
      });
      expect(requests.starts).toHaveLength(0);
      await expect(conversationRegion.locator('[data-cinder-tool-call-row]')).toHaveCount(1);
      await expect(page.locator('.cinder-approval-card')).toHaveCount(0);
      await page.reload();
      await expect(conversationRegion).toContainText(
        'The regenerated answer is distinct after the real tool step.',
      );
      const after = await threadMessages(request, threadId);
      const serializedAfter = JSON.stringify(after);
      expect(serializedAfter).toContain(REGENERATION_PROOF_TOOL);
      expect(serializedAfter).toContain('real-host-tool-step');
      expect(serializedAfter).toContain(
        'The regenerated answer is distinct after the real tool step.',
      );
      expect(serializedAfter).not.toContain(
        'The verified answer is retained after the real tool step.',
      );
      expect(
        after.filter((message) => !JSON.stringify(message).includes('regenerated answer')),
      ).toEqual(beforeNonTargetMessages);
      await checkA11y(`regenerated ended answer at ${viewport.label}`);
      await assertNoOverflow(page);
      await captureForDesignReview(page, {
        route: '/chats/:chat',
        state: `real Bureau regeneration at ${viewport.label}`,
        source: 'chat-regeneration-expiry.spec.ts',
      });
    });
  });
}

for (const viewport of VIEWPORTS) {
  test.describe(`expired approval ${viewport.label} interaction profile`, () => {
    test.use({
      hasTouch: viewport.width < 500,
      isMobile: viewport.width < 500,
      viewport: { width: viewport.width, height: viewport.height },
    });

    test(`shows durable expired approval history and retries through a fresh real turn at ${viewport.label}`, async ({
      page,
      request,
      checkA11y,
    }) => {
      await assertInteractionProfile(page, viewport.width < 500);
      await page.goto(`/chats/new?agent=${EXPIRING_APPROVAL_AGENT}`);
      await expect(page.getByRole('textbox')).toBeVisible();
      await page.getByRole('textbox').fill('Approve the proof mutation');
      await page.getByRole('textbox').press('Enter');
      await expect(page).toHaveURL(/\/chats\/(?!new(?:$|\?))/);
      const threadId = decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1) ?? '');
      let review:
        { id?: string; status?: string; requestedAt?: number; sessionId?: string } | undefined;
      await expect
        .poll(async () => {
          const response = await request.post(`${E2E_BASE_URL}/bureau/jsonrpc`, {
            data: {
              jsonrpc: '2.0',
              id: 'expiry-review-before',
              method: 'bureau.reviews.list',
              params: {},
            },
          });
          const body = (await response.json()) as {
            result?: {
              reviews?: Array<{
                id?: string;
                status?: string;
                requestedAt?: number;
                sessionId?: string;
              }>;
            };
          };
          review = body.result?.reviews?.find(
            (candidate) => candidate.status === 'pending' && candidate.sessionId === threadId,
          );
          return review;
        })
        .toMatchObject({ status: 'pending', id: expect.any(String) });
      expect(review?.requestedAt).toEqual(expect.any(Number));
      const reviewId = review?.id;
      if (reviewId === undefined)
        throw new Error('the real pending approval did not name its review');

      await expect(page.locator('.cinder-approval-card')).toHaveCount(1);
      const initialCall = await assertCanonicalCallPair(page, 'expiring-approval-1', reviewId);
      const approval = initialCall.card;
      await expect(approval).toBeVisible();
      await expect(approval).toHaveAttribute('data-cinder-state', 'pending');
      const initialReviewsCount =
        viewport.width >= 500 ? await reviewsNavigationCount(page) : undefined;
      if (initialReviewsCount !== undefined) expect(initialReviewsCount).toBeGreaterThan(0);
      const initialChatWaitingCount =
        viewport.width >= 500 ? await chatListWaitingCount(page) : undefined;
      // Leave the page open through the configured 20-second binding expiry, then reread the durable
      // history. The host sweep, not a mocked response or page route, transitions this receipt.
      await expect
        .poll(async () => {
          const response = await request.post(`${E2E_BASE_URL}/bureau/jsonrpc`, {
            data: {
              jsonrpc: '2.0',
              id: 'expiry-proof',
              method: 'bureau.reviews.list',
              params: {},
            },
          });
          const body = (await response.json()) as {
            result?: { reviews?: Array<{ id?: string; runId?: string; sessionId?: string }> };
          };
          return (
            body.result?.reviews?.filter(
              (candidate) =>
                candidate.sessionId === threadId ||
                candidate.id === reviewId ||
                candidate.runId === threadId,
            ).length ?? 0
          );
        })
        .toBe(0);
      const maintainResponse = await request.post(`${E2E_BARRIER_URL}/maintain`);
      expect(maintainResponse.ok()).toBe(true);
      await expect
        .poll(async () => {
          const response = await request.get(`${E2E_BARRIER_URL}/maintain/status`);
          return (await response.json()) as { done: boolean; error?: string };
        })
        .toMatchObject({ done: true });

      const readReview = async (id: string = reviewId) => {
        const response = await request.post(`${E2E_BASE_URL}/bureau/jsonrpc`, {
          data: {
            jsonrpc: '2.0',
            id: 'expiry-review-after',
            method: 'bureau.reviews.get',
            params: { id },
          },
        });
        return (await response.json()) as {
          result?: { status?: string; resolution?: { decidedAt?: number } };
          error?: { code?: string; message?: string };
        };
      };
      await expect
        .poll(async () => {
          const reviewResponse = await readReview();
          return reviewResponse.result;
        })
        .toMatchObject({ status: 'expired' });
      const afterReviewBody = await readReview();
      expect(afterReviewBody.error).toBeUndefined();
      expect(afterReviewBody.result).toMatchObject({ status: 'expired' });
      expect(afterReviewBody.result?.resolution?.decidedAt).toEqual(expect.any(Number));
      const expiredCall = await assertCanonicalCallPair(page, 'expiring-approval-1', reviewId);
      expect(expiredCall.callId).toBe(initialCall.callId);
      expect(expiredCall.railKey).toBe(initialCall.railKey);
      const expiredApproval = expiredCall.card;
      await expect(expiredApproval).toHaveAttribute('data-cinder-state', 'expired');
      await expect(expiredApproval.locator('.cinder-approval-card__expired-row')).toBeVisible();
      await expect(expiredApproval).toContainText('Expired');
      await expect(expiredApproval).toContainText('Ask again');
      const expiredToolRow = expiredCall.row;
      // ToolCallRail intentionally shows the friendly tool title in the row. The canonical row key
      // above proves which call rendered; the machine identifier is the documented focus tooltip.
      await assertToolIdentifierTooltip(page, expiredToolRow, EXPIRING_APPROVAL_TOOL);
      await expect(expiredToolRow).toContainText('Expired');
      await expect(expiredToolRow).not.toContainText('Waiting on you');
      await expect(expiredToolRow).not.toContainText('Needs you');
      await expect.poll(() => chatHeaderStatus(page)).not.toBe('Waiting on you');
      const expiredReviewsCount =
        viewport.width >= 500 ? await reviewsNavigationCount(page) : undefined;
      if (initialReviewsCount !== undefined && expiredReviewsCount !== undefined) {
        expect(expiredReviewsCount).toBeLessThan(initialReviewsCount);
      }
      await expiredToolRow.click();
      const expiredToolPanel =
        viewport.width < 500
          ? page.getByRole('dialog', { name: /Expiring approval mutation/ })
          : page.locator('.cinder-tool-call-panel');
      await expect(expiredToolPanel).toBeVisible();
      await expect(expiredToolPanel).toContainText(EXPIRING_APPROVAL_TOOL);
      await expect(expiredToolPanel).toHaveAttribute('data-cinder-status', 'expired');
      await expect(expiredToolPanel).toContainText('Approval expired');
      await expect(expiredToolPanel).not.toContainText('Waiting on you');
      await expect(expiredToolPanel).not.toContainText('Needs you');
      if (viewport.width < 500) {
        await expiredToolPanel.getByRole('button', { name: 'Close', exact: true }).click();
      } else {
        await expiredToolRow.click();
      }
      await expect(expiredToolPanel).toHaveCount(0);
      await expect(page.locator('[data-chat-composer-status="waiting"]')).toHaveCount(0);
      const expiredChatWaitingCount = await assertChatListStatus(page, threadId, false);
      if (initialChatWaitingCount !== undefined && expiredChatWaitingCount !== undefined) {
        expect(expiredChatWaitingCount).toBeLessThan(initialChatWaitingCount);
      }
      // assertChatListStatus navigates away and back; re-prove the expired card after that remount
      // so the following screenshot cannot capture the pre-hydration empty transcript.
      await expect(page.locator('.cinder-approval-card[data-cinder-state="expired"]')).toHaveCount(
        1,
      );
      await expect(page.locator('[data-cinder-tool-call-row]')).toHaveCount(1);
      await captureForDesignReview(page, {
        route: '/chats/:chat',
        state: `durable expired approval before Ask again at ${viewport.label}`,
        source: 'chat-regeneration-expiry.spec.ts',
        ready: async (capturePage) => {
          await expect(
            capturePage.locator('.cinder-approval-card[data-cinder-state="expired"]'),
          ).toHaveCount(1);
          await expect(capturePage.locator('[data-cinder-tool-call-row]')).toHaveCount(1);
        },
      });

      const requests = recordRequests(page);
      await expiredApproval.getByRole('button', { name: 'Ask again', exact: true }).click();
      await expect.poll(() => requests.starts.length).toBe(1);
      expect(requests.starts[0]?.['resume']).toBeUndefined();
      expect(requests.starts[0]?.['messages']).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'user', content: 'Approve the proof mutation' }),
        ]),
      );
      let retryReviewId: string | undefined;
      await expect
        .poll(async () => {
          const response = await request.post(`${E2E_BASE_URL}/bureau/jsonrpc`, {
            data: {
              jsonrpc: '2.0',
              id: 'expiry-review-retry',
              method: 'bureau.reviews.list',
              params: {},
            },
          });
          const body = (await response.json()) as {
            result?: { reviews?: Array<{ id?: string; status?: string; sessionId?: string }> };
          };
          const candidate = body.result?.reviews?.find(
            (entry) =>
              entry.status === 'pending' &&
              entry.sessionId === threadId &&
              entry.id !== undefined &&
              entry.id !== reviewId,
          );
          retryReviewId = candidate?.id;
          return candidate;
        })
        .toMatchObject({ status: 'pending', id: expect.any(String) });
      if (retryReviewId === undefined)
        throw new Error('the retry approval did not name its review');
      expect(retryReviewId).not.toBe(reviewId);

      // The retry is a real server run. Reread its durable transcript so the new approval is pending
      // while the old receipt remains expired history.
      await page.reload();
      const reloadedExpiredCall = await assertCanonicalCallPair(
        page,
        'expiring-approval-1',
        reviewId,
      );
      expect(reloadedExpiredCall.callId).toBe(expiredCall.callId);
      expect(reloadedExpiredCall.railKey).toBe(expiredCall.railKey);
      const reloadedExpiredApproval = reloadedExpiredCall.card;
      await expect(reloadedExpiredApproval).toHaveAttribute('data-cinder-state', 'expired');
      await expect(
        reloadedExpiredApproval.locator('.cinder-approval-card__expired-row'),
      ).toBeVisible();
      const reloadedPendingCall = await assertCanonicalCallPair(
        page,
        'expiring-approval-2',
        retryReviewId,
      );
      expect(reloadedPendingCall.callId).not.toBe(reloadedExpiredCall.callId);
      expect(reloadedPendingCall.railKey).not.toBe(reloadedExpiredCall.railKey);
      const reloadedPendingApproval = reloadedPendingCall.card;
      await expect(reloadedPendingApproval).toHaveAttribute('data-cinder-state', 'pending');
      await expect(reloadedPendingApproval).toContainText('durable-expiry-proof');
      await expect(reloadedPendingApproval).toContainText('Expiring approval mutation');
      await expect(
        reloadedPendingApproval.getByRole('button', { name: 'Approve', exact: true }),
      ).toBeEnabled();
      await expect.poll(() => chatHeaderStatus(page)).toBe('Waiting on you');
      if (expiredReviewsCount !== undefined) {
        await expect.poll(() => reviewsNavigationCount(page)).toBe(expiredReviewsCount + 1);
      }
      const freshChatWaitingCount = await assertChatListStatus(page, threadId, true);
      if (expiredChatWaitingCount !== undefined && freshChatWaitingCount !== undefined) {
        expect(freshChatWaitingCount).toBe(expiredChatWaitingCount + 1);
      }
      const reloadedExpiredToolRow = reloadedExpiredCall.row;
      await expect(reloadedExpiredToolRow).not.toContainText('Waiting on you');
      await expect(reloadedExpiredToolRow).not.toContainText('Needs you');
      const reloadedPendingToolRow = reloadedPendingCall.row;
      await expect(reloadedPendingToolRow).toContainText('Waiting on you');
      const messages = await threadMessages(request, threadId);
      const serialized = JSON.stringify(messages);
      expect(serialized).toContain(EXPIRING_APPROVAL_TOOL);
      expect(serialized).toContain('expiring-approval-1');
      expect(serialized).toContain('expiring-approval-2');
      await checkA11y('expired approval with fresh Ask again approval');
      await assertNoOverflow(page);
      // The list-status probe above remounts the route; assert the fresh card again immediately
      // before capture, including its identity and pending state.
      await expect(reloadedPendingApproval).toHaveCount(1);
      await expect(reloadedPendingApproval).toHaveAttribute('data-cinder-state', 'pending');
      await expect(reloadedPendingApproval).toContainText('Expiring approval mutation');
      await captureForDesignReview(page, {
        route: '/chats/:chat',
        state: `fresh pending approval after Ask again at ${viewport.label}`,
        source: 'chat-regeneration-expiry.spec.ts',
        ready: async (capturePage) => {
          const captureApproval = approvalCard(capturePage, 'expiring-approval-2');
          await expect(captureApproval).toHaveCount(1);
          await expect(captureApproval).toHaveAttribute('data-cinder-state', 'pending');
          await expect(captureApproval).toContainText('Expiring approval mutation');
          await expect(
            capturePage.locator(`[data-cinder-tool-call-row^="${retryReviewId}:"]`),
          ).toHaveCount(1);
        },
      });

      const approveFreshCall = reloadedPendingApproval.getByRole('button', {
        name: 'Approve',
        exact: true,
      });
      await expect(approveFreshCall).toBeEnabled();
      if (viewport.width < 500) {
        // Use the visible host action, not a test-only scroll or focus operation. The Chat handler
        // must bring the approval card into view and focus the non-answering card; then normal
        // keyboard traversal must reach a real decision control inside it.
        const reviewApproval = page
          .getByRole('button', { name: 'Review approval', exact: true })
          .last();
        await expect(reviewApproval).toBeVisible();
        await reviewApproval.click();
        await expect(reloadedPendingApproval).toBeFocused();
        await expect(reloadedPendingApproval).toBeInViewport();
        await expect(approveFreshCall).toBeVisible();
        await reachApprovalDecision(page, reloadedPendingApproval);
        await expect(approveFreshCall).toBeInViewport({ ratio: 1 });
        await captureForDesignReview(page, {
          route: '/chats/:chat',
          state: 'post-review approval focus at coarse phone',
          source: 'chat-regeneration-expiry.spec.ts',
          ready: async (capturePage) => {
            const captureApproval = approvalCard(capturePage, 'expiring-approval-2');
            const captureApprove = captureApproval.getByRole('button', {
              name: 'Approve',
              exact: true,
            });
            await expect(captureApproval).toHaveAttribute('data-cinder-state', 'pending');
            await expect(captureApprove).toBeVisible();
            await prepareApprovalCapture(capturePage, captureApproval);
          },
        });
      }
      await (viewport.width < 500 ? approveFreshCall.tap() : approveFreshCall.click());
      await expect.poll(() => requests.starts.length).toBe(2);
      expect(requests.starts[1]?.['resume']).toMatchObject([
        {
          interruptId: retryReviewId,
          status: 'resolved',
          payload: { decision: 'approve', decisionSurface: 'chat' },
        },
      ]);
      await expect
        .poll(async () => {
          const response = await readReview(retryReviewId);
          return response.result;
        })
        .toMatchObject({ status: 'approved', resolution: { decision: 'approve' } });
      await expect
        .poll(async () => JSON.stringify(await threadMessages(request, threadId)))
        .toContain('The approved proof mutation completed on the real host.');
      const completedMessages = await threadMessages(request, threadId);
      const completedProofMessages = completedMessages.filter((message) => {
        if (typeof message !== 'object' || message === null) return false;
        const candidate = message as { content?: unknown; role?: unknown };
        return (
          candidate.role === 'assistant' &&
          candidate.content === 'The approved proof mutation completed on the real host.'
        );
      });
      expect(completedProofMessages).toHaveLength(1);
      const completedSerialized = JSON.stringify(completedMessages);
      expect(completedSerialized).toContain('expiring-approval-2');
      expect(completedSerialized).toContain('"outcome":"success"');

      await page.reload();
      const retainedExpiredCall = await assertCanonicalCallPair(
        page,
        'expiring-approval-1',
        reviewId,
      );
      expect(retainedExpiredCall.callId).toBe(reloadedExpiredCall.callId);
      expect(retainedExpiredCall.railKey).toBe(reloadedExpiredCall.railKey);
      await expect(retainedExpiredCall.card).toHaveAttribute('data-cinder-state', 'expired');
      await expect(retainedExpiredCall.row).not.toContainText('Waiting on you');
      await expect(retainedExpiredCall.row).not.toContainText('Needs you');
      expect(reloadedPendingCall.callId).toContain(':expiring-approval-2:');
      expect(reloadedPendingCall.railKey).toMatch(new RegExp(`^${retryReviewId}:`));
      const settledNewRow = completedToolRow(page, 'expiring-approval-2');
      await expect(settledNewRow).toHaveCount(1);
      const settledNewItem = settledNewRow.locator(
        'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " cinder-tool-call-rail__item ")]',
      );
      await expect(settledNewItem).toHaveCount(1);
      await expect(settledNewItem).toHaveAttribute('data-cinder-status', 'approved');
      await expect(settledNewRow).toContainText('Approved');
      await expect(settledNewRow).not.toContainText('Waiting on you');
      await expect(settledNewRow).not.toContainText('Needs you');
    });
  });
}
