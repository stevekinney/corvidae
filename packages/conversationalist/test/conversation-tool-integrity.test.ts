import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { describe, expect, test } from 'bun:test';
import {
  appendMessages,
  createConversationHistory as createConversation,
} from '../src/conversation/index';
import { ConversationalistError } from '../src/errors';
import { getOrderedMessages } from '../src/utilities/message-store';

const runtime = createManualRuntimeServices();

describe('conversation tool integrity', () => {
  test('tool linkage is validated across batch', () => {
    let c = createConversation();
    expect(() =>
      appendMessages(c, {
        role: 'tool-result',
        content: 'x',
        toolResult: { callId: 'missing', outcome: 'error', content: {} },
      }),
    ).toThrow(ConversationalistError);

    // Valid when tool-call precedes in batch
    c = appendMessages(
      c,
      {
        role: 'tool-call',
        content: 'call',
        toolCall: { id: 'call-1', name: 't', arguments: {} },
      },
      {
        role: 'tool-result',
        content: 'ok',
        toolResult: { callId: 'call-1', outcome: 'success', content: {} },
      },
    );
    expect(c.ids.length).toBe(2);
  });

  test('rejects non-JSON tool payloads', () => {
    const conversation = createConversation();

    expect(() =>
      Reflect.apply(appendMessages, undefined, [
        conversation,
        {
          role: 'tool-call',
          content: '',
          toolCall: {
            id: 'call-1',
            name: 'tool',
            arguments: new Date(runtime.clock.now()),
          },
        },
      ]),
    ).toThrow(ConversationalistError);

    expect(() =>
      Reflect.apply(appendMessages, undefined, [
        appendMessages(conversation, {
          role: 'tool-call',
          content: '',
          toolCall: { id: 'call-2', name: 'tool', arguments: {} },
        }),
        {
          role: 'tool-result',
          content: '',
          toolResult: {
            callId: 'call-2',
            outcome: 'success',
            content: new Date(runtime.clock.now()),
          },
        },
      ]),
    ).toThrow(ConversationalistError);
  });

  test('appendMessages rejects duplicate tool call ids', () => {
    const c = createConversation();
    expect(() =>
      appendMessages(
        c,
        {
          role: 'tool-call',
          content: '',
          toolCall: { id: 'dup', name: 'tool', arguments: {} },
        },
        {
          role: 'tool-call',
          content: '',
          toolCall: { id: 'dup', name: 'tool', arguments: {} },
        },
      ),
    ).toThrow(ConversationalistError);
  });

  test('append tool referencing prior tool-call in existing conversation', () => {
    let c = createConversation();
    c = appendMessages(c, {
      role: 'tool-call',
      content: 'call',
      toolCall: { id: 'prev-call', name: 't', arguments: {} },
    });
    // Second append references tool-call from previous state
    c = appendMessages(c, {
      role: 'tool-result',
      content: 'ok',
      toolResult: { callId: 'prev-call', outcome: 'success', content: {} },
    });
    const messages = getOrderedMessages(c);
    expect(messages.length).toBe(2);
    expect(messages[1]!.role).toBe('tool-result');
  });
});
