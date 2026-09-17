import { describe, expect, test } from 'bun:test';
import {
  appendMessages,
  appendUserMessage,
  createConversationHistory as createConversation,
  prependMessages,
} from '../src/conversation/index';
import { ConversationalistError } from '../src/errors';
import { messageSchema } from '../src/schemas';
import type { ConversationHistory } from '../src/types';
import { getOrderedMessages } from '../src/utilities/message-store';

describe('prependMessages', () => {
  test('puts messages at the front and renumbers existing positions', () => {
    let c = createConversation();
    c = appendMessages(c, { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' });

    c = prependMessages(c, { role: 'system', content: 'sys' });

    const messages = getOrderedMessages(c);
    expect(messages.length).toBe(3);
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toBe('sys');
    expect(messages[0]!.position).toBe(0);
    expect(messages[1]!.role).toBe('user');
    expect(messages[1]!.position).toBe(1);
    expect(messages[2]!.role).toBe('assistant');
    expect(messages[2]!.position).toBe(2);
  });

  test('prepends multiple messages at once, preserving their given order', () => {
    let c = createConversation();
    c = appendMessages(c, { role: 'user', content: 'existing' });

    c = prependMessages(
      c,
      { role: 'system', content: 'older-1' },
      { role: 'system', content: 'older-2' },
    );

    const messages = getOrderedMessages(c);
    expect(messages.length).toBe(3);
    expect(messages[0]!.content).toBe('older-1');
    expect(messages[0]!.position).toBe(0);
    expect(messages[1]!.content).toBe('older-2');
    expect(messages[1]!.position).toBe(1);
    expect(messages[2]!.content).toBe('existing');
    expect(messages[2]!.position).toBe(2);
  });

  test('prepending onto an empty history places messages at the front', () => {
    let c = createConversation();
    c = prependMessages(
      c,
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
    );

    const messages = getOrderedMessages(c);
    expect(messages.length).toBe(2);
    expect(messages[0]!.content).toBe('first');
    expect(messages[0]!.position).toBe(0);
    expect(messages[1]!.content).toBe('second');
    expect(messages[1]!.position).toBe(1);
  });

  test('prepending with no inputs returns an equivalent, still-valid history', () => {
    let c = createConversation();
    c = appendMessages(c, { role: 'user', content: 'u' });

    c = prependMessages(c);

    const messages = getOrderedMessages(c);
    expect(messages.length).toBe(1);
    expect(messages[0]!.position).toBe(0);
  });

  test('preserves goalCompleted on renumbered assistant messages', () => {
    let c = createConversation();
    c = appendMessages(c, { role: 'assistant', content: 'done', goalCompleted: true });
    c = prependMessages(c, { role: 'user', content: 'earlier' });

    const messages = getOrderedMessages(c);
    const assistantMessage = messages.find((m) => m.role === 'assistant');
    if (assistantMessage === undefined || !('goalCompleted' in assistantMessage))
      throw new Error('Expected an assistant message with completion status');
    expect(assistantMessage.goalCompleted).toBeTrue();
  });

  test('round-trips through schema validation with agreeing ids and positions', () => {
    let c = createConversation();
    c = appendMessages(c, { role: 'user', content: 'u' }, { role: 'assistant', content: 'a' });
    c = prependMessages(c, { role: 'system', content: 's1' }, { role: 'system', content: 's2' });

    expect(messageSchema.safeParse(c.messages[c.ids[0]!]).success).toBeTrue();

    // ids and positions agree: ids[i] maps to a message whose position is i.
    c.ids.forEach((id, index) => {
      expect(c.messages[id]!.position).toBe(index);
    });
  });

  test('preserves immutability — the original conversation is unchanged', () => {
    const c1 = createConversation();
    const c2 = appendUserMessage(c1, 'u');
    const c3 = prependMessages(c2, { role: 'system', content: 's' });

    expect(getOrderedMessages(c2).length).toBe(1);
    expect(getOrderedMessages(c3).length).toBe(2);
    expect(getOrderedMessages(c2)[0]!.position).toBe(0);
  });

  test('rejects a tool-result prepended ahead of its tool-call', () => {
    let c = createConversation();
    c = appendMessages(c, {
      role: 'tool-call',
      content: '',
      toolCall: { id: 'call-1', name: 'search', arguments: {} },
    });

    let caught: unknown;
    try {
      prependMessages(c, {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'success', content: {} },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConversationalistError);
  });

  test('surfaces a pre-existing missing-message integrity violation instead of silently dropping it', () => {
    let c = createConversation();
    c = appendUserMessage(c, 'u');
    // Simulate a malformed conversation: an id listed with no backing message.
    const malformed: ConversationHistory = { ...c, ids: [...c.ids, 'dangling-id'] };

    let caught: unknown;
    try {
      prependMessages(malformed, { role: 'system', content: 's' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConversationalistError);
  });

  test('renumbers existing messages densely from their ordered index, not stale position + offset', () => {
    let c = createConversation();
    c = appendMessages(c, { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' });

    // Simulate a conversation whose existing positions are already sparse
    // (e.g. from an external source) — 52 and 53 rather than 0 and 1.
    const [firstId, secondId] = c.ids;
    if (firstId === undefined || secondId === undefined)
      throw new Error('expected message identifiers');
    const sparse: ConversationHistory = {
      ...c,
      messages: {
        ...c.messages,
        [firstId]: { ...c.messages[firstId]!, position: 52 },
        [secondId]: { ...c.messages[secondId]!, position: 53 },
      },
    };

    const result = prependMessages(sparse, { role: 'system', content: 'new' });
    const messages = getOrderedMessages(result);

    // The full resulting sequence must be dense (0, 1, 2, ...), not carrying
    // the stale 52/53 gap forward from the offset-based renumbering.
    expect(messages.map((m) => m.position)).toEqual([0, 1, 2]);
    expect(messages[0]!.content).toBe('new');
    expect(messages[1]!.content).toBe('u1');
    expect(messages[2]!.content).toBe('a1');
  });
});
