import { ReasoningMessageSchema } from '@ag-ui/core/schemas';
import { describe, expect, it } from 'bun:test';

import { AGUIMappingError } from '../src/adapters/ag-ui/errors';
import { fromAGUIMessages } from '../src/adapters/ag-ui/inbound';
import { toAGUIMessages } from '../src/adapters/ag-ui/outbound';
import { appendMessages, createConversationHistory } from '../src/conversation/index';
import { ConversationalistError } from '../src/errors';
import type { MessageInput } from '../src/types';
import { getOrderedMessages } from '../src/utilities/message-store';
import { testEnvironment } from './adapter-test-fixtures';

const SIGNATURE = 'EqoBCkgIARABGAIiQL8gy6bfP3E5example_signature==';

function build(...inputs: MessageInput[]) {
  return appendMessages(
    createConversationHistory({ id: 'ag-ui' }, testEnvironment),
    ...inputs,
    testEnvironment,
  );
}

describe('AG-UI adapter: reasoning', () => {
  it('maps a thinking part to a reasoning message ahead of its assistant message', () => {
    const conversation = build(
      { role: 'user', content: 'What is 2+2?' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Two plus two is four.', signature: SIGNATURE },
          { type: 'text', text: 'Four.' },
        ],
      },
    );
    const messages = toAGUIMessages(conversation);
    expect(messages.map((message) => message.role)).toEqual(['user', 'reasoning', 'assistant']);
    const reasoning = messages[1];
    expect(reasoning).toMatchObject({
      role: 'reasoning',
      content: 'Two plus two is four.',
      encryptedValue: SIGNATURE,
    });
    expect(ReasoningMessageSchema.safeParse(reasoning).success).toBe(true);
    expect(messages[2]).toMatchObject({ role: 'assistant', content: 'Four.' });
  });

  it('round-trips a thinking part with its signature byte for byte', () => {
    const conversation = build({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Let me think.', signature: SIGNATURE },
        { type: 'text', text: 'Done.' },
      ],
    });
    const restored = fromAGUIMessages(toAGUIMessages(conversation));
    expect(getOrderedMessages(restored).map((message) => message.content)).toEqual([
      [
        { type: 'thinking', thinking: 'Let me think.', signature: SIGNATURE },
        { type: 'text', text: 'Done.' },
      ],
    ]);
  });

  it('keeps several thinking parts in order', () => {
    const conversation = build({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'first', signature: 's1' },
        { type: 'thinking', thinking: 'second', signature: 's2' },
        { type: 'text', text: 'answer' },
      ],
    });
    const messages = toAGUIMessages(conversation);
    expect(
      messages.filter((message) => message.role === 'reasoning').map((m) => m.id),
    ).toHaveLength(2);
    const restored = fromAGUIMessages(messages);
    expect(getOrderedMessages(restored)[0]?.content).toEqual(
      getOrderedMessages(conversation)[0]?.content,
    );
  });

  it('round-trips an assistant message that holds only thinking without merging it into the next', () => {
    const conversation = build(
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: SIGNATURE }] },
      { role: 'assistant', content: 'Then I answered.' },
    );
    const restored = fromAGUIMessages(toAGUIMessages(conversation));
    expect(getOrderedMessages(restored).map((message) => message.content)).toEqual([
      [{ type: 'thinking', thinking: 'hmm', signature: SIGNATURE }],
      'Then I answered.',
    ]);
  });

  it('maps a reasoning message without an encryptedValue to an empty signature', () => {
    const restored = fromAGUIMessages([
      { id: 'r1', role: 'reasoning', content: 'unsigned' },
      { id: 'a1', role: 'assistant', content: 'ok' },
    ]);
    expect(getOrderedMessages(restored)[0]?.content).toEqual([
      { type: 'thinking', thinking: 'unsigned', signature: '' },
      { type: 'text', text: 'ok' },
    ]);
  });

  it('keeps trailing reasoning as its own assistant message', () => {
    const restored = fromAGUIMessages([
      { id: 'u1', role: 'user', content: 'Hi' },
      { id: 'r1', role: 'reasoning', content: 'thinking out loud' },
    ]);
    expect(getOrderedMessages(restored).map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
  });

  it('rejects redacted_thinking on the outbound path with a ConversationalistError', () => {
    const conversation = build({
      role: 'assistant',
      content: [
        { type: 'redacted_thinking', data: 'EqoBRedacted==' },
        { type: 'text', text: 'Answer.' },
      ],
    });
    try {
      toAGUIMessages(conversation);
      throw new Error('expected toAGUIMessages to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AGUIMappingError);
      expect(error).toBeInstanceOf(ConversationalistError);
      expect((error as ConversationalistError).code).toBe('error:validation');
      expect((error as AGUIMappingError).kind).toBe('redacted_thinking');
    }
  });
});
