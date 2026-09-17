import { describe, expect, it } from 'bun:test';

import { rewindBeforeMessage } from '../src/context-rewind';
import {
  appendMessages,
  appendToolCall,
  appendToolResult,
  createConversationHistory as createConversation,
} from '../src/conversation/index';
import type { ConversationHistory as Conversation, Message } from '../src/types';

const getOrderedMessages = (conversation: Conversation): Message[] =>
  conversation.ids
    .map((id) => conversation.messages[id])
    .filter((message): message is Message => Boolean(message));

const testEnvironment = {
  now: () => '2024-01-01T00:00:00.000Z',
  randomId: (() => {
    let counter = 0;
    return () => `test-id-${++counter}`;
  })(),
};

describe('rewindBeforeMessage', () => {
  it('drops the named message and everything after it', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Message 0' },
      { role: 'assistant', content: 'Message 1' },
      { role: 'user', content: 'Message 2' },
      testEnvironment,
    );

    const target = getOrderedMessages(conv)[1]!;
    const rewound = rewindBeforeMessage(conv, target?.id ?? '', undefined, testEnvironment);

    expect(getOrderedMessages(rewound).map((message) => message.content)).toEqual(['Message 0']);
  });

  it('returns the same conversation for an unknown id', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(conv, { role: 'user', content: 'Message 0' }, testEnvironment);

    expect(rewindBeforeMessage(conv, 'nope', undefined, testEnvironment)).toBe(conv);
  });

  it('locates the target by transcript order, not its stored position', () => {
    // The id names a place in the transcript; a stale stored position on the
    // target must not decide what survives. The target (second message)
    // carries a larger stored position than the later third message —
    // delegating via `target.position` would keep that later message.
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Message A' },
      { role: 'assistant', content: 'Message B' },
      { role: 'user', content: 'Message C' },
      testEnvironment,
    );
    const [, bId, cId] = conv.ids;
    if (bId === undefined || cId === undefined) throw new Error('expected message identifiers');
    const drifted: Conversation = {
      ...conv,
      messages: {
        ...conv.messages,
        [bId]: { ...conv.messages[bId]!, position: 9 },
        [cId]: { ...conv.messages[cId]!, position: 3 },
      },
    };

    const rewound = rewindBeforeMessage(drifted, bId, undefined, testEnvironment);

    expect(getOrderedMessages(rewound).map((message) => message.content)).toEqual(['Message A']);
  });

  it('drops a straddling tool pair by ordered extent even with drifted positions', () => {
    // ids order: user, tool-call, tool-result — but the call's stored
    // position is inflated past the result's. Rewinding before the result
    // must still discard the whole pair: block extents are measured by
    // transcript order, so the call cannot survive on the strength of a
    // stale position comparison.
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(conv, { role: 'user', content: 'Weather?' }, testEnvironment);
    conv = appendToolCall(
      conv,
      { id: 'call-1', name: 'lookup-weather', arguments: { city: 'Denver' } },
      undefined,
      testEnvironment,
    );
    conv = appendToolResult(
      conv,
      { callId: 'call-1', outcome: 'success', content: { forecast: 'sunny' } },
      undefined,
      testEnvironment,
    );
    const [, callId, resultId] = conv.ids;
    if (callId === undefined || resultId === undefined)
      throw new Error('expected tool identifiers');
    const drifted: Conversation = {
      ...conv,
      messages: {
        ...conv.messages,
        [callId]: { ...conv.messages[callId]!, position: 9 },
        [resultId]: { ...conv.messages[resultId]!, position: 3 },
      },
    };

    const rewound = rewindBeforeMessage(drifted, resultId, undefined, testEnvironment);

    expect(getOrderedMessages(rewound).map((message) => message.role)).toEqual(['user']);
  });
});
