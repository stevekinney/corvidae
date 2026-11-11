/**
 * COR-2280 — an approval whose deadline passed stops holding the next turn back, read on the host's
 * clock, while its row stays in the transcript; and a deadline the host learned elsewhere is imported
 * through `reconcileApprovalExpiry`, which fences the action it was asked about and decides nothing.
 */
import { describe, expect, test } from 'bun:test';
import {
  appendToolCall,
  appendToolResult,
  appendUserMessage,
  createConversationHistory,
} from '../components/chat/builders.ts';
import type {
  ConversationHistory,
  ToolAction,
  ToolResult,
} from '../components/chat/conversation-model.ts';
import { createChatSessionController } from './session-controller.ts';
import type { ChatStreamEvent } from './stream-event-codec.ts';

async function* events(values: ChatStreamEvent[]): AsyncGenerator<ChatStreamEvent> {
  yield* values;
}

type ApprovalAction = Extract<ToolAction, { type: 'approval' }>;

const HOST_NOW = Date.parse('2099-06-01T12:00:00.000Z');
const iso = (instant: number) => new Date(instant).toISOString();

function approvalAction(overrides: Partial<ApprovalAction> = {}): ApprovalAction {
  return {
    type: 'approval',
    message: 'Refund order 4471 for $42.00',
    risk: 'high',
    operation: { kind: 'other', argsPreview: { orderId: 4471 } },
    policyVersion: 'test-policy',
    idempotencyKey: 'test-approval',
    ...overrides,
  };
}

/** A retained approval from the first run and a fresh one from Ask again, each still waiting. */
function twoApprovals(oldAction: ApprovalAction, freshAction: ApprovalAction): ConversationHistory {
  let history = appendUserMessage(createConversationHistory({ id: 'expiry' }), 'Refund it');
  history = appendToolCall(history, { id: 'old', name: 'refund', arguments: {} });
  history = appendToolResult(history, {
    callId: 'old',
    outcome: 'action_required',
    content: null,
    action: oldAction,
  });
  history = appendUserMessage(history, 'Ask again');
  history = appendToolCall(history, { id: 'fresh', name: 'refund', arguments: {} });
  return appendToolResult(history, {
    callId: 'fresh',
    outcome: 'action_required',
    content: null,
    action: freshAction,
  });
}

function resultOf(history: ConversationHistory, callId: string): ToolResult | undefined {
  return Object.values(history.messages).find(
    (message) => message.role === 'tool-result' && message.toolResult?.callId === callId,
  )?.toolResult;
}

function rowIdOf(history: ConversationHistory, callId: string): string | undefined {
  return history.ids.find((id) => history.messages[id]?.toolResult?.callId === callId);
}

/** A controller over `initial` whose host clock reads `clock.now`, counting writes and turns. */
function harness(initial: ConversationHistory, clock: { now: number }) {
  let conversation = initial;
  let writes = 0;
  let turns = 0;
  const controller = createChatSessionController({
    getConversation: () => conversation,
    setConversation: (next) => {
      conversation = next;
      writes += 1;
    },
    now: () => iso(clock.now),
    transport: async () => {
      turns += 1;
      return events([{ type: 'text', text: 'Refunded.' }]);
    },
    hooks: {
      resolveToolApproval: async (id) => ({ callId: id, outcome: 'success', content: 'ok' }),
    },
  });
  return {
    controller,
    conversation: () => conversation,
    writes: () => writes,
    turns: () => turns,
  };
}

