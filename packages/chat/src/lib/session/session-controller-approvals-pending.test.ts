import { describe, expect, test } from 'bun:test';
import {
  appendToolCall,
  appendToolResult,
  appendUserMessage,
  createConversationHistory,
} from '../components/chat/builders.ts';
import { createChatSessionController } from './session-controller.ts';
import type { ChatStreamEvent } from './stream-event-codec.ts';

async function* events(values: ChatStreamEvent[]): AsyncGenerator<ChatStreamEvent> {
  yield* values;
}

describe('chat session controller', () => {
  test('continues after a tool result and invokes approval hooks', async () => {
    let conversation = createConversationHistory({ id: 'tools' });
    let calls = 0;
    let approved = '';
    const controller = createChatSessionController({
      getConversation: () => conversation,
      setConversation: (next) => {
        conversation = next;
      },
      transport: async () => {
        calls += 1;
        return calls === 1
          ? events([
              { type: 'tool_call', id: 'call', name: 'read', arguments: {} },
              { type: 'tool_result', callId: 'call', outcome: 'success', content: 'ok' },
            ])
          : events([{ type: 'text', text: 'done' }]);
      },
      hooks: {
        approveToolCall: async (id) => {
          approved = id;
          return undefined;
        },
      },
    });
    await controller.adapter.sendMessage({ role: 'user', content: 'run' }, []);
    expect(calls).toBe(2);
    expect(approved).toBe('');
    expect(Object.values(conversation.messages).some((message) => message.content === 'done')).toBe(
      true,
    );
  });

  test('waits for approval before continuing a tool turn', async () => {
    let conversation = createConversationHistory({ id: 'approval' });
    let calls = 0;
    const controller = createChatSessionController({
      getConversation: () => conversation,
      setConversation: (next) => {
        conversation = next;
      },
      transport: async () => {
        calls += 1;
        return calls === 1
          ? events([
              { type: 'tool_call', id: 'call', name: 'write', arguments: {} },
              {
                type: 'tool_result',
                callId: 'call',
                outcome: 'action_required',
                content: null,
                action: { type: 'approval', message: 'Approve this tool call' },
              },
            ])
          : events([{ type: 'text', text: 'approved' }]);
      },
      hooks: {
        approveToolCall: async (toolCallId) => ({
          callId: toolCallId,
          outcome: 'success',
          content: 'allowed',
        }),
      },
    });
    await controller.adapter.sendMessage({ role: 'user', content: 'write' }, []);
    expect(calls).toBe(1);
    await controller.adapter.approveToolCall?.('call');
    expect(calls).toBe(2);
    expect(
      Object.values(conversation.messages).some((message) => message.content === 'approved'),
    ).toBe(true);
  });

  test('blocks a fresh send while an approval is pending', async () => {
    let conversation = createConversationHistory({ id: 'approval-send-branch' });
    let calls = 0;
    const controller = createChatSessionController({
      getConversation: () => conversation,
      setConversation: (next) => {
        conversation = next;
      },
      transport: async () => {
        calls += 1;
        return events([
          { type: 'tool_call', id: 'call', name: 'write', arguments: {} },
          {
            type: 'tool_result',
            callId: 'call',
            outcome: 'action_required',
            content: null,
            action: { type: 'approval' },
          },
        ]);
      },
      hooks: {
        approveToolCall: async () => ({ callId: 'call', outcome: 'success', content: 'allowed' }),
      },
    });
    await controller.adapter.sendMessage({ role: 'user', content: 'write' }, []);
    const before = conversation;

    await Promise.resolve(
      expect(
        controller.adapter.sendMessage({ role: 'user', content: 'new branch' }, []),
      ).rejects.toThrow('approval'),
    );
    expect(calls).toBe(1);
    expect(conversation).toBe(before);
  });

  test('keeps a repeated approval request pending and reports that state to Chat', async () => {
    let conversation = appendToolResult(
      appendToolCall(
        appendUserMessage(createConversationHistory({ id: 'repeated-approval' }), 'deploy'),
        { id: 'call', name: 'deploy', arguments: {} },
      ),
      {
        callId: 'call',
        outcome: 'action_required',
        content: null,
        action: { type: 'approval', message: 'Approve staging?' },
      },
    );
    const controller = createChatSessionController({
      getConversation: () => conversation,
      setConversation: (next) => {
        conversation = next;
      },
      transport: async () => events([]),
      hooks: {
        approveToolCall: async (callId) => ({
          callId,
          outcome: 'action_required',
          content: null,
          action: { type: 'approval', message: 'Approve production?' },
        }),
      },
    });

    await Promise.resolve(
      expect(controller.adapter.approveToolCall?.('call')).resolves.toBe('pending'),
    );
    expect(
      Object.values(conversation.messages).find(
        (message) => message.role === 'tool-result' && message.toolResult?.callId === 'call',
      )?.toolResult?.action,
    ).toEqual({ type: 'approval', message: 'Approve production?' });
  });

  test('keeps a repeated denial request pending and reports that state to Chat', async () => {
    let conversation = appendToolResult(
      appendToolCall(
        appendUserMessage(createConversationHistory({ id: 'repeated-denial' }), 'deploy'),
        { id: 'call', name: 'deploy', arguments: {} },
      ),
      {
        callId: 'call',
        outcome: 'action_required',
        content: null,
        action: { type: 'approval', message: 'Approve staging?' },
      },
    );
    const controller = createChatSessionController({
      getConversation: () => conversation,
      setConversation: (next) => {
        conversation = next;
      },
      transport: async () => events([]),
      hooks: {
        denyToolCall: async (callId) => ({
          callId,
          outcome: 'action_required',
          content: null,
          action: { type: 'approval', message: 'Request an exception?' },
        }),
      },
    });

    await Promise.resolve(
      expect(controller.adapter.denyToolCall?.('call')).resolves.toBe('pending'),
    );
    expect(
      Object.values(conversation.messages).find(
        (message) => message.role === 'tool-result' && message.toolResult?.callId === 'call',
      )?.toolResult?.action,
    ).toEqual({ type: 'approval', message: 'Request an exception?' });
  });
});
