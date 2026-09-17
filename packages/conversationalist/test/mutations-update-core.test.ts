import { describe, expect, it } from 'bun:test';

import {
  appendMessages,
  appendUserMessage,
  createConversationHistory,
  removeMessage,
  setMessageHidden,
  updateMessage,
  validateConversationHistoryIntegrity,
} from '../src/conversation';
import { ConversationalistError } from '../src/errors';
import { redactPii } from '../src/plugins/pii-redaction';
import type { ConversationHistory, Message, MessagePlugin } from '../src/types';

const environment = {
  now: () => '2026-08-18T12:00:00.000Z',
  randomId: (() => {
    let nextId = 0;
    return () => `message-${++nextId}`;
  })(),
};

const expectValid = (history: ConversationHistory): void => {
  expect(validateConversationHistoryIntegrity(history)).toEqual([]);
};

const getGoalCompleted = (message: Message | undefined): boolean | undefined => {
  if (!message || message.role !== 'assistant') throw new Error('Expected an assistant message');
  return 'goalCompleted' in message && typeof message.goalCompleted === 'boolean'
    ? message.goalCompleted
    : undefined;
};

const prefixContent: MessagePlugin = (input) => ({
  ...input,
  content: typeof input.content === 'string' ? `processed:${input.content}` : input.content,
});
const prefixTextBlocks: MessagePlugin = (input) => ({
  ...input,
  content:
    typeof input.content === 'string'
      ? input.content
      : input.content.map((part) =>
          part.type === 'text' ? { ...part, text: `processed:${part.text}` } : part,
        ),
});
const toggleVisibility: MessagePlugin = (input) => ({
  ...input,
  hidden: !input.hidden,
});
const processEditedContentTwice: MessagePlugin = (input) => ({
  ...input,
  content:
    input.content === 'Edited'
      ? 'processed:Edited'
      : input.content === 'processed:Edited'
        ? 'final:Edited'
        : input.content,
});

