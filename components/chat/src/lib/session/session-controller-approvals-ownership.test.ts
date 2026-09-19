import { describe, expect, test } from 'bun:test';
import {
  appendAssistantMessage,
  appendToolCall,
  appendToolResult,
  appendUserMessage,
  createConversationHistory,
} from '../components/chat/builders.ts';
import type { ToolResult } from '../components/chat/conversation-model.ts';
import { createChatSessionController } from './session-controller.ts';
import type { ChatStreamEvent } from './stream-event-codec.ts';

async function* events(values: ChatStreamEvent[]): AsyncGenerator<ChatStreamEvent> {
  yield* values;
}

describe('chat session controller', () => {
  test('continues when an approval hook returns an action-less approval result', async () => {
    let conversation = appendToolResult(
      appendToolCall(
        appendUserMessage(createConversationHistory({ id: 'action-less-approval' }), 'deploy'),
        { id: 'call', name: 'deploy', arguments: {} },
      ),
      {
        callId: 'call',
        outcome: 'action_required',
        content: null,
        action: { type: 'approval' },
      },
    );
    let continuations = 0;
    const controller = createChatSessionController({
      getConversation: () => conversation,
      setConversation: (next) => {
        conversation = next;
      },
      transport: async () => {
        continuations += 1;
        return events([{ type: 'text', text: 'continued' }]);
      },
      hooks: {
        approveToolCall: async (callId) => ({
          callId,
          outcome: 'action_required',
          content: null,
        }),
      },
    });

    await Promise.resolve(
      expect(controller.adapter.approveToolCall?.('call')).resolves.toBe('resolved'),
    );
    expect(continuations).toBe(1);
  });

  test('continues when a denial hook returns an action-less approval result', async () => {
    let conversation = appendToolResult(
      appendToolCall(
        appendUserMessage(createConversationHistory({ id: 'action-less-denial' }), 'deploy'),
        { id: 'call', name: 'deploy', arguments: {} },
      ),
      {
        callId: 'call',
        outcome: 'action_required',
        content: null,
        action: { type: 'approval' },
      },
    );
    let continuations = 0;
    const controller = createChatSessionController({
      getConversation: () => conversation,
      setConversation: (next) => {
        conversation = next;
      },
      transport: async () => {
        continuations += 1;
        return events([{ type: 'text', text: 'continued' }]);
      },
      hooks: {
        denyToolCall: async (callId) => ({
          callId,
          outcome: 'action_required',
          content: null,
        }),
      },
    });

    await Promise.resolve(
      expect(controller.adapter.denyToolCall?.('call')).resolves.toBe('resolved'),
    );
    expect(continuations).toBe(1);
  });

  test('continues the latest owning turn when cross-turn approvals resolve out of order', async () => {
    let conversation = appendToolResult(
      appendToolCall(
        appendAssistantMessage(
          appendUserMessage(createConversationHistory({ id: 'cross-turn' }), 'older'),
          'Older approval required.',
        ),
        { id: 'older-call', name: 'write', arguments: {} },
      ),
      {
        callId: 'older-call',
        outcome: 'action_required',
        content: null,
        action: { type: 'approval' },
      },
    );
    conversation = appendUserMessage(conversation, 'newer');
    const newerUser = conversation.ids.at(-1)!;
    const olderUser = conversation.ids[0]!;
    conversation = appendToolResult(
      appendToolCall(appendAssistantMessage(conversation, 'Newer approval required.'), {
        id: 'newer-call',
        name: 'write',
        arguments: {},
      }),
      {
        callId: 'newer-call',
        outcome: 'action_required',
        content: null,
        action: { type: 'approval' },
      },
    );
    const markFailed = (id: string): void => {
      conversation = {
        ...conversation,
        messages: {
          ...conversation.messages,
          [id]: {
            ...conversation.messages[id]!,
            metadata: { ...conversation.messages[id]!.metadata, _deliveryStatus: 'failed' },
          },
        },
      };
    };
    markFailed(olderUser);
    markFailed(newerUser);
    let calls = 0;
    const controller = createChatSessionController({
      getConversation: () => conversation,
      setConversation: (next) => {
        conversation = next;
      },
      transport: async () => {
        calls += 1;
        return events([{ type: 'text', text: 'continued latest turn' }]);
      },
      hooks: {
        approveToolCall: async (id) => ({ callId: id, outcome: 'success', content: 'allowed' }),
      },
    });

    await controller.adapter.approveToolCall?.('newer-call');
    expect(calls).toBe(0);
    await controller.adapter.approveToolCall?.('older-call');

    expect(calls).toBe(1);
    expect(conversation.messages[olderUser]?.metadata['_deliveryStatus']).toBe('failed');
    expect(conversation.messages[newerUser]?.metadata['_deliveryStatus']).toBeUndefined();
  });

  test('ignores an approval result that arrives after disposal', async () => {
    let conversation = appendToolResult(
      appendToolCall(
        appendAssistantMessage(
          appendUserMessage(createConversationHistory({ id: 'dispose-approval' }), 'write'),
          'Approval required.',
        ),
        { id: 'call', name: 'write', arguments: {} },
      ),
      { callId: 'call', outcome: 'action_required', content: null, action: { type: 'approval' } },
    );
    let resolveApproval!: (result: ToolResult) => void;
    const controller = createChatSessionController({
      getConversation: () => conversation,
      setConversation: (next) => {
        conversation = next;
      },
      transport: async () => events([{ type: 'text', text: 'unexpected' }]),
      hooks: {
        approveToolCall: async () =>
          new Promise<ToolResult>((resolve) => {
            resolveApproval = resolve;
          }),
      },
    });
    const original = conversation;
    const approval = controller.adapter.approveToolCall?.('call');
    await Promise.resolve();
    controller.dispose();
    resolveApproval({ callId: 'call', outcome: 'success', content: 'allowed' });

    await Promise.resolve(expect(approval).rejects.toThrow('disposed'));
    expect(conversation).toBe(original);
  });

  test('continues a persisted approval from its owning user turn', async () => {
    let conversation = appendToolResult(
      appendToolCall(
        appendAssistantMessage(
          appendUserMessage(createConversationHistory({ id: 'persisted-approval' }), 'write'),
          'I need approval first.',
        ),
        { id: 'call', name: 'write', arguments: {} },
      ),
      { callId: 'call', outcome: 'action_required', content: null, action: { type: 'approval' } },
    );
    let calls = 0;
    const controller = createChatSessionController({
      getConversation: () => conversation,
      setConversation: (next) => {
        conversation = next;
      },
      transport: async () => {
        calls += 1;
        return events([{ type: 'text', text: 'approved after reload' }]);
      },
      hooks: {
        approveToolCall: async (toolCallId) => ({
          callId: toolCallId,
          outcome: 'success',
          content: 'allowed',
        }),
      },
    });

    await controller.adapter.approveToolCall?.('call');

    expect(calls).toBe(1);
    expect(
      Object.values(conversation.messages).some(
        (message) => message.content === 'approved after reload',
      ),
    ).toBe(true);
  });
});
