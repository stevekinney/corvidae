import { describe, expect, it } from 'bun:test';

import {
  appendMessages,
  appendStreamingMessage,
  appendToolCall,
  appendToolCalls,
  appendToolResults,
  appendToolResultsAsync,
  Conversation,
  createConversationHistory as createConversation,
  defineMessagePlugin,
  withMessageId,
} from '../src';
import type { MessageInput } from '../src/types';
import { getOrderedMessages } from '../src/utilities/message-store';

const environment = {
  now: () => '2024-01-01T00:00:00.000Z',
  randomId: (() => {
    let counter = 0;
    return () => `minted-${++counter}`;
  })(),
};

const toolCall = (id: string) => ({ id, name: 'lookup', arguments: { id } });
const toolResult = (callId: string) => ({
  callId,
  outcome: 'success' as const,
  content: 'done',
  result: 'done',
});

describe('caller-chosen row ids', () => {
  it('keeps the id of a raw input and still runs conversation plugins over it', () => {
    const upcase = defineMessagePlugin(
      { id: 'upcase', revision: 1 },
      (input: MessageInput): MessageInput => ({
        ...input,
        content: typeof input.content === 'string' ? input.content.toUpperCase() : input.content,
      }),
    );
    const withPlugin = { ...environment, plugins: [upcase] };
    const input = withMessageId({ role: 'assistant', content: 'hello' }, 'chosen-id');

    const conversation = appendMessages(createConversation({}, withPlugin), input, withPlugin);

    const [message] = getOrderedMessages(conversation);
    expect(message?.id).toBe('chosen-id');
    expect(message?.content).toBe('HELLO');
  });

  it('keeps the id when a plugin returns an input without it', () => {
    const forgetful = defineMessagePlugin(
      { id: 'forgetful', revision: 1 },
      (input: MessageInput): MessageInput => ({ role: input.role, content: input.content }),
    );
    const withPlugin = { ...environment, plugins: [forgetful] };

    const conversation = appendMessages(
      createConversation({}, withPlugin),
      withMessageId({ role: 'assistant', content: 'hello' }, 'chosen-id'),
      withPlugin,
    );

    expect(conversation.ids).toEqual(['chosen-id']);
  });

  it('still takes a plain id-bearing input as built, without running plugins over it', () => {
    const upcase = defineMessagePlugin(
      { id: 'upcase', revision: 1 },
      (input: MessageInput): MessageInput => ({
        ...input,
        content: typeof input.content === 'string' ? input.content.toUpperCase() : input.content,
      }),
    );
    const withPlugin = { ...environment, plugins: [upcase] };
    const imported = { id: 'imported-id', role: 'assistant', content: 'hello' } as MessageInput;

    const conversation = appendMessages(createConversation({}, withPlugin), imported, withPlugin);

    expect(getOrderedMessages(conversation)[0]?.content).toBe('hello');
  });

  it('refuses a second row under the same id', () => {
    const input = { id: 'chosen-id', role: 'assistant', content: 'hello' } as MessageInput;
    const once = appendMessages(createConversation({}, environment), input, environment);

    expect(() => appendMessages(once, input, environment)).toThrow();
  });

  it('gives a streaming placeholder the id it was asked for', () => {
    const { conversation, messageId } = appendStreamingMessage(
      createConversation({}, environment),
      'assistant',
      undefined,
      environment,
      { id: 'run-1:step:1' },
    );

    expect(messageId).toBe('run-1:step:1');
    expect(conversation.ids).toEqual(['run-1:step:1']);
  });

  it('gives each appended tool-call row the id at its index', () => {
    const conversation = appendToolCalls(
      createConversation({}, environment),
      [toolCall('a'), toolCall('b')],
      environment,
      { messageIds: ['row-a', 'row-b'] },
    );

    expect(conversation.ids).toEqual(['row-a', 'row-b']);
  });

  it('gives a single appended tool-call row the id it is named, beside its metadata', () => {
    const conversation = appendToolCall(
      createConversation({}, environment),
      toolCall('a'),
      { messageId: 'row-a', metadata: { lineage: 'x' } },
      environment,
    );

    expect(conversation.ids).toEqual(['row-a']);
    expect(conversation.messages['row-a']?.metadata).toEqual({ lineage: 'x' });
  });

  it('gives each appended tool-result row the id at its index, sync and async', async () => {
    const calls = appendToolCalls(
      createConversation({}, environment),
      [toolCall('a'), toolCall('b')],
      environment,
    );

    const sync = appendToolResults(calls, [toolResult('a')], environment, {
      messageIds: ['res-a'],
    });
    expect(sync.ids.at(-1)).toBe('res-a');

    const async = await appendToolResultsAsync(
      calls,
      [toolResult('a'), toolResult('b')],
      environment,
      undefined,
      { messageIds: ['res-a', 'res-b'] },
    );
    expect(async.ids.slice(-2)).toEqual(['res-a', 'res-b']);
  });

  it('refuses ids whose count differs from the rows', () => {
    const calls = appendToolCalls(
      createConversation({}, environment),
      [toolCall('a')],
      environment,
    );

    expect(() =>
      appendToolResults(calls, [toolResult('a')], environment, { messageIds: ['one', 'two'] }),
    ).toThrow(/2 messageIds for 1 rows/);
    expect(() =>
      appendToolCalls(createConversation({}, environment), [toolCall('a')], environment, {
        messageIds: [],
      }),
    ).toThrow(/0 messageIds for 1 rows/);
  });

  it('threads the ids through the history object and its events', () => {
    const history = new Conversation(undefined, environment);
    const actions: string[] = [];
    for (const type of ['tool-calls.appended', 'tool-results.appended'] as const) {
      history.addEventListener(type, (event) => actions.push(event.type));
    }

    history.appendToolCalls([toolCall('a')], { messageIds: ['row-a'] });
    history.appendToolResults([toolResult('a')], { messageIds: ['res-a'] });
    const streamingId = history.appendStreamingMessage('assistant', undefined, { id: 'stream-1' });

    expect(history.getMessages().map((message) => message.id)).toEqual([
      'row-a',
      'res-a',
      streamingId,
    ]);
    expect(streamingId).toBe('stream-1');
    expect(actions).toContain('tool-calls.appended');
    expect(actions).toContain('tool-results.appended');
  });
});
