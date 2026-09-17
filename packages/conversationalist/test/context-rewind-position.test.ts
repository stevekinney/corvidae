import { describe, expect, it } from 'bun:test';

import { truncateFromPosition } from '../src/context-recent';
import { rewindBeforePosition } from '../src/context-rewind';
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

describe('rewindBeforePosition', () => {
  const buildFourMessageConversation = (): Conversation => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    return appendMessages(
      conv,
      { role: 'user', content: 'Message 0' },
      { role: 'assistant', content: 'Message 1' },
      { role: 'user', content: 'Message 2' },
      { role: 'assistant', content: 'Message 3' },
      testEnvironment,
    );
  };

  const buildToolPairConversation = (leading: boolean): Conversation => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    if (leading) {
      conv = appendMessages(conv, { role: 'user', content: 'Weather?' }, testEnvironment);
    }
    conv = appendToolCall(
      conv,
      { id: 'call-1', name: 'lookup-weather', arguments: { city: 'Denver' } },
      undefined,
      testEnvironment,
    );
    return appendToolResult(
      conv,
      { callId: 'call-1', outcome: 'success', content: { forecast: 'sunny' } },
      undefined,
      testEnvironment,
    );
  };

  it('drops the message at the position and everything after it', () => {
    const rewound = rewindBeforePosition(
      buildFourMessageConversation(),
      2,
      undefined,
      testEnvironment,
    );

    expect(getOrderedMessages(rewound).map((message) => message.content)).toEqual([
      'Message 0',
      'Message 1',
    ]);
  });

  it('keeps the opposite tail from truncateFromPosition at the same boundary', () => {
    const conv = buildFourMessageConversation();

    const rewoundContent = getOrderedMessages(
      rewindBeforePosition(conv, 2, undefined, testEnvironment),
    ).map((message) => message.content);
    const truncatedContent = getOrderedMessages(
      truncateFromPosition(conv, 2, undefined, testEnvironment),
    ).map((message) => message.content);

    expect(rewoundContent).toEqual(['Message 0', 'Message 1']);
    expect(truncatedContent).toEqual(['Message 2', 'Message 3']);
    expect(rewoundContent.some((content) => truncatedContent.includes(content))).toBe(false);
  });

  it('renumbers positions from zero so the transcript has no gap', () => {
    const rewound = rewindBeforePosition(
      buildFourMessageConversation(),
      3,
      undefined,
      testEnvironment,
    );

    expect(getOrderedMessages(rewound).map((message) => message.position)).toEqual([0, 1, 2]);
  });

  it('keeps ids and messages consistent rather than leaving orphaned entries', () => {
    const rewound = rewindBeforePosition(
      buildFourMessageConversation(),
      1,
      undefined,
      testEnvironment,
    );

    expect(rewound.ids).toHaveLength(1);
    expect(Object.keys(rewound.messages)).toEqual([...rewound.ids]);
  });

  it('returns the same conversation when the position is past the end', () => {
    const conv = buildFourMessageConversation();

    expect(rewindBeforePosition(conv, 4, undefined, testEnvironment)).toBe(conv);
    expect(rewindBeforePosition(conv, 99, undefined, testEnvironment)).toBe(conv);
  });

  it('empties the conversation at position zero', () => {
    const rewound = rewindBeforePosition(
      buildFourMessageConversation(),
      0,
      undefined,
      testEnvironment,
    );

    expect(getOrderedMessages(rewound)).toHaveLength(0);
    expect(rewound.ids).toHaveLength(0);
    expect(Object.keys(rewound.messages)).toHaveLength(0);
  });

  it('discards a system message that lives after the boundary', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Message 0' },
      { role: 'system', content: 'Late system prompt' },
      { role: 'assistant', content: 'Message 2' },
      testEnvironment,
    );

    const rewound = rewindBeforePosition(conv, 1, undefined, testEnvironment);

    expect(getOrderedMessages(rewound).some((message) => message.role === 'system')).toBe(false);
  });

  it('drops a tool call whose result falls after the boundary', () => {
    // The boundary lands on the tool result, so the call it belongs to would be
    // left orphaned if the pair were split.
    const rewound = rewindBeforePosition(
      buildToolPairConversation(true),
      2,
      undefined,
      testEnvironment,
    );

    expect(getOrderedMessages(rewound).map((message) => message.role)).toEqual(['user']);
  });

  it('cuts strictly at the boundary when preserveToolPairs is false', () => {
    const conv = buildToolPairConversation(true);

    const rewound = rewindBeforePosition(conv, 2, { preserveToolPairs: false }, testEnvironment);

    // The call survives without its result. That is a pending tool call, which
    // is a legitimate transcript state — only an orphaned tool *result* is
    // invalid linkage — so this rewinds rather than throwing.
    expect(getOrderedMessages(rewound).map((message) => message.role)).toEqual([
      'user',
      'tool-call',
    ]);
  });

  it('keeps a tool pair that sits entirely before the boundary', () => {
    let conv = buildToolPairConversation(false);
    conv = appendMessages(conv, { role: 'assistant', content: 'Sunny.' }, testEnvironment);

    const rewound = rewindBeforePosition(conv, 2, undefined, testEnvironment);

    expect(getOrderedMessages(rewound).map((message) => message.role)).toEqual([
      'tool-call',
      'tool-result',
    ]);
  });

  it('decides prefix membership by transcript order, not stored positions', () => {
    // Schema-valid histories can carry stored positions that disagree with
    // `ids` order (stale snapshots, hand-assembled transcripts). The second
    // message carries a LARGER stored position than the later third message;
    // cutting by stored position would drop the second but retain the third,
    // which sits after it in the transcript.
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

    const rewound = rewindBeforePosition(drifted, 9, undefined, testEnvironment);

    expect(getOrderedMessages(rewound).map((message) => message.content)).toEqual(['Message A']);
  });
});
