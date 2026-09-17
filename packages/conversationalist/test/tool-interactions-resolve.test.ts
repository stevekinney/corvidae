import { describe, expect, it } from 'bun:test';

import {
  appendToolCall,
  appendUnsafeMessage,
  createConversationHistory as createConversation,
  deserializeConversationHistory,
  resolveToolResult,
} from '../src/conversation/index';
import { ConversationalistError } from '../src/errors';
import { conversationSchema } from '../src/schemas';
import type { ConversationHistory as Conversation, Message } from '../src/types';

const testEnvironment = {
  now: () => '2024-01-01T00:00:00.000Z',
  randomId: (() => {
    let counter = 0;
    return () => `call-${++counter}`;
  })(),
};

const getOrderedMessages = (conversation: Conversation): Message[] =>
  conversation.ids
    .map((id) => conversation.messages[id])
    .filter((message): message is Message => Boolean(message));

function requireConversationalistError(error: unknown): ConversationalistError {
  if (!(error instanceof ConversationalistError)) {
    throw new Error('Expected a ConversationalistError');
  }
  return error;
}

const buildPendingConversation = (): Conversation => {
  let conversation = createConversation({ id: 'resolve' }, testEnvironment);
  conversation = appendToolCall(
    conversation,
    { id: 'call-1', name: 'deploy', arguments: { target: 'production' } },
    undefined,
    testEnvironment,
  );
  return appendUnsafeMessage(
    conversation,
    {
      role: 'tool-result',
      content: '',
      toolResult: { callId: 'call-1', outcome: 'action_required', content: { pending: true } },
    },
    testEnvironment,
  );
};

