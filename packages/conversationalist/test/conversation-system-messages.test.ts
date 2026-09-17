import { describe, expect, test } from 'bun:test';
import {
  appendMessages,
  appendSystemMessage,
  appendUserMessage,
  collapseSystemMessages,
  createConversationHistory as createConversation,
  getFirstSystemMessage,
  getSystemMessages,
  hasSystemMessage,
  prependSystemMessage,
  replaceSystemMessage,
} from '../src/conversation/index';
import { getOrderedMessages } from '../src/utilities/message-store';

describe('system message management', () => {
  test('hasSystemMessage returns true when system message exists', () => {
    let c = createConversation();
    expect(hasSystemMessage(c)).toBeFalse();

    c = appendSystemMessage(c, 'system prompt');
    expect(hasSystemMessage(c)).toBeTrue();
  });

  test('hasSystemMessage includes hidden system messages', () => {
    let c = createConversation();
    c = appendMessages(c, { role: 'system', content: 'hidden', hidden: true });
    expect(hasSystemMessage(c)).toBeTrue();
  });

  test('getFirstSystemMessage returns first system message', () => {
    let c = createConversation();
    expect(getFirstSystemMessage(c)).toBeUndefined();

    c = appendMessages(
      c,
      { role: 'user', content: 'u' },
      { role: 'system', content: 's1' },
      { role: 'system', content: 's2' },
    );

    const first = getFirstSystemMessage(c);
    expect(first).toBeDefined();
    expect(first!.content).toBe('s1');
    expect(first!.position).toBe(1);
  });

  test('getFirstSystemMessage includes hidden messages', () => {
    let c = createConversation();
    c = appendMessages(c, { role: 'system', content: 'hidden', hidden: true });

    const first = getFirstSystemMessage(c);
    expect(first).toBeDefined();
    expect(first!.hidden).toBeTrue();
  });

  test('getSystemMessages returns all system messages', () => {
    let c = createConversation();
    expect(getSystemMessages(c).length).toBe(0);

    c = appendMessages(
      c,
      { role: 'user', content: 'u' },
      { role: 'system', content: 's1' },
      { role: 'assistant', content: 'a' },
      { role: 'system', content: 's2' },
      { role: 'system', content: 's3', hidden: true },
    );

    const systemMsgs = getSystemMessages(c);
    expect(systemMsgs.length).toBe(3);
    expect(systemMsgs[0]!.content).toBe('s1');
    expect(systemMsgs[1]!.content).toBe('s2');
    expect(systemMsgs[2]!.content).toBe('s3');
    expect(systemMsgs[2]!.hidden).toBeTrue();
  });

  test('prependSystemMessage adds message at position 0', () => {
    let c = createConversation();
    c = appendMessages(c, { role: 'user', content: 'u' }, { role: 'assistant', content: 'a' });

    c = prependSystemMessage(c, 'system prompt', { key: 'value' });

    const messages = getOrderedMessages(c);
    expect(messages.length).toBe(3);
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toBe('system prompt');
    expect(messages[0]!.position).toBe(0);
    expect(messages[0]!.metadata['key']).toBe('value');

    // Check positions were renumbered
    expect(messages[1]!.role).toBe('user');
    expect(messages[1]!.position).toBe(1);
    expect(messages[2]!.role).toBe('assistant');
    expect(messages[2]!.position).toBe(2);
  });

  test('prependSystemMessage to empty conversation', () => {
    let c = createConversation();
    c = prependSystemMessage(c, 'first');

    const messages = getOrderedMessages(c);
    expect(messages.length).toBe(1);
    expect(messages[0]!.content).toBe('first');
    expect(messages[0]!.position).toBe(0);
  });

  test('prependSystemMessage preserves immutability', () => {
    const c1 = createConversation();
    const c2 = appendUserMessage(c1, 'u');
    const c3 = prependSystemMessage(c2, 's');

    const c2Messages = getOrderedMessages(c2);
    const c3Messages = getOrderedMessages(c3);
    expect(c2Messages.length).toBe(1);
    expect(c3Messages.length).toBe(2);
    expect(c2Messages[0]!.position).toBe(0);
    expect(c3Messages[0]!.role).toBe('system');
  });

  test('prependSystemMessage preserves goalCompleted on renumbered assistant messages', () => {
    let c = createConversation();
    c = appendMessages(c, { role: 'assistant', content: 'done', goalCompleted: true });
    c = prependSystemMessage(c, 'system prompt');

    const messages = getOrderedMessages(c);
    const assistantMessage = messages.find((m) => m.role === 'assistant');
    expect(assistantMessage).toBeDefined();
    if (assistantMessage === undefined || !('goalCompleted' in assistantMessage))
      throw new Error('Expected an assistant message with completion status');
    expect(assistantMessage.goalCompleted).toBeTrue();
  });

  test('replaceSystemMessage replaces first system message', () => {
    let c = createConversation();
    c = appendMessages(
      c,
      { role: 'system', content: 'old', metadata: { v: 1 } },
      { role: 'user', content: 'u' },
      { role: 'system', content: 'another' },
    );

    const originalId = getOrderedMessages(c)[0]!.id;
    c = replaceSystemMessage(c, 'new system prompt', { v: 2 });

    const messages = getOrderedMessages(c);
    expect(messages.length).toBe(3);
    expect(messages[0]!.id).toBe(originalId);
    expect(messages[0]!.content).toBe('new system prompt');
    expect(messages[0]!.metadata['v']).toBe(2);
    expect(messages[2]!.content).toBe('another'); // Second system message unchanged
  });

  test('replaceSystemMessage preserves original metadata when not provided', () => {
    let c = createConversation();
    c = appendSystemMessage(c, 'old', { foo: 'bar', num: 42 });

    c = replaceSystemMessage(c, 'new');

    const messages = getOrderedMessages(c);
    expect(messages[0]!.content).toBe('new');
    expect(messages[0]!.metadata['foo']).toBe('bar');
    expect(messages[0]!.metadata['num']).toBe(42);
  });

  test('replaceSystemMessage prepends when no system message exists', () => {
    let c = createConversation();
    c = appendMessages(c, { role: 'user', content: 'u' }, { role: 'assistant', content: 'a' });

    c = replaceSystemMessage(c, 'new system', { k: 'v' });

    const messages = getOrderedMessages(c);
    expect(messages.length).toBe(3);
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toBe('new system');
    expect(messages[0]!.position).toBe(0);
    expect(messages[1]!.position).toBe(1);
    expect(messages[2]!.position).toBe(2);
  });

  test('collapseSystemMessages with no system messages returns same conversation', () => {
    let c = createConversation();
    c = appendMessages(c, { role: 'user', content: 'u' }, { role: 'assistant', content: 'a' });

    const collapsed = collapseSystemMessages(c);
    expect(collapsed).toBe(c); // Should be same reference if no changes
  });

  test('collapseSystemMessages with one system message returns same conversation', () => {
    let c = createConversation();
    c = appendMessages(c, { role: 'system', content: 's' }, { role: 'user', content: 'u' });

    const collapsed = collapseSystemMessages(c);
    expect(collapsed).toBe(c);
  });

  test('collapseSystemMessages combines multiple system messages', () => {
    let c = createConversation();
    c = appendMessages(
      c,
      { role: 'system', content: 'first' },
      { role: 'user', content: 'u1' },
      { role: 'system', content: 'second' },
      { role: 'assistant', content: 'a' },
      { role: 'system', content: 'third' },
    );

    c = collapseSystemMessages(c);

    const messages = getOrderedMessages(c);
    expect(messages.length).toBe(3); // 1 system + user + assistant
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toBe('first\nsecond\nthird');
    expect(messages[1]!.role).toBe('user');
    expect(messages[2]!.role).toBe('assistant');

    // Check positions are renumbered
    expect(messages[0]!.position).toBe(0);
    expect(messages[1]!.position).toBe(1);
    expect(messages[2]!.position).toBe(2);
  });

  test('collapseSystemMessages deduplicates exact content', () => {
    let c = createConversation();
    c = appendMessages(
      c,
      { role: 'system', content: 'same' },
      { role: 'system', content: 'different' },
      { role: 'system', content: 'same' },
      { role: 'system', content: 'another' },
    );

    c = collapseSystemMessages(c);

    const messages = getOrderedMessages(c);
    expect(messages.length).toBe(1);
    expect(messages[0]!.content).toBe('same\ndifferent\nanother');
  });

  test('collapseSystemMessages includes hidden messages', () => {
    let c = createConversation();
    c = appendMessages(
      c,
      { role: 'system', content: 'visible' },
      { role: 'system', content: 'hidden', hidden: true },
      { role: 'user', content: 'u' },
    );

    c = collapseSystemMessages(c);

    const messages = getOrderedMessages(c);
    expect(messages.length).toBe(2);
    expect(messages[0]!.content).toBe('visible\nhidden');
  });

  test('collapseSystemMessages flattens multi-modal content to text', () => {
    let c = createConversation();
    c = appendMessages(
      c,
      {
        role: 'system',
        content: [
          { type: 'text', text: 'Rules:' },
          { type: 'image', url: 'https://example.com/image.png', text: 'diagram' },
        ],
      },
      { role: 'system', content: 'Second' },
    );

    c = collapseSystemMessages(c);

    expect(getOrderedMessages(c)[0]!.content).toBe('Rules:\nSecond');
  });

  test('collapseSystemMessages preserves first system message properties', () => {
    let c = createConversation();
    c = appendMessages(
      c,
      { role: 'system', content: 'first', metadata: { key: 'value' }, hidden: true },
      { role: 'system', content: 'second' },
      { role: 'user', content: 'u' },
    );

    const originalId = getOrderedMessages(c)[0]!.id;
    const originalCreatedAt = getOrderedMessages(c)[0]!.createdAt;

    c = collapseSystemMessages(c);

    const messages = getOrderedMessages(c);
    expect(messages[0]!.id).toBe(originalId);
    expect(messages[0]!.createdAt).toBe(originalCreatedAt);
    expect(messages[0]!.metadata['key']).toBe('value');
    expect(messages[0]!.hidden).toBeTrue();
  });

  test('collapseSystemMessages handles empty content correctly', () => {
    let c = createConversation();
    c = appendMessages(
      c,
      { role: 'system', content: 'first' },
      { role: 'system', content: '' },
      { role: 'system', content: 'second' },
    );

    c = collapseSystemMessages(c);

    // Empty content should be filtered out
    expect(getOrderedMessages(c)[0]!.content).toBe('first\nsecond');
  });

  test('mutation operations return new conversation instances', () => {
    const c1 = createConversation();
    const c2 = prependSystemMessage(c1, 'test');
    const c3 = replaceSystemMessage(c2, 'replaced');
    const c4 = appendSystemMessage(c3, 'another');
    const c5 = collapseSystemMessages(c4);

    // Verify immutability - each operation returns a new instance
    expect(c2).not.toBe(c1);
    expect(c3).not.toBe(c2);
    expect(c4).not.toBe(c3);
    expect(c5).not.toBe(c4);

    // Verify updatedAt is set and valid
    expect(c2.updatedAt).toBeDefined();
    expect(c3.updatedAt).toBeDefined();
    expect(c5.updatedAt).toBeDefined();
    expect(new Date(c2.updatedAt).toISOString()).toBe(c2.updatedAt);
  });
});
