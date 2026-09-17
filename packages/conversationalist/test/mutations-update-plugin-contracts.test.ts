import { describe, expect, it } from 'bun:test';

import {
  appendMessages,
  appendUserMessage,
  createConversationHistory,
  setMessageHidden,
  updateMessage,
  validateConversationHistoryIntegrity,
} from '../src/conversation';
import { ConversationalistError } from '../src/errors';
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

const hideBlockedContent: MessagePlugin = (input) => ({
  ...input,
  hidden: input.content === 'Blocked' ? true : input.hidden,
});
const prefixAndHideBlockedContent: MessagePlugin = (input) => ({
  ...input,
  content:
    typeof input.content === 'string' && !input.content.startsWith('processed:')
      ? `processed:${input.content}`
      : input.content,
  hidden: input.content === 'Allowed' ? input.hidden : true,
});
const markProcessedAndHideBlockedContent: MessagePlugin = (input) => ({
  ...input,
  metadata: { ...input.metadata, processed: true },
  hidden: input.metadata?.['processed'] === true || input.content === 'Blocked',
});
const clearBlockedToolArguments: MessagePlugin = (input) => ({
  ...input,
  toolCall:
    input.content === 'Blocked' && input.toolCall
      ? { ...input.toolCall, arguments: {} }
      : input.toolCall,
});
const retargetBlockedToolCall: MessagePlugin = (input) => ({
  ...input,
  toolCall:
    input.content === 'Blocked' && input.toolCall
      ? { ...input.toolCall, id: 'call-2' }
      : input.toolCall,
});
const hideBlockedCompletedAssistant: MessagePlugin = (input) => ({
  ...input,
  hidden:
    input.role === 'assistant' && input.goalCompleted && input.content === 'Blocked'
      ? true
      : input.hidden,
});

