import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { describe, expect, test } from 'bun:test';

import { fromMarkdown, MarkdownParseError } from '../../src';
import type { ConversationHistory, Message } from '../../src/types';

const getOrderedMessages = (conversation: ConversationHistory): Message[] =>
  conversation.ids
    .map((id) => conversation.messages[id])
    .filter((message): message is Message => Boolean(message));

describe('fromMarkdown simple markdown', () => {
  test('parses empty markdown to empty conversation', () => {
    const conversation = fromMarkdown('');
    expect(getOrderedMessages(conversation)).toHaveLength(0);
    expect(conversation.status).toBe('active');
    expect(conversation.metadata).toEqual({});
  });

  test('parses simple message without frontmatter', () => {
    const markdown = `### User

Hello, world!`;

    const conversation = fromMarkdown(markdown);
    expect(getOrderedMessages(conversation)).toHaveLength(1);
    expect(getOrderedMessages(conversation)[0]!.role).toBe('user');
    expect(getOrderedMessages(conversation)[0]!.content).toBe('Hello, world!');
    expect(getOrderedMessages(conversation)[0]!.hidden).toBe(false);
    expect(getOrderedMessages(conversation)[0]!.metadata).toEqual({});
  });

  test('generates unique IDs for conversation and messages', () => {
    const markdown = `### User

Hello`;

    const conv1 = fromMarkdown(markdown);
    const conv2 = fromMarkdown(markdown);

    expect(conv1.id).toBeTruthy();
    expect(conv2.id).toBeTruthy();
    expect(conv1.id).not.toBe(conv2.id);
    expect(getOrderedMessages(conv1)[0]!.id).not.toBe(getOrderedMessages(conv2)[0]!.id);
  });

  test('a manual runtime controls the minted conversation id, message id, and timestamps (AB-325)', async () => {
    const markdown = `### User

Hello`;

    const runtime = createManualRuntimeServices({ identifierSeed: 'markdown-test' });
    await runtime.advance(12_345);
    const expectedRuntime = createManualRuntimeServices({ identifierSeed: 'markdown-test' });
    await expectedRuntime.advance(12_345);

    const conversation = fromMarkdown(markdown, runtime);

    // parseMarkdownSimple mints each message id before the conversation id, in source order.
    const expectedMessageId = expectedRuntime.identifiers.next('conversation');
    const expectedConversationId = expectedRuntime.identifiers.next('conversation');
    const expectedTimestamp = expectedRuntime.clock.nowISO();

    expect(getOrderedMessages(conversation)[0]?.id).toBe(expectedMessageId);
    expect(conversation.id).toBe(expectedConversationId);
    expect(conversation.createdAt).toBe(expectedTimestamp);
    expect(conversation.updatedAt).toBe(expectedTimestamp);
    expect(getOrderedMessages(conversation)[0]?.createdAt).toBe(expectedTimestamp);
  });

  test('assigns positions based on message order', () => {
    const markdown = `### User

First

### Assistant

Second

### User

Third`;

    const conversation = fromMarkdown(markdown);
    expect(getOrderedMessages(conversation)[0]!.position).toBe(0);
    expect(getOrderedMessages(conversation)[1]!.position).toBe(1);
    expect(getOrderedMessages(conversation)[2]!.position).toBe(2);
  });

  test('parses all role types correctly', () => {
    const markdown = `### User

U

### Assistant

A

### System

S

### Developer

D

### Tool Call

TU

### Tool Result

TR

### Snapshot

SN`;

    const conversation = fromMarkdown(markdown);
    expect(getOrderedMessages(conversation)[0]!.role).toBe('user');
    expect(getOrderedMessages(conversation)[1]!.role).toBe('assistant');
    expect(getOrderedMessages(conversation)[2]!.role).toBe('system');
    expect(getOrderedMessages(conversation)[3]!.role).toBe('developer');
    expect(getOrderedMessages(conversation)[4]!.role).toBe('tool-call');
    expect(getOrderedMessages(conversation)[5]!.role).toBe('tool-result');
    expect(getOrderedMessages(conversation)[6]!.role).toBe('snapshot');
  });

  test('throws MarkdownParseError for unknown role', () => {
    const markdown = `### Unknown Role

Content`;

    expect(() => fromMarkdown(markdown)).toThrow(MarkdownParseError);
    expect(() => fromMarkdown(markdown)).toThrow('Unknown role');
  });
});