describe('core', () => {
  it('updates editable message fields while preserving identity and the input history', () => {
    let history = createConversationHistory({}, environment);
    history = appendMessages(
      history,
      {
        role: 'assistant',
        content: 'Original',
        metadata: { source: 'seed' },
        goalCompleted: true,
      },
      environment,
    );
    const messageId = history.ids[0]!;
    const originalMessage = history.messages[messageId];
    if (!originalMessage || originalMessage.role !== 'assistant') {
      throw new Error('Expected an assistant message');
    }
    const originalSnapshot = structuredClone(history);
    const updates = {
      content: [{ type: 'text' as const, text: 'Updated' }],
      metadata: { source: 'edit', nested: { status: 'active' } },
      tokenUsage: { prompt: 1, completion: 2, total: 3 },
      cacheBoundary: true,
    };

    const updated = updateMessage(history, messageId, updates, environment);

    expect(updated).not.toBe(history);
    expect(updated.messages[messageId]!).toMatchObject({
      id: originalMessage.id,
      role: 'assistant',
      content: [{ type: 'text', text: 'Updated' }],
      position: originalMessage.position,
      createdAt: originalMessage.createdAt,
      metadata: { source: 'edit', nested: { status: 'active' } },
      tokenUsage: { prompt: 1, completion: 2, total: 3 },
      cacheBoundary: true,
    });
    expect(getGoalCompleted(updated.messages[messageId])).toBeTrue();
    expect(updated.updatedAt).toBe(environment.now());
    expect(history).toEqual(originalSnapshot);
    expect(history.messages[messageId]!).toBe(originalMessage);
    const updatedNestedMetadata = updated.messages[messageId]?.metadata['nested'];
    expect(updatedNestedMetadata).not.toBe(updates.metadata.nested);
    expectValid(updated);
  });

  it('returns the original history when updating an unknown message', () => {
    const history = createConversationHistory({}, environment);

    expect(updateMessage(history, 'missing', { content: 'No change' }, environment)).toBe(history);
  });

  it('clears optional message fields when they are explicitly undefined', () => {
    let history = createConversationHistory({}, environment);
    history = appendMessages(
      history,
      {
        role: 'user',
        content: 'Clear fields',
        tokenUsage: { prompt: 1, completion: 2, total: 3 },
        cacheBoundary: true,
      },
      environment,
    );
    const messageId = history.ids[0]!;

    const updated = updateMessage(
      history,
      messageId,
      { tokenUsage: undefined, cacheBoundary: undefined },
      environment,
    );

    expect(updated.messages[messageId]?.tokenUsage).toBeUndefined();
    expect(updated.messages[messageId]?.cacheBoundary).toBeUndefined();
    expect(history.messages[messageId]?.tokenUsage).toEqual({ prompt: 1, completion: 2, total: 3 });
    expect(history.messages[messageId]?.cacheBoundary).toBeTrue();
    expectValid(updated);
  });

  it('treats inherited object keys as unknown message identifiers', () => {
    const history = createConversationHistory({}, environment);

    expect(updateMessage(history, 'constructor', { content: 'No change' }, environment)).toBe(
      history,
    );
    expect(removeMessage(history, 'toString', environment)).toBe(history);
    expect(setMessageHidden(history, '__proto__', true, environment)).toBe(history);
  });

  it('runs message plugins over updated content', () => {
    const pluginEnvironment = { ...environment, plugins: [redactPii] };
    let history = createConversationHistory({}, pluginEnvironment);
    history = appendUserMessage(history, 'Original', undefined, pluginEnvironment);
    const messageId = history.ids[0]!;

    const updated = updateMessage(
      history,
      messageId,
      { content: 'Contact user@example.com' },
      pluginEnvironment,
    );

    expect(updated.messages[messageId]?.content).toBe('Contact [EMAIL_REDACTED]');
    expect(history.messages[messageId]?.content).toBe('Original');
    expectValid(updated);
  });

  it('rejects non-idempotent string transformations', () => {
    const pluginEnvironment = { ...environment, plugins: [prefixContent] };
    let history = createConversationHistory({}, pluginEnvironment);
    history = appendUserMessage(history, 'Original', undefined, pluginEnvironment);
    const messageId = history.ids[0]!;
    const originalSnapshot = structuredClone(history);

    expect(() => setMessageHidden(history, messageId, true, pluginEnvironment)).toThrow(
      ConversationalistError,
    );
    expect(history.messages[messageId]?.content).toBe('processed:Original');
    expect(history).toEqual(originalSnapshot);
    expectValid(history);
  });

  it('rejects non-idempotent multimodal transformations', () => {
    const pluginEnvironment = { ...environment, plugins: [prefixTextBlocks] };
    let history = createConversationHistory({}, pluginEnvironment);
    history = appendUserMessage(
      history,
      [{ type: 'text', text: 'Original' }],
      undefined,
      pluginEnvironment,
    );
    const messageId = history.ids[0]!;
    const originalContent = history.messages[messageId]?.content;
    const originalSnapshot = structuredClone(history);

    expect(() => setMessageHidden(history, messageId, true, pluginEnvironment)).toThrow(
      ConversationalistError,
    );
    expect(originalContent).toEqual([{ type: 'text', text: 'processed:Original' }]);
    expect(history).toEqual(originalSnapshot);
    expectValid(history);
  });

  it('rejects non-idempotent visibility plugins during a content update', () => {
    const pluginEnvironment = { ...environment, plugins: [toggleVisibility] };
    let history = createConversationHistory({}, pluginEnvironment);
    history = appendUserMessage(history, 'Original', undefined, pluginEnvironment);
    const messageId = history.ids[0]!;
    const originalSnapshot = structuredClone(history);

    expect(() =>
      updateMessage(history, messageId, { content: 'Edited' }, pluginEnvironment),
    ).toThrow(ConversationalistError);
    expect(history).toEqual(originalSnapshot);
    expectValid(history);
  });

  it('rejects non-idempotent plugin output conditional on the updated input', () => {
    const pluginEnvironment = { ...environment, plugins: [processEditedContentTwice] };
    let history = createConversationHistory({}, pluginEnvironment);
    history = appendUserMessage(history, 'Original', undefined, pluginEnvironment);
    const messageId = history.ids[0]!;
    const originalSnapshot = structuredClone(history);

    expect(() =>
      updateMessage(history, messageId, { content: 'Edited' }, pluginEnvironment),
    ).toThrow(ConversationalistError);
    expect(history).toEqual(originalSnapshot);
    expectValid(history);
  });
});