describe('an approval whose deadline passed (COR-2280)', () => {
  test('continues from the fresh approval once the old one’s authoritative expiry is imported', async () => {
    const oldAction = approvalAction({ idempotencyKey: 'old' });
    const freshAction = approvalAction({
      idempotencyKey: 'fresh',
      expiresAt: iso(HOST_NOW + 60_000),
    });
    const session = harness(twoApprovals(oldAction, freshAction), { now: HOST_NOW });
    const oldRow = rowIdOf(session.conversation(), 'old');

    expect(
      session.controller.reconcileApprovalExpiry({
        toolCallId: 'old',
        expiresAt: iso(HOST_NOW - 1_000),
        expectedAction: oldAction,
      }),
    ).toBe(true);
    const resolved = await session.controller.adapter.resolveToolApproval?.('fresh', {
      decision: 'approve',
    });

    expect(resolved).toBe('resolved');
    expect(session.turns()).toBe(1);
    // The old receipt stays, as the expired row it is, under its own id.
    const old = resultOf(session.conversation(), 'old');
    expect(rowIdOf(session.conversation(), 'old')).toBe(oldRow);
    expect(old?.outcome).toBe('action_required');
    expect(old?.action).toEqual({ ...oldAction, expiresAt: iso(HOST_NOW - 1_000) });
    expect(resultOf(session.conversation(), 'fresh')?.outcome).toBe('success');
  });

  test('still waits on an old approval whose expiry nobody imported', async () => {
    const session = harness(
      twoApprovals(approvalAction({ idempotencyKey: 'old' }), approvalAction()),
      { now: HOST_NOW },
    );

    await session.controller.adapter.resolveToolApproval?.('fresh', { decision: 'approve' });

    expect(session.turns()).toBe(0);
  });

  test('still waits on another approval that has not expired', async () => {
    const session = harness(
      twoApprovals(
        approvalAction({ idempotencyKey: 'old', expiresAt: iso(HOST_NOW + 1_000) }),
        approvalAction(),
      ),
      { now: HOST_NOW },
    );

    await session.controller.adapter.resolveToolApproval?.('fresh', { decision: 'approve' });

    expect(session.turns()).toBe(0);
  });

  test('stops waiting on a deadline that passes after it was imported, with no new snapshot', async () => {
    const oldAction = approvalAction({ idempotencyKey: 'old' });
    const clock = { now: HOST_NOW };
    const session = harness(twoApprovals(oldAction, approvalAction()), clock);

    expect(
      session.controller.reconcileApprovalExpiry({
        toolCallId: 'old',
        expiresAt: iso(HOST_NOW + 1_000),
        expectedAction: oldAction,
      }),
    ).toBe(true);
    clock.now = HOST_NOW + 1_000;
    await session.controller.adapter.resolveToolApproval?.('fresh', { decision: 'approve' });

    expect(session.turns()).toBe(1);
  });

  test('reads deadlines on the host’s clock, not the browser’s', async () => {
    // Long past by the host's clock, years ahead by the browser's.
    const expiredForHost = harness(
      twoApprovals(
        approvalAction({ idempotencyKey: 'old', expiresAt: '2098-01-01T00:00:00.000Z' }),
        approvalAction(),
      ),
      { now: HOST_NOW },
    );
    await expiredForHost.controller.adapter.resolveToolApproval?.('fresh', {
      decision: 'approve',
    });
    expect(expiredForHost.turns()).toBe(1);

    // Past by the browser's clock, still ahead by the host's.
    const pendingForHost = harness(
      twoApprovals(
        approvalAction({ idempotencyKey: 'old', expiresAt: '2001-01-01T00:00:00.000Z' }),
        approvalAction(),
      ),
      { now: Date.parse('2000-01-01T00:00:00.000Z') },
    );
    await pendingForHost.controller.adapter.resolveToolApproval?.('fresh', {
      decision: 'approve',
    });
    expect(pendingForHost.turns()).toBe(0);
  });

  test('lets a new turn start past an approval that expired', async () => {
    let history = appendUserMessage(createConversationHistory({ id: 'expired' }), 'Refund it');
    history = appendToolCall(history, { id: 'old', name: 'refund', arguments: {} });
    history = appendToolResult(history, {
      callId: 'old',
      outcome: 'action_required',
      content: null,
      action: approvalAction({ expiresAt: iso(HOST_NOW - 1) }),
    });
    const session = harness(history, { now: HOST_NOW });

    await session.controller.adapter.sendMessage(
      { role: 'user', content: 'Try something else' },
      [],
    );

    expect(session.turns()).toBe(1);
    expect(resultOf(session.conversation(), 'old')?.outcome).toBe('action_required');
  });
});

describe('reconcileApprovalExpiry (COR-2280)', () => {
  const oldAction = approvalAction({ idempotencyKey: 'old' });

  test('writes the deadline canonically, once, and an identical one again writes nothing', () => {
    const session = harness(twoApprovals(oldAction, approvalAction()), { now: HOST_NOW });
    const before = session.conversation();
    const observation = {
      toolCallId: 'old',
      expiresAt: '2099-06-01T11:00:00Z',
      expectedAction: oldAction,
    };

    expect(session.controller.reconcileApprovalExpiry(observation)).toBe(true);
    expect(session.writes()).toBe(1);
    const after = session.conversation();
    expect(resultOf(after, 'old')?.action).toEqual({
      ...oldAction,
      expiresAt: '2099-06-01T11:00:00.000Z',
    });
    // The row keeps its id and place; the other call is untouched.
    expect(after.ids).toEqual(before.ids);
    expect(resultOf(after, 'fresh')).toEqual(resultOf(before, 'fresh'));

    const canonical = { ...observation, expiresAt: '2099-06-01T11:00:00.000Z' };
    expect(
      session.controller.reconcileApprovalExpiry({
        ...canonical,
        expectedAction: resultOf(after, 'old')!.action as ApprovalAction,
      }),
    ).toBe(true);
    expect(session.writes()).toBe(1);
  });

  test.each([
    ['an expiry that is not an instant', { expiresAt: 'soon' }],
    ['a call with no result', { toolCallId: 'missing' }],
    ['an action that changed since it was read', { expectedAction: approvalAction() }],
  ])('refuses %s and changes nothing', (_label, overrides) => {
    const session = harness(twoApprovals(oldAction, approvalAction()), { now: HOST_NOW });
    const before = session.conversation();

    expect(
      session.controller.reconcileApprovalExpiry({
        toolCallId: 'old',
        expiresAt: iso(HOST_NOW - 1_000),
        expectedAction: oldAction,
        ...overrides,
      }),
    ).toBe(false);
    expect(session.writes()).toBe(0);
    expect(session.conversation()).toBe(before);
  });

  test('refuses a call that is already decided', async () => {
    const session = harness(twoApprovals(oldAction, approvalAction()), { now: HOST_NOW });
    await session.controller.adapter.resolveToolApproval?.('fresh', { decision: 'approve' });
    const writes = session.writes();

    expect(
      session.controller.reconcileApprovalExpiry({
        toolCallId: 'fresh',
        expiresAt: iso(HOST_NOW - 1_000),
        expectedAction: approvalAction(),
      }),
    ).toBe(false);
    expect(session.writes()).toBe(writes);
    expect(resultOf(session.conversation(), 'fresh')?.outcome).toBe('success');
  });

  test('refuses after the session is disposed', () => {
    const session = harness(twoApprovals(oldAction, approvalAction()), { now: HOST_NOW });
    session.controller.dispose();

    expect(
      session.controller.reconcileApprovalExpiry({
        toolCallId: 'old',
        expiresAt: iso(HOST_NOW - 1_000),
        expectedAction: oldAction,
      }),
    ).toBe(false);
  });
});
