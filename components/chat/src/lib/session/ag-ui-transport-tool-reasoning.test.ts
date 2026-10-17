import { describe, expect, test } from 'bun:test';
import {
  bodies,
  completedConversation,
  frames,
  runFinished,
  runStarted,
  transcript,
} from './ag-ui-transport-test-support.ts';

const started = { type: 'run.started', runId: 'run-1', threadId: 'thread-1' };

describe('AG-UI TOOL_CALL_* events', () => {
  test('stream a call as tool-call frames, then a row, then its result', async () => {
    const all = await bodies([
      runStarted,
      { type: 'TOOL_CALL_START', toolCallId: 'call-1', toolCallName: 'get_weather' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'call-1', delta: '{"city":' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'call-1', delta: '"NYC"}' },
      { type: 'TOOL_CALL_END', toolCallId: 'call-1' },
      { type: 'TOOL_CALL_RESULT', messageId: 'tool-1', toolCallId: 'call-1', content: '72F' },
      runFinished,
    ]);
    expect(all.slice(0, -1)).toEqual([
      started,
      { type: 'stream:tool-call-start', toolName: 'get_weather', blockId: 'call-1' },
      {
        type: 'stream:tool-call-delta',
        toolName: 'get_weather',
        blockId: 'call-1',
        partialArguments: '{"city":',
      },
      {
        type: 'stream:tool-call-delta',
        toolName: 'get_weather',
        blockId: 'call-1',
        partialArguments: '{"city":"NYC"}',
      },
      {
        type: 'stream:tool-call-complete',
        toolName: 'get_weather',
        blockId: 'call-1',
        arguments: { city: 'NYC' },
      },
      { type: 'tool_call', id: 'call-1', name: 'get_weather', arguments: { city: 'NYC' } },
      { type: 'tool_result', callId: 'call-1', outcome: 'success', content: '72F' },
    ]);
  });

  test('assemble the call and its result into the terminal conversation', async () => {
    const all = await frames([
      runStarted,
      { type: 'TOOL_CALL_START', toolCallId: 'call-1', toolCallName: 'get_weather' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'call-1', delta: '{"city":"NYC"}' },
      { type: 'TOOL_CALL_END', toolCallId: 'call-1' },
      { type: 'TOOL_CALL_RESULT', messageId: 'tool-1', toolCallId: 'call-1', content: '72F' },
      runFinished,
    ]);
    const rows = completedConversation(all);
    expect(transcript(rows)).toEqual([
      ['tool-call', ''],
      ['tool-result', ''],
    ]);
    expect(rows.messages[rows.ids[0] ?? '']?.toolCall).toEqual({
      id: 'call-1',
      name: 'get_weather',
      arguments: { city: 'NYC' },
    });
    expect(rows.messages[rows.ids[1] ?? '']?.toolResult).toMatchObject({
      callId: 'call-1',
      outcome: 'success',
      content: '72F',
    });
  });

  test('keep arguments that are not JSON as written, and treat none as an empty object', async () => {
    const all = await bodies([
      runStarted,
      { type: 'TOOL_CALL_START', toolCallId: 'a', toolCallName: 'broken' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'a', delta: '{not json' },
      { type: 'TOOL_CALL_END', toolCallId: 'a' },
      { type: 'TOOL_CALL_START', toolCallId: 'b', toolCallName: 'bare' },
      { type: 'TOOL_CALL_END', toolCallId: 'b' },
      runFinished,
    ]);
    const calls = all.filter((frame) => frame['type'] === 'tool_call');
    expect(calls).toEqual([
      { type: 'tool_call', id: 'a', name: 'broken', arguments: '{not json' },
      { type: 'tool_call', id: 'b', name: 'bare', arguments: {} },
    ]);
  });

  test('TOOL_CALL_CHUNK opens a call on its first chunk and closes it on a change', async () => {
    const all = await bodies([
      runStarted,
      { type: 'TOOL_CALL_CHUNK', toolCallId: 'a', toolCallName: 'first', delta: '{"x":' },
      { type: 'TOOL_CALL_CHUNK', delta: '1}' },
      { type: 'TOOL_CALL_CHUNK', toolCallId: 'b', toolCallName: 'second' },
      runFinished,
    ]);
    expect(all.slice(0, -1)).toEqual([
      started,
      { type: 'stream:tool-call-start', toolName: 'first', blockId: 'a' },
      {
        type: 'stream:tool-call-delta',
        toolName: 'first',
        blockId: 'a',
        partialArguments: '{"x":',
      },
      {
        type: 'stream:tool-call-delta',
        toolName: 'first',
        blockId: 'a',
        partialArguments: '{"x":1}',
      },
      {
        type: 'stream:tool-call-complete',
        toolName: 'first',
        blockId: 'a',
        arguments: { x: 1 },
      },
      { type: 'tool_call', id: 'a', name: 'first', arguments: { x: 1 } },
      { type: 'stream:tool-call-start', toolName: 'second', blockId: 'b' },
      { type: 'stream:tool-call-complete', toolName: 'second', blockId: 'b', arguments: {} },
      { type: 'tool_call', id: 'b', name: 'second', arguments: {} },
    ]);
  });

  test('read a result carrying content parts, and never parse a result body as JSON', async () => {
    const failed = JSON.stringify({ outcome: 'error', content: 'no such city' });
    const all = await bodies([
      runStarted,
      { type: 'TOOL_CALL_START', toolCallId: 'a', toolCallName: 'lookup' },
      { type: 'TOOL_CALL_END', toolCallId: 'a' },
      {
        type: 'TOOL_CALL_RESULT',
        messageId: 't1',
        toolCallId: 'a',
        content: [
          { type: 'text', text: 'part one' },
          { type: 'image', source: { type: 'url', value: 'https://example.com/a.png' } },
          { type: 'text', text: 'part two' },
        ],
      },
      { type: 'TOOL_CALL_START', toolCallId: 'b', toolCallName: 'lookup' },
      { type: 'TOOL_CALL_END', toolCallId: 'b' },
      { type: 'TOOL_CALL_RESULT', messageId: 't2', toolCallId: 'b', content: failed },
      runFinished,
    ]);
    const results = all.filter((frame) => frame['type'] === 'tool_result');
    expect(results[0]).toMatchObject({
      callId: 'a',
      outcome: 'success',
      content: [
        { type: 'text', text: 'part one' },
        { type: 'image', source: { type: 'url', value: 'https://example.com/a.png' } },
        { type: 'text', text: 'part two' },
      ],
    });
    expect(results[1]).toEqual({
      type: 'tool_result',
      callId: 'b',
      outcome: 'success',
      content: failed,
    });
  });

  test('put a call under the assistant message that made it, and keep every id', async () => {
    const all = await frames([
      runStarted,
      { type: 'TEXT_MESSAGE_START', messageId: 'assistant-1' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'assistant-1', delta: 'Checking.' },
      { type: 'TEXT_MESSAGE_END', messageId: 'assistant-1' },
      {
        type: 'TOOL_CALL_START',
        toolCallId: 'c1',
        toolCallName: 'lookup',
        parentMessageId: 'assistant-1',
      },
      { type: 'TOOL_CALL_END', toolCallId: 'c1' },
      {
        type: 'TOOL_CALL_START',
        toolCallId: 'c2',
        toolCallName: 'lookup',
        parentMessageId: 'assistant-1',
      },
      { type: 'TOOL_CALL_END', toolCallId: 'c2' },
      { type: 'TOOL_CALL_START', toolCallId: 'c3', toolCallName: 'lookup' },
      { type: 'TOOL_CALL_END', toolCallId: 'c3' },
      { type: 'TOOL_CALL_RESULT', messageId: 't1', toolCallId: 'c1', content: 'one' },
      runFinished,
    ]);
    expect(completedConversation(all).ids).toEqual([
      'assistant-1',
      'assistant-1:call:c1',
      'assistant-1:call:c2',
      'c3:message',
      't1',
    ]);
  });
});

