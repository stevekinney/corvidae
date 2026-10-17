import { describe, expect, test } from 'bun:test';
import {
  bodies,
  completedConversation,
  frames,
  runFinished,
  runStarted,
  transcript,
} from './ag-ui-transport-test-support.ts';

const started = { type: 'run.started', runId: 'run-1' };

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

  test('read a result carrying content parts, and an outcome the content spells out', async () => {
    const failed = JSON.stringify({
      outcome: 'error',
      content: 'no such city',
      error: { code: 'not_found', category: 'not_found', retryable: false, message: 'no city' },
    });
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
    expect(results[0]).toMatchObject({ callId: 'a', outcome: 'success' });
    expect(results[1]).toMatchObject({
      callId: 'b',
      outcome: 'error',
      content: 'no such city',
      error: { code: 'not_found' },
    });
  });
});

describe('AG-UI REASONING_* events', () => {
  const reasoningRun = [
    runStarted,
    { type: 'REASONING_START', messageId: 'r1' },
    { type: 'REASONING_MESSAGE_START', messageId: 'r1', role: 'reasoning' },
    { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r1', delta: 'Let me ' },
    { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r1', delta: 'think.' },
    { type: 'REASONING_MESSAGE_END', messageId: 'r1' },
    { type: 'REASONING_END', messageId: 'r1' },
  ];

  test('stream a reasoning span as a thinking block', async () => {
    const all = await bodies([...reasoningRun, runFinished]);
    const block = { id: 'r1', type: 'thinking', index: 0 };
    expect(all.slice(0, -1)).toEqual([
      started,
      { type: 'stream:block-start', block: { ...block, content: '', complete: false } },
      {
        type: 'stream:block-delta',
        block: { ...block, content: 'Let me ', complete: false },
        delta: 'Let me ',
      },
      {
        type: 'stream:block-delta',
        block: { ...block, content: 'Let me think.', complete: false },
        delta: 'think.',
      },
      {
        type: 'stream:block-complete',
        block: { ...block, content: 'Let me think.', complete: true },
      },
    ]);
  });

  test('REASONING_MESSAGE_CHUNK extends the open span', async () => {
    const all = await bodies([
      runStarted,
      { type: 'REASONING_START', messageId: 'r1' },
      { type: 'REASONING_MESSAGE_CHUNK', messageId: 'r1', delta: 'a' },
      { type: 'REASONING_MESSAGE_CHUNK', delta: 'b' },
      { type: 'REASONING_MESSAGE_CHUNK', messageId: 'r1' },
      { type: 'REASONING_END', messageId: 'r1' },
      runFinished,
    ]);
    const deltas = all.flatMap((frame) =>
      frame['type'] === 'stream:block-delta' ? [frame['delta']] : [],
    );
    expect(deltas).toEqual(['a', 'b']);
  });

  test('become thinking content on the assistant message that follows, signature included', async () => {
    const withSignature = await frames([
      ...reasoningRun,
      {
        type: 'REASONING_ENCRYPTED_VALUE',
        subtype: 'message',
        entityId: 'r1',
        encryptedValue: 'sig-before',
      },
      { type: 'TEXT_MESSAGE_START', messageId: 'm1' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Done.' },
      { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
      runFinished,
    ]);
    expect(transcript(completedConversation(withSignature))).toEqual([
      [
        'assistant',
        [
          { type: 'thinking', thinking: 'Let me think.', signature: 'sig-before' },
          { type: 'text', text: 'Done.' },
        ],
      ],
    ]);
  });

  test('carry an encrypted value that arrives before or after the span ends', async () => {
    const before = await frames([
      runStarted,
      { type: 'REASONING_START', messageId: 'r1' },
      {
        type: 'REASONING_ENCRYPTED_VALUE',
        subtype: 'message',
        entityId: 'r1',
        encryptedValue: 'early',
      },
      { type: 'REASONING_END', messageId: 'r1' },
      runFinished,
    ]);
    const after = await frames([
      runStarted,
      { type: 'TEXT_MESSAGE_START', messageId: 'm0' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm0', delta: 'First.' },
      { type: 'TEXT_MESSAGE_END', messageId: 'm0' },
      { type: 'REASONING_START', messageId: 'r1' },
      { type: 'REASONING_END', messageId: 'r1' },
      {
        type: 'REASONING_ENCRYPTED_VALUE',
        subtype: 'message',
        entityId: 'r1',
        encryptedValue: 'late',
      },
      {
        type: 'REASONING_ENCRYPTED_VALUE',
        subtype: 'tool-call',
        entityId: 'call-1',
        encryptedValue: 'x',
      },
      runFinished,
    ]);
    const signature = (all: typeof before) => {
      const rows = completedConversation(all);
      const content = rows.messages[rows.ids.at(-1) ?? '']?.content;
      return Array.isArray(content) ? content[0] : undefined;
    };
    expect(signature(before)).toMatchObject({ type: 'thinking', signature: 'early' });
    expect(signature(after)).toMatchObject({ type: 'thinking', signature: 'late' });
  });
});