describe('resolveToolResult', () => {
  it('replaces a pending tool-result with the resolved result, yielding exactly one tool-result for that callId', () => {
    const conv = buildPendingConversation();

    const resolved = resolveToolResult(
      conv,
      'call-1',
      { callId: 'call-1', outcome: 'success', content: { deployed: true } },
      undefined,
      testEnvironment,
    );

    const toolResultMessages = getOrderedMessages(resolved).filter(
      (message) => message.role === 'tool-result' && message.toolResult?.callId === 'call-1',
    );
    expect(toolResultMessages).toHaveLength(1);
    expect(toolResultMessages[0]?.toolResult?.outcome).toBe('success');
    expect(toolResultMessages[0]?.toolResult?.content).toEqual({ deployed: true });
  });

  it('preserves the original message id, createdAt, and position', () => {
    const conv = buildPendingConversation();
    const pending = getOrderedMessages(conv).find((message) => message.role === 'tool-result');
    expect(pending).toBeDefined();

    const resolved = resolveToolResult(
      conv,
      'call-1',
      { callId: 'call-1', outcome: 'success', content: { deployed: true } },
      undefined,
      testEnvironment,
    );
    const replaced = getOrderedMessages(resolved).find((message) => message.role === 'tool-result');

    expect(replaced?.id).toBe(pending!.id);
    expect(replaced?.createdAt).toBe(pending!.createdAt);
    expect(replaced?.position).toBe(pending!.position);
  });

  it('works identically on a Conversation rehydrated from serialized JSON', () => {
    const conv = buildPendingConversation();

    // Round-trip through JSON, exactly as a stateless host reconstructing a
    // conversation from persisted storage would.
    const rehydrated = deserializeConversationHistory(JSON.parse(JSON.stringify(conv)));

    const resolved = resolveToolResult(
      rehydrated,
      'call-1',
      { callId: 'call-1', outcome: 'success', content: { deployed: true } },
      undefined,
      testEnvironment,
    );

    const toolResultMessages = getOrderedMessages(resolved).filter(
      (message) => message.role === 'tool-result' && message.toolResult?.callId === 'call-1',
    );
    expect(toolResultMessages).toHaveLength(1);
    expect(toolResultMessages[0]?.toolResult?.outcome).toBe('success');
  });

  it('produces a schema-valid history with coherent ids and positions', () => {
    const conv = buildPendingConversation();

    const resolved = resolveToolResult(
      conv,
      'call-1',
      { callId: 'call-1', outcome: 'success', content: { deployed: true } },
      undefined,
      testEnvironment,
    );

    expect(conversationSchema.safeParse(resolved).success).toBe(true);
    expect(resolved.ids).toEqual(conv.ids);
    resolved.ids.forEach((id, index) => {
      expect(resolved.messages[id]?.position).toBe(index);
    });
  });

  it('throws when no tool-result message exists for the callId', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);

    expect(() =>
      resolveToolResult(
        conv,
        'missing-call',
        { callId: 'missing-call', outcome: 'success', content: {} },
        undefined,
        testEnvironment,
      ),
    ).toThrow();
  });

  it('throws when the callId has no pending tool-result but a tool-call exists', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendToolCall(
      conv,
      { id: 'call-1', name: 'deploy', arguments: {} },
      undefined,
      testEnvironment,
    );

    expect(() =>
      resolveToolResult(
        conv,
        'call-1',
        { callId: 'call-1', outcome: 'success', content: {} },
        undefined,
        testEnvironment,
      ),
    ).toThrow();
  });

  it('overrides content, metadata, hidden, and tokenUsage via options while defaulting to the original values otherwise', () => {
    const conv = buildPendingConversation();

    const resolved = resolveToolResult(
      conv,
      'call-1',
      { callId: 'call-1', outcome: 'success', content: { deployed: true } },
      {
        content: 'Deploy approved.',
        metadata: { approvedBy: 'user-1' },
        hidden: true,
        tokenUsage: { prompt: 10, completion: 5, total: 15 },
      },
      testEnvironment,
    );

    const replaced = getOrderedMessages(resolved).find((message) => message.role === 'tool-result');
    expect(replaced?.content).toBe('Deploy approved.');
    expect(replaced?.metadata).toEqual({ approvedBy: 'user-1' });
    expect(replaced?.hidden).toBe(true);
    expect(replaced?.tokenUsage).toEqual({ prompt: 10, completion: 5, total: 15 });
  });

  it('throws when toolResult.callId does not match the callId argument', () => {
    // call-2 also has a live pending tool-call, so a mis-tagged replacement
    // wouldn't trip the orphan-tool-result integrity check incidentally --
    // this pins the explicit callId/toolResult.callId agreement check, not
    // a side effect of some other invariant.
    let conv = buildPendingConversation();
    conv = appendToolCall(
      conv,
      { id: 'call-2', name: 'notify', arguments: {} },
      undefined,
      testEnvironment,
    );

    let caught: unknown;
    try {
      resolveToolResult(
        conv,
        'call-1',
        { callId: 'call-2', outcome: 'success', content: { deployed: true } },
        undefined,
        testEnvironment,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConversationalistError);
    expect(requireConversationalistError(caught).code).toBe('error:invalid-input');
  });

  it('throws when more than one tool-result message exists for the callId', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendToolCall(
      conv,
      { id: 'call-1', name: 'deploy', arguments: {} },
      undefined,
      testEnvironment,
    );
    conv = appendUnsafeMessage(
      conv,
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'action_required', content: null },
      },
      testEnvironment,
    );
    // Bypasses append-time integrity validation (appendUnsafeMessage) to
    // reconstruct the already-malformed "two answers for one question"
    // state directly, since both appendToolResult and
    // deserializeConversationHistory now reject it via
    // integrity:duplicate-tool-result.
    conv = appendUnsafeMessage(
      conv,
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'success', content: { deployed: true } },
      },
      testEnvironment,
    );

    let caught: unknown;
    try {
      resolveToolResult(
        conv,
        'call-1',
        { callId: 'call-1', outcome: 'success', content: { deployed: true } },
        undefined,
        testEnvironment,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConversationalistError);
    expect(requireConversationalistError(caught).code).toBe('error:integrity');
    // Pins the explicit "which one did you mean" guard specifically (not
    // just the general post-replace integrity check, which would also fire
    // here since one unresolved duplicate always survives a same-shape
    // replace): the guard's message names the callId directly.
    expect(requireConversationalistError(caught).message).toContain(
      `multiple tool-result messages found for callId: call-1`,
    );
  });
});
