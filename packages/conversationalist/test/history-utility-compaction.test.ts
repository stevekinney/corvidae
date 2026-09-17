import { describe, expect, it } from 'bun:test';

import { Conversation as ConversationHistory } from '../src/history';
import { createConversationHistory as createConversation } from '../src/index';
import type { ConversationHistory as ConversationState, Message } from '../src/types';

const getOrderedMessages = (conversation: ConversationState): Message[] =>
  conversation.ids
    .map((id) => conversation.messages[id])
    .filter((message): message is Message => Boolean(message));

describe('Conversation compaction and tool interactions', () => {
  it('compacts conversation replacing old messages with summary', async () => {
    const history = new ConversationHistory(createConversation());
    for (let i = 0; i < 10; i++) {
      history.appendUserMessage(`Message ${i}`);
      history.appendAssistantMessage(`Reply ${i}`);
    }
    const before = history.current.ids.length;

    const result = await history.compact(async (messages) => {
      return `Summary of ${messages.length} messages`;
    });

    expect(result.compacted).toBe(true);
    expect(result.messagesRemoved).toBeGreaterThan(0);
    expect(history.current.ids.length).toBeLessThan(before);
  });

  it('emits compaction events', async () => {
    const history = new ConversationHistory(createConversation());
    for (let i = 0; i < 8; i++) {
      history.appendUserMessage(`Msg ${i}`);
    }

    const events: string[] = [];
    history.addEventListener('compaction.started', () => events.push('started'));
    history.addEventListener('compaction.completed', () => events.push('completed'));

    await history.compact(async () => 'summary');

    expect(events).toContain('started');
    expect(events).toContain('completed');
  });

  it('returns compacted false when nothing to compact', async () => {
    const history = new ConversationHistory(createConversation());
    history.appendUserMessage('one');
    history.appendAssistantMessage('two');

    const result = await history.compact(async () => 'summary');
    expect(result.compacted).toBe(false);
  });

  it('supports observable event helpers and tool interaction wrappers', async () => {
    let identifierIndex = 0;
    const history = new ConversationHistory(createConversation(), {
      randomId: () => `tool-call-${++identifierIndex}`,
    });

    const typedEvents: string[] = [];
    const allEvents: string[] = [];
    const onEvents: string[] = [];
    let onceCount = 0;

    const onSubscription = history
      .on('tool-calls.appended')
      .subscribe((event) => onEvents.push(event.type));
    const typedSubscription = history.subscribe('tool-results.appended', (event) => {
      typedEvents.push(event.type);
    });
    const allSubscription = history.toObservable().subscribe((event) => {
      allEvents.push(event.type);
    });
    history.once('tool-calls.appended', () => {
      onceCount += 1;
    });

    history.appendToolCall({
      name: 'lookup-weather',
      arguments: { city: 'Denver' },
    });
    history.appendToolCalls([]);

    const [firstPendingToolCall] = history.getPendingToolCalls();
    expect(firstPendingToolCall?.id).toBe('tool-call-1');
    expect(firstPendingToolCall?.arguments).toEqual({ city: 'Denver' });

    const nextToolResultEvent = history.events('tool-results.appended').next();

    history.appendToolResult({
      callId: 'tool-call-1',
      outcome: 'success',
      content: { forecast: 'sunny' },
    });

    const emittedToolResultEvent = await nextToolResultEvent;
    expect(emittedToolResultEvent.done).toBe(false);
    expect(emittedToolResultEvent.value?.type).toBe('tool-results.appended');

    history.appendToolCalls([
      {
        id: 'tool-call-2',
        name: 'lookup-weather',
        arguments: { city: 'Boulder' },
      },
    ]);
    history.appendToolResults([]);

    await history.appendToolResultAsync({
      callId: 'tool-call-2',
      outcome: 'success',
      content: [],
      stream: {
        async *[Symbol.asyncIterator]() {
          yield { forecast: 'snow' };
        },
      },
    });

    history.appendToolCalls([
      {
        id: 'tool-call-3',
        name: 'lookup-weather',
        arguments: { city: 'Fort Collins' },
      },
      {
        id: 'tool-call-4',
        name: 'lookup-weather',
        arguments: { city: 'Colorado Springs' },
      },
    ]);

    await history.appendToolResultsAsync([
      {
        callId: 'tool-call-3',
        outcome: 'success',
        content: [],
        result: {
          async *[Symbol.asyncIterator]() {
            yield 'warm';
            yield 'dry';
          },
        },
      },
      {
        callId: 'tool-call-4',
        outcome: 'action_required',
        content: { prompt: 'Approve request' },
        action: {
          type: 'approval',
          message: 'Need approval',
        },
      },
    ]);

    expect(history.getPendingToolCalls()).toHaveLength(0);
    expect(history.getToolInteractions()).toHaveLength(4);
    expect(onEvents).toContain('tool-calls.appended');
    expect(typedEvents).toContain('tool-results.appended');
    expect(allEvents).toContain('tool-calls.appended');
    expect(allEvents).toContain('tool-results.appended');
    expect(onceCount).toBe(1);

    onSubscription.unsubscribe();
    typedSubscription.unsubscribe();
    allSubscription.unsubscribe();

    history.complete();
    expect(history.completed).toBe(true);
  });

  it('resolves a pending tool-result by callId, keeping exactly one tool-result message', () => {
    let messageIndex = 0;
    const history = new ConversationHistory(createConversation(), {
      randomId: () => `msg-${++messageIndex}`,
    });

    history.appendToolCall({
      id: 'call-1',
      name: 'deploy',
      arguments: { environment: 'production' },
    });
    history.appendToolResult({
      callId: 'call-1',
      outcome: 'action_required',
      content: null,
      action: { type: 'approval', message: 'Approve deploy to production?' },
    });

    history.resolveToolResult('call-1', {
      callId: 'call-1',
      outcome: 'success',
      content: { deployed: true },
    });

    const toolResultMessages = getOrderedMessages(history.current).filter(
      (message) => message.role === 'tool-result' && message.toolResult?.callId === 'call-1',
    );
    expect(toolResultMessages).toHaveLength(1);
    expect(toolResultMessages[0]?.toolResult?.outcome).toBe('success');
  });

  it('resolveToolResultAsync collects a streaming toolResult before replacing the pending result', async () => {
    let messageIndex = 0;
    const history = new ConversationHistory(createConversation(), {
      randomId: () => `msg-${++messageIndex}`,
    });

    history.appendToolCall({ id: 'call-1', name: 'deploy', arguments: {} });
    history.appendToolResult({
      callId: 'call-1',
      outcome: 'action_required',
      content: null,
      action: { type: 'approval', message: 'Approve deploy?' },
    });

    await history.resolveToolResultAsync('call-1', {
      callId: 'call-1',
      outcome: 'success',
      content: [],
      stream: {
        async *[Symbol.asyncIterator]() {
          yield { chunk: 'a' };
        },
      },
    });

    const toolResultMessages = getOrderedMessages(history.current).filter(
      (message) => message.role === 'tool-result' && message.toolResult?.callId === 'call-1',
    );
    expect(toolResultMessages).toHaveLength(1);
    expect(toolResultMessages[0]?.toolResult?.content).toEqual([{ chunk: 'a' }]);
  });
});
