import { describe, expect, it } from 'bun:test';

import { fromGeminiMessages } from '../src/adapters/gemini/inbound';
import { toGeminiMessages } from '../src/adapters/gemini/outbound';
import { appendMessages, createConversationHistory } from '../src/conversation';
import type { ConversationHistory } from '../src/types';

const environment = {
  now: () => '2024-01-01T00:00:00.000Z',
  randomId: (() => {
    let count = 0;
    return () => `gemini-regression-${++count}`;
  })(),
};

function createArrayToolConversation(): ConversationHistory {
  let conversation = createConversationHistory({ id: 'gemini-array' }, environment);
  conversation = appendMessages(
    conversation,
    {
      role: 'tool-call',
      content: '',
      toolCall: { id: 'weather-1', name: 'weather', arguments: {} },
    },
    {
      role: 'tool-result',
      content: '',
      toolResult: {
        callId: 'weather-1',
        outcome: 'success',
        content: ['Denver:72F', 'sunny'],
      },
    },
    environment,
  );
  return conversation;
}

describe('Gemini provider regressions', () => {
  it('wraps successful array results and round-trips them', () => {
    const exported = toGeminiMessages(createArrayToolConversation());
    const response = exported.contents[1]?.parts[0];

    expect(response).toEqual({
      functionResponse: {
        name: 'weather',
        response: { result: ['Denver:72F', 'sunny'] },
      },
    });

    const imported = fromGeminiMessages(exported);
    const result = Object.values(imported.messages).find(
      (message) => message.role === 'tool-result',
    );
    expect(result?.toolResult?.content).toEqual(['Denver:72F', 'sunny']);
  });
});
