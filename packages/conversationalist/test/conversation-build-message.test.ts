import { describe, expect, test } from 'bun:test';
import {
  appendMessages,
  appendUserMessage,
  buildMessage,
  createConversationHistory as createConversation,
  prependMessages,
  withEnvironment,
} from '../src/conversation/index';
import { messageSchema } from '../src/schemas';
import { getOrderedMessages } from '../src/utilities/message-store';

describe('buildMessage', () => {
  test('rejects a standalone message that fails schema validation', () => {
    expect(() =>
      Reflect.apply(buildMessage, undefined, [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              name: 'empty-inline-data',
              source: { kind: 'inline', data: '', encoding: 'base64' },
            },
          ],
        },
      ]),
    ).toThrow('message failed schema validation');
  });

  test('mints a standalone, schema-valid Message without a ConversationHistory', () => {
    const message = buildMessage({ role: 'user', content: 'hello' });

    expect(messageSchema.safeParse(message).success).toBeTrue();
    expect(message.role).toBe('user');
    expect(message.content).toBe('hello');
    expect(message.id).toBeTruthy();
    expect(message.createdAt).toBeTruthy();
    expect(message.hidden).toBeFalse();
    expect(message.metadata).toEqual({});
    expect(message.position).toBe(0);
  });

  test('defaults position to 0 and accepts an explicit position via options', () => {
    const withDefault = buildMessage({ role: 'user', content: 'a' });
    const withExplicit = buildMessage({ role: 'user', content: 'b' }, { position: 7 });

    expect(withDefault.position).toBe(0);
    expect(withExplicit.position).toBe(7);
  });

  test('preserves metadata, hidden, and goalCompleted on the minted message', () => {
    const message = buildMessage({
      role: 'assistant',
      content: 'done',
      metadata: { key: 'value' },
      hidden: true,
      goalCompleted: true,
    });

    expect(message.metadata['key']).toBe('value');
    expect(message.hidden).toBeTrue();
    if (message.role !== 'assistant' || !('goalCompleted' in message))
      throw new Error('Expected an assistant message with completion status');
    expect(message.goalCompleted).toBeTrue();
  });

  test('applies the environment for id and timestamp generation', () => {
    const message = buildMessage({ role: 'user', content: 'hello' }, undefined, {
      now: () => '2024-01-01T00:00:00.000Z',
      randomId: () => 'fixed-id',
    });

    expect(message.id).toBe('fixed-id');
    expect(message.createdAt).toBe('2024-01-01T00:00:00.000Z');
  });

  test('applies environment plugins before validating the standalone message', () => {
    const message = buildMessage({ role: 'user', content: 'before plugin' }, undefined, {
      plugins: [(input) => ({ ...input, content: 'after plugin' })],
    });

    expect(message.content).toBe('after plugin');
  });

  test('appendMessages preserves the id and createdAt of a pre-built message', () => {
    const message = buildMessage({ role: 'user', content: 'inbound' }, undefined, {
      now: () => '2024-03-01T00:00:00.000Z',
      randomId: () => 'inbound-id',
    });

    const c = appendMessages(createConversation(), message);
    const stored = getOrderedMessages(c)[0]!;
    if (stored === undefined) throw new Error('expected stored message');

    expect(stored.content).toBe('inbound');
    expect(stored.id).toBe('inbound-id');
    expect(stored.createdAt).toBe('2024-03-01T00:00:00.000Z');
  });

  test('prependMessages preserves the id and createdAt of a pre-built message', () => {
    const message = buildMessage({ role: 'user', content: 'earlier' }, undefined, {
      now: () => '2024-03-01T00:00:00.000Z',
      randomId: () => 'earlier-id',
    });

    let c = createConversation();
    c = appendUserMessage(c, 'existing');
    c = prependMessages(c, message);
    const stored = getOrderedMessages(c)[0]!;
    if (stored === undefined) throw new Error('expected prepended message');

    expect(stored.content).toBe('earlier');
    expect(stored.id).toBe('earlier-id');
    expect(stored.createdAt).toBe('2024-03-01T00:00:00.000Z');
    expect(stored.position).toBe(0);
  });

  test('accepts a bound environment via withEnvironment landing in the options position', () => {
    const boundBuildMessage = withEnvironment(
      { now: () => '2024-04-01T00:00:00.000Z', randomId: () => 'bound-id' },
      buildMessage,
    );

    const message = boundBuildMessage({ role: 'user', content: 'bound' });

    expect(message.id).toBe('bound-id');
    expect(message.createdAt).toBe('2024-04-01T00:00:00.000Z');
  });
});
