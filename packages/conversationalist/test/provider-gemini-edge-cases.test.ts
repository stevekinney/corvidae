import { describe, expect, it } from 'bun:test';

import { fromGeminiMessages } from '../src/adapters/gemini/inbound';
import { ConversationalistError } from '../src/errors';
import type { Message } from '../src/types';

const getOrderedMessages = (messages: {
  ids: ReadonlyArray<string>;
  messages: Readonly<Record<string, Message>>;
}): Message[] =>
  messages.ids
    .map((id) => messages.messages[id])
    .filter((message): message is Message => Boolean(message));

describe('Gemini provider edge cases', () => {
  it('rejects orphan Gemini function responses that cannot be linked to a tool call', () => {
    expect(() =>
      fromGeminiMessages({
        contents: [
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'no_call_yet',
                  response: { status: 'orphan' },
                },
              },
            ],
          },
        ],
      }),
    ).toThrow(ConversationalistError);
  });

  it('matches repeated Gemini function responses in queue order', () => {
    const conversation = fromGeminiMessages({
      contents: [
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'lookup_weather',
                args: { city: 'Denver' },
              },
            },
            {
              functionCall: {
                name: 'lookup_weather',
                args: { city: 'Boulder' },
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'lookup_weather',
                response: { result: { city: 'Denver' } },
              },
            },
            {
              functionResponse: {
                name: 'lookup_weather',
                response: { result: { city: 'Boulder' } },
              },
            },
          ],
        },
      ],
    });

    const toolResults = getOrderedMessages(conversation).filter(
      (message) => message.role === 'tool-result',
    );

    expect(toolResults.map((message) => message.toolResult?.callId)).toEqual([
      'gemini-call-1',
      'gemini-call-2',
    ]);
    expect(toolResults.map((message) => message.toolResult?.content)).toEqual([
      { city: 'Denver' },
      { city: 'Boulder' },
    ]);
  });

  it('omits an empty Gemini system instruction when it has no parts', () => {
    const conversation = fromGeminiMessages({
      systemInstruction: {
        role: 'user',
        parts: [],
      },
      contents: [],
    });

    expect(conversation.ids).toHaveLength(0);
  });
});