describe('AG-UI REASONING_* events', () => {
  const span = { type: 'REASONING_START', messageId: 'span-1' };
  const spanEnd = { type: 'REASONING_END', messageId: 'span-1' };
  const messageStart = (messageId: string) => ({
    type: 'REASONING_MESSAGE_START',
    messageId,
    role: 'reasoning',
  });
  const content = (messageId: string, delta: string) => ({
    type: 'REASONING_MESSAGE_CONTENT',
    messageId,
    delta,
  });
  const messageEnd = (messageId: string) => ({ type: 'REASONING_MESSAGE_END', messageId });
  const block = (content: string, complete: boolean) => ({
    id: 'span-1',
    type: 'thinking',
    index: 0,
    content,
    complete,
  });

  test('stream a span as one thinking block, with its messages named by their own ids', async () => {
    const all = await bodies([
      runStarted,
      span,
      messageStart('msg-1'),
      content('msg-1', 'Let me '),
      content('msg-1', 'think.'),
      messageEnd('msg-1'),
      messageStart('msg-2'),
      content('msg-2', ' Then more.'),
      messageEnd('msg-2'),
      spanEnd,
      runFinished,
    ]);
    expect(all.slice(0, -1)).toEqual([
      started,
      { type: 'stream:block-start', block: block('', false) },
      { type: 'stream:block-delta', block: block('Let me ', false), delta: 'Let me ' },
      { type: 'stream:block-delta', block: block('Let me think.', false), delta: 'think.' },
      {
        type: 'stream:block-delta',
        block: block('Let me think. Then more.', false),
        delta: ' Then more.',
      },
      { type: 'stream:block-complete', block: block('Let me think. Then more.', true) },
    ]);
  });

  test('REASONING_MESSAGE_CHUNK extends messages of the open span, each under its own id', async () => {
    const all = await bodies([
      runStarted,
      span,
      { type: 'REASONING_MESSAGE_CHUNK', messageId: 'msg-1', delta: 'a' },
      { type: 'REASONING_MESSAGE_CHUNK', delta: 'b' },
      { type: 'REASONING_MESSAGE_CHUNK', messageId: 'msg-1' },
      { type: 'REASONING_MESSAGE_CHUNK', messageId: 'msg-2', delta: 'c' },
      spanEnd,
      runFinished,
    ]);
    const deltas = all.flatMap((frame) =>
      frame['type'] === 'stream:block-delta' ? [frame['delta']] : [],
    );
    expect(deltas).toEqual(['a', 'b', 'c']);
  });

  test('become one reasoning message each, ahead of the assistant message that follows', async () => {
    const all = await frames([
      runStarted,
      span,
      messageStart('msg-1'),
      content('msg-1', 'first'),
      messageEnd('msg-1'),
      messageStart('msg-2'),
      content('msg-2', 'second'),
      messageEnd('msg-2'),
      spanEnd,
      { type: 'TEXT_MESSAGE_START', messageId: 'm1' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Done.' },
      { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
      runFinished,
    ]);
    expect(transcript(completedConversation(all))).toEqual([
      [
        'assistant',
        [
          { type: 'thinking', thinking: 'first', signature: '' },
          { type: 'thinking', thinking: 'second', signature: '' },
          { type: 'text', text: 'Done.' },
        ],
      ],
    ]);
  });

  test('attach an encrypted value to the message it names, before or after the span ends', async () => {
    const signatures = (all: Awaited<ReturnType<typeof frames>>) => {
      const rows = completedConversation(all);
      const row = rows.messages[rows.ids.at(-1) ?? '']?.content;
      return Array.isArray(row)
        ? row.map((part) => ('signature' in part ? part.signature : ''))
        : [];
    };
    const encrypted = (entityId: string, encryptedValue: string, subtype = 'message') => ({
      type: 'REASONING_ENCRYPTED_VALUE',
      subtype,
      entityId,
      encryptedValue,
    });
    const early = await frames([
      runStarted,
      span,
      encrypted('msg-2', 'early'),
      messageStart('msg-1'),
      messageEnd('msg-1'),
      messageStart('msg-2'),
      messageEnd('msg-2'),
      spanEnd,
      runFinished,
    ]);
    const late = await frames([
      runStarted,
      { type: 'TEXT_MESSAGE_START', messageId: 'm0' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm0', delta: 'First.' },
      { type: 'TEXT_MESSAGE_END', messageId: 'm0' },
      span,
      messageStart('msg-1'),
      messageEnd('msg-1'),
      spanEnd,
      encrypted('msg-1', 'late'),
      encrypted('span-1', 'ignored-span-id'),
      encrypted('call-1', 'ignored-tool-call', 'tool-call'),
      runFinished,
    ]);
    expect(signatures(early)).toEqual(['', 'early']);
    expect(signatures(late)).toEqual(['late']);
  });
});
