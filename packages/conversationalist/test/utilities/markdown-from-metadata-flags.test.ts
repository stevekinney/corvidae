import { describe, expect, test } from 'bun:test';

import { fromMarkdown } from '../../src';
import type { ConversationHistory, Message } from '../../src/types';
import { isAssistantMessage } from '../../src/utilities';

const getOrderedMessages = (conversation: ConversationHistory): Message[] =>
  conversation.ids
    .map((id) => conversation.messages[id])
    .filter((message): message is Message => Boolean(message));

describe('markdown-from-metadata-flags', () => {
  test('parses tokenUsage metadata', () => {
    const markdown = `---
id: conv-1
status: active
metadata: {}
createdAt: '2024-01-15T10:00:00.000Z'
updatedAt: '2024-01-15T10:00:00.000Z'
messages:
  msg-1:
    position: 0
    createdAt: '2024-01-15T10:00:00.000Z'
    metadata: {}
    hidden: false
    tokenUsage:
      prompt: 100
      completion: 50
      total: 150
---

### Assistant (msg-1)

Response`;

    const conversation = fromMarkdown(markdown);
    expect(getOrderedMessages(conversation)[0]!.tokenUsage).toBeDefined();
    expect(getOrderedMessages(conversation)[0]!.tokenUsage?.prompt).toBe(100);
    expect(getOrderedMessages(conversation)[0]!.tokenUsage?.completion).toBe(50);
    expect(getOrderedMessages(conversation)[0]!.tokenUsage?.total).toBe(150);
  });

  test('parses goalCompleted metadata', () => {
    const markdown = `---
id: conv-1
status: active
metadata: {}
createdAt: '2024-01-15T10:00:00.000Z'
updatedAt: '2024-01-15T10:00:00.000Z'
messages:
  msg-1:
    position: 0
    createdAt: '2024-01-15T10:00:00.000Z'
    metadata: {}
    hidden: false
    goalCompleted: true
---

### Assistant (msg-1)

Task complete`;

    const conversation = fromMarkdown(markdown);
    const message = getOrderedMessages(conversation)[0]!;
    expect(isAssistantMessage(message) && message.goalCompleted).toBe(true);
  });

  test('parses cacheBoundary metadata', () => {
    const markdown = `---
id: conv-1
status: active
metadata: {}
createdAt: '2024-01-15T10:00:00.000Z'
updatedAt: '2024-01-15T10:00:00.000Z'
messages:
  msg-1:
    position: 0
    createdAt: '2024-01-15T10:00:00.000Z'
    metadata: {}
    hidden: false
    cacheBoundary: true
---

### System (msg-1)

Stable prefix.`;

    const conversation = fromMarkdown(markdown);
    const message = getOrderedMessages(conversation)[0]!;
    expect(message?.cacheBoundary).toBe(true);
  });
});
