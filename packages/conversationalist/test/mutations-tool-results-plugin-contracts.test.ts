import { describe, expect, it } from 'bun:test';

import {
  appendMessages,
  createConversationHistory,
  replaceToolResult,
  updateMessage,
  validateConversationHistoryIntegrity,
} from '../src/conversation';
import { ConversationalistError } from '../src/errors';
import type { ConversationHistory, MessagePlugin } from '../src/types';

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

const retargetResult: MessagePlugin = (input) => ({
  ...input,
  toolResult: input.toolResult ? { ...input.toolResult, callId: 'call-2' } : undefined,
});
const retargetEditedResult: MessagePlugin = (input) => ({
  ...input,
  toolResult:
    input.content === 'Edited' && input.toolResult
      ? { ...input.toolResult, callId: 'call-2' }
      : input.toolResult,
});

describe('plugin-contracts', () => {
  it('rejects a replacement whose call identifier does not match the target', () => {
    let history = createConversationHistory({}, environment);
    history = appendMessages(
      history,
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'lookup', arguments: {} },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'action_required', content: null },
      },
      environment,
    );

    expect(() =>
      replaceToolResult(
        history,
        'call-1',
        { callId: 'call-2', outcome: 'success', content: null },
        environment,
      ),
    ).toThrow(ConversationalistError);
    expectValid(history);
  });

  it('rejects retargeting a result to another existing tool call', () => {
    let history = createConversationHistory({}, environment);
    history = appendMessages(
      history,
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'lookup', arguments: {} },
      },
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-2', name: 'lookup', arguments: {} },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'action_required', content: null },
      },
      environment,
    );

    expect(() =>
      replaceToolResult(
        history,
        'call-1',
        { callId: 'call-2', outcome: 'success', content: null },
        environment,
      ),
    ).toThrow(ConversationalistError);
    expectValid(history);
  });

  it('rejects a plugin that retargets a replacement result after processing', () => {
    let history = createConversationHistory({}, environment);
    history = appendMessages(
      history,
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'lookup', arguments: {} },
      },
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-2', name: 'lookup', arguments: {} },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'action_required', content: null },
      },
      environment,
    );
    const originalSnapshot = structuredClone(history);

    expect(() =>
      replaceToolResult(
        history,
        'call-1',
        { callId: 'call-1', outcome: 'success', content: null },
        { ...environment, plugins: [retargetResult] },
      ),
    ).toThrow(ConversationalistError);
    expect(history).toEqual(originalSnapshot);
    expectValid(history);
  });

  it('rejects a plugin that retargets an existing result during a general update', () => {
    let history = createConversationHistory({}, environment);
    history = appendMessages(
      history,
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'lookup', arguments: {} },
      },
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-2', name: 'lookup', arguments: {} },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'action_required', content: null },
      },
      environment,
    );
    const resultMessageId = history.ids[2]!;
    const originalSnapshot = structuredClone(history);

    expect(() =>
      updateMessage(
        history,
        resultMessageId,
        { content: 'Edited' },
        {
          ...environment,
          plugins: [retargetEditedResult],
        },
      ),
    ).toThrow(ConversationalistError);
    expect(history).toEqual(originalSnapshot);
    expectValid(history);
  });

  it('rejects plugin retargeting when the preserved call identifier is empty', () => {
    let history = createConversationHistory({}, environment);
    history = appendMessages(
      history,
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: '', name: 'lookup', arguments: {} },
      },
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-2', name: 'lookup', arguments: {} },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: '', outcome: 'action_required', content: null },
      },
      environment,
    );
    const resultMessageId = history.ids[2]!;
    const originalSnapshot = structuredClone(history);

    expect(() =>
      updateMessage(
        history,
        resultMessageId,
        { content: 'Edited' },
        {
          ...environment,
          plugins: [retargetEditedResult],
        },
      ),
    ).toThrow(ConversationalistError);
    expect(history).toEqual(originalSnapshot);
    expectValid(history);
  });
});