describe('plugin-contracts', () => {
  it('preserves cross-field plugin transformations caused by an update', () => {
    const pluginEnvironment = { ...environment, plugins: [hideBlockedContent] };
    let history = createConversationHistory({}, pluginEnvironment);
    history = appendUserMessage(history, 'Allowed', undefined, pluginEnvironment);
    const messageId = history.ids[0]!;

    const updated = updateMessage(history, messageId, { content: 'Blocked' }, pluginEnvironment);

    expect(history.messages[messageId]?.hidden).toBeFalse();
    expect(updated.messages[messageId]?.content).toBe('Blocked');
    expect(updated.messages[messageId]?.hidden).toBeTrue();
    expectValid(updated);
  });

  it('preserves cross-field changes when plugins transform stored input again', () => {
    const pluginEnvironment = { ...environment, plugins: [prefixAndHideBlockedContent] };
    let history = createConversationHistory({}, pluginEnvironment);
    history = appendUserMessage(history, 'Allowed', undefined, pluginEnvironment);
    const messageId = history.ids[0]!;

    const updated = updateMessage(history, messageId, { content: 'Blocked' }, pluginEnvironment);

    expect(history.messages[messageId]?.content).toBe('processed:Allowed');
    expect(history.messages[messageId]?.hidden).toBeFalse();
    expect(updated.messages[messageId]?.content).toBe('processed:Blocked');
    expect(updated.messages[messageId]?.hidden).toBeTrue();
    expectValid(updated);
  });

  it('preserves plugin visibility when a stored marker masks the edited field', () => {
    const pluginEnvironment = { ...environment, plugins: [markProcessedAndHideBlockedContent] };
    let history = createConversationHistory({}, pluginEnvironment);
    history = appendUserMessage(history, 'Allowed', undefined, pluginEnvironment);
    const messageId = history.ids[0]!;

    const updated = updateMessage(history, messageId, { content: 'Blocked' }, pluginEnvironment);

    expect(history.messages[messageId]?.metadata).toEqual({ processed: true });
    expect(history.messages[messageId]?.hidden).toBeFalse();
    expect(updated.messages[messageId]?.content).toBe('Blocked');
    expect(updated.messages[messageId]?.hidden).toBeTrue();
    expectValid(updated);
  });

  it('preserves cross-field plugin transformations to a tool-call payload', () => {
    const pluginEnvironment = { ...environment, plugins: [clearBlockedToolArguments] };
    let history = createConversationHistory({}, pluginEnvironment);
    history = appendMessages(
      history,
      {
        role: 'tool-call',
        content: 'Allowed',
        toolCall: { id: 'call-1', name: 'lookup', arguments: { secret: 'value' } },
      },
      pluginEnvironment,
    );
    const messageId = history.ids[0]!;

    const updated = updateMessage(history, messageId, { content: 'Blocked' }, pluginEnvironment);

    expect(history.messages[messageId]?.toolCall?.arguments).toEqual({ secret: 'value' });
    expect(updated.messages[messageId]?.toolCall).toEqual({
      id: 'call-1',
      name: 'lookup',
      arguments: {},
    });
    expectValid(updated);
  });

  it('rejects a plugin that retargets a tool call during an update', () => {
    let history = createConversationHistory({}, environment);
    history = appendMessages(
      history,
      {
        role: 'tool-call',
        content: 'Allowed',
        toolCall: { id: 'call-1', name: 'lookup', arguments: {} },
      },
      environment,
    );
    const messageId = history.ids[0]!;
    const originalSnapshot = structuredClone(history);

    expect(() =>
      updateMessage(
        history,
        messageId,
        { content: 'Blocked' },
        {
          ...environment,
          plugins: [retargetBlockedToolCall],
        },
      ),
    ).toThrow(ConversationalistError);
    expect(history).toEqual(originalSnapshot);
    expectValid(history);
  });

  it('includes preserved assistant completion state in plugin inputs', () => {
    const pluginEnvironment = { ...environment, plugins: [hideBlockedCompletedAssistant] };
    let history = createConversationHistory({}, pluginEnvironment);
    history = appendMessages(
      history,
      { role: 'assistant', content: 'Allowed', goalCompleted: true },
      pluginEnvironment,
    );
    const messageId = history.ids[0]!;

    const updated = updateMessage(history, messageId, { content: 'Blocked' }, pluginEnvironment);

    expect(updated.messages[messageId]?.hidden).toBeTrue();
    expect(getGoalCompleted(updated.messages[messageId])).toBeTrue();
    expectValid(updated);
  });

  it('rejects nondeterministic message plugins instead of manufacturing mutation deltas', () => {
    let sequence = 0;
    const statefulMetadata: MessagePlugin = (input) => ({
      ...input,
      metadata: { ...input.metadata, sequence: ++sequence },
    });
    let history = createConversationHistory({}, environment);
    history = appendUserMessage(history, 'Original', undefined, environment);
    const messageId = history.ids[0]!;
    const originalSnapshot = structuredClone(history);

    expect(() =>
      setMessageHidden(history, messageId, true, {
        ...environment,
        plugins: [statefulMetadata],
      }),
    ).toThrow(ConversationalistError);
    expect(history).toEqual(originalSnapshot);
    expectValid(history);
  });

  it('rejects nondeterministic plugin output conditional on the updated input', () => {
    let sequence = 0;
    const statefulEditedMetadata: MessagePlugin = (input) => ({
      ...input,
      metadata:
        input.content === 'Edited' ? { ...input.metadata, sequence: ++sequence } : input.metadata,
    });
    let history = createConversationHistory({}, environment);
    history = appendUserMessage(history, 'Original', undefined, environment);
    const messageId = history.ids[0]!;
    const originalSnapshot = structuredClone(history);

    expect(() =>
      updateMessage(
        history,
        messageId,
        { content: 'Edited' },
        {
          ...environment,
          plugins: [statefulEditedMetadata],
        },
      ),
    ).toThrow(ConversationalistError);
    expect(history).toEqual(originalSnapshot);
    expectValid(history);
  });
});
