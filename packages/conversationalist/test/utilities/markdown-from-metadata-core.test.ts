import { describe, expect, test } from 'bun:test';

import { fromMarkdown } from '../../src';
import type { ConversationHistory, Message } from '../../src/types';

const getOrderedMessages = (conversation: ConversationHistory): Message[] =>
  conversation.ids
    .map((id) => conversation.messages[id])
    .filter((message): message is Message => Boolean(message));

describe('markdown-from-metadata-core', () => {
  test('parses conversation with no messages', () => {
    const markdown = `---
id: conv-1
status: active
metadata: {}
createdAt: '2024-01-15T10:00:00.000Z'
updatedAt: '2024-01-15T10:00:00.000Z'
messages: {}
---`;

    const conversation = fromMarkdown(markdown);
    expect(conversation.id).toBe('conv-1');
    expect(conversation.status).toBe('active');
    expect(getOrderedMessages(conversation)).toHaveLength(0);
  });

  test('parses conversation with title', () => {
    const markdown = `---
id: conv-1
title: My Conversation
status: active
metadata: {}
createdAt: '2024-01-15T10:00:00.000Z'
updatedAt: '2024-01-15T10:00:00.000Z'
messages: {}
---`;

    const conversation = fromMarkdown(markdown);
    expect(conversation.title).toBe('My Conversation');
  });

  test('parses conversation metadata', () => {
    const markdown = `---
id: conv-1
status: active
metadata:
  key: value
  count: 42
createdAt: '2024-01-15T10:00:00.000Z'
updatedAt: '2024-01-15T10:00:00.000Z'
messages: {}
---`;

    const conversation = fromMarkdown(markdown);
    expect(conversation.metadata).toEqual({ key: 'value', count: 42 });
  });

  test('parses single text message', () => {
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
---

### User (msg-1)

Hello, world!`;

    const conversation = fromMarkdown(markdown);
    expect(getOrderedMessages(conversation)).toHaveLength(1);
    expect(getOrderedMessages(conversation)[0]!.id).toBe('msg-1');
    expect(getOrderedMessages(conversation)[0]!.role).toBe('user');
    expect(getOrderedMessages(conversation)[0]!.content).toBe('Hello, world!');
    expect(getOrderedMessages(conversation)[0]!.position).toBe(0);
    expect(getOrderedMessages(conversation)[0]!.hidden).toBe(false);
  });

  test('parses multiple messages', () => {
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
  msg-2:
    position: 1
    createdAt: '2024-01-15T10:01:00.000Z'
    metadata: {}
    hidden: false
---

### User (msg-1)

Hi there

### Assistant (msg-2)

Hello! How can I help?`;

    const conversation = fromMarkdown(markdown);
    expect(getOrderedMessages(conversation)).toHaveLength(2);
    expect(getOrderedMessages(conversation)[0]!.role).toBe('user');
    expect(getOrderedMessages(conversation)[1]!.role).toBe('assistant');
  });

  test('parses multi-modal content from metadata', () => {
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
    content:
      - type: text
        text: 'Check this:'
      - type: image
        source:
          kind: remote-url
          url: 'https://example.com/img.png'
        mimeType: image/png
---

### User (msg-1)

Check this:

![image](https://example.com/img.png)`;

    const conversation = fromMarkdown(markdown);
    const content = getOrderedMessages(conversation)[0]!.content;
    if (!Array.isArray(content)) throw new Error('Expected multimodal content');
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(2);
    expect(content[0]!.type).toBe('text');
    expect(content[1]!.type).toBe('image');
    if (content[1]?.type !== 'image') throw new Error('Expected image content');
    expect(content[1].mimeType).toBe('image/png');
  });

  test('parses toolCall metadata', () => {
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
    toolCall:
      id: call-1
      name: search
      arguments:
        query: test
---

### Tool Call (msg-1)

Calling search`;

    const conversation = fromMarkdown(markdown);
    expect(getOrderedMessages(conversation)[0]!.toolCall).toBeDefined();
    expect(getOrderedMessages(conversation)[0]!.toolCall?.id).toBe('call-1');
    expect(getOrderedMessages(conversation)[0]!.toolCall?.name).toBe('search');
    expect(getOrderedMessages(conversation)[0]!.toolCall?.arguments).toEqual({
      query: 'test',
    });
  });

  test('drops malformed legacy toolCall metadata', () => {
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
    toolCall:
      id: call-1
      args:
        query: test
  msg-2:
    position: 1
    createdAt: '2024-01-15T10:01:00.000Z'
    metadata: {}
    hidden: false
    toolCall: invalid
---

### Tool Call (msg-1)

Calling search

### Tool Call (msg-2)

Calling invalid`;

    const conversation = fromMarkdown(markdown);
    const ordered = getOrderedMessages(conversation);
    expect(ordered[0]?.toolCall).toBeUndefined();
    expect(ordered[1]?.toolCall).toBeUndefined();
  });

  test('parses toolResult metadata', () => {
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
    toolCall:
      id: call-1
      name: search
      arguments: {}
  msg-2:
    position: 1
    createdAt: '2024-01-15T10:00:00.000Z'
    metadata: {}
    hidden: false
    toolResult:
      callId: call-1
      outcome: success
      content: Found it
---

### Tool Call (msg-1)

Calling search

### Tool Result (msg-2)

Search results`;

    const conversation = fromMarkdown(markdown);
    const ordered = getOrderedMessages(conversation);
    expect(ordered[1]?.toolResult).toBeDefined();
    expect(ordered[1]?.toolResult?.callId).toBe('call-1');
    expect(ordered[1]?.toolResult?.outcome).toBe('success');
  });

  test('drops malformed legacy toolResult metadata', () => {
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
    toolCall:
      id: call-1
      name: search
      arguments: {}
  msg-2:
    position: 1
    createdAt: '2024-01-15T10:01:00.000Z'
    metadata: {}
    hidden: false
    toolResult:
      callId: call-1
      outcome: success
      result:
        ok: true
  msg-3:
    position: 2
    createdAt: '2024-01-15T10:02:00.000Z'
    metadata: {}
    hidden: false
    toolResult: invalid
  msg-4:
    position: 3
    createdAt: '2024-01-15T10:03:00.000Z'
    metadata: {}
    hidden: false
    toolResult:
      callId: call-1
      outcome: pending
      content: nope
---

### Tool Call (msg-1)

Calling search

### Tool Result (msg-2)

Search results

### Tool Result (msg-3)

String metadata

### Tool Result (msg-4)

Bad results`;

    const conversation = fromMarkdown(markdown);
    const ordered = getOrderedMessages(conversation);
    expect(ordered[1]?.toolResult).toEqual({
      callId: 'call-1',
      outcome: 'success',
      content: { ok: true },
    });
    expect(ordered[2]?.toolResult).toBeUndefined();
    expect(ordered[3]?.toolResult).toBeUndefined();
  });
});
