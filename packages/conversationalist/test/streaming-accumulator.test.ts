import { describe, expect, it } from 'bun:test';

import {
  contentOf,
  createStreamingAccumulator,
  finalizeBlockState,
  toolCallsOf,
} from '../src/streaming-accumulator';

const testEnvironment = {
  now: () => '2024-01-01T00:00:00.000Z',
  randomId: (() => {
    let counter = 0;
    return () => `test-id-${++counter}`;
  })(),
};

describe('C4 — createStreamingAccumulator (multi-part accumulation)', () => {
  it('accumulates a single text block', () => {
    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'text', buffer: '' });
    acc.getBlock(0)?.appendTextDelta('Hello');
    acc.getBlock(0)?.appendTextDelta(', world!');

    const result = acc.finalize();
    expect(contentOf(result)).toEqual([{ type: 'text', text: 'Hello, world!' }]);
    expect(toolCallsOf(result)).toEqual([]);
  });

  it('returns a client tool_use as a tool-call segment (NOT content) so pairing stays intact', () => {
    const acc = createStreamingAccumulator();
    // Block 0: text
    acc.openBlock(0, { type: 'text', buffer: '' });
    acc.getBlock(0)?.appendTextDelta('Let me search.');

    // Block 1: client tool_use with partial JSON deltas
    acc.openBlock(1, { type: 'tool_use', id: 'call-1', name: 'search', inputBuffer: '' });
    acc.getBlock(1)?.appendInputJsonDelta('{"q":');
    acc.getBlock(1)?.appendInputJsonDelta('"cats"}');

    const result = acc.finalize();
    // The client tool call does NOT land in assistant content — it becomes a
    // tool-call segment so a later tool-result can pair to it.
    expect(contentOf(result)).toEqual([{ type: 'text', text: 'Let me search.' }]);
    expect(toolCallsOf(result)).toEqual([
      { id: 'call-1', name: 'search', arguments: { q: 'cats' } },
    ]);
  });

  it('preserves block order with a client tool_use interleaved: [text, tool_use, text] → content/tool-call/content segments', () => {
    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'text', buffer: '' });
    acc.getBlock(0)?.appendTextDelta('Before.');
    acc.openBlock(1, { type: 'tool_use', id: 'call-mid', name: 'lookup', inputBuffer: '' });
    acc.getBlock(1)?.appendInputJsonDelta('{"k":"v"}');
    acc.openBlock(2, { type: 'text', buffer: '' });
    acc.getBlock(2)?.appendTextDelta('After.');

    const { segments } = acc.finalize();
    // The tool call keeps its TRUE position between the two text runs.
    expect(segments).toEqual([
      { kind: 'content', content: [{ type: 'text', text: 'Before.' }] },
      { kind: 'tool-call', toolCall: { id: 'call-mid', name: 'lookup', arguments: { k: 'v' } } },
      { kind: 'content', content: [{ type: 'text', text: 'After.' }] },
    ]);
  });

  it('accumulates a server_tool_use block as server_tool_use content (distinct from client tool_use)', () => {
    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'server_tool_use', id: 'stu-1', name: 'web_search', inputBuffer: '' });
    acc.getBlock(0)?.appendInputJsonDelta('{"query":"news"}');

    const result = acc.finalize();
    // Server tool use stays in content; it is part of the assistant turn.
    expect(contentOf(result)).toEqual([
      { type: 'server_tool_use', id: 'stu-1', name: 'web_search', input: { query: 'news' } },
    ]);
    expect(toolCallsOf(result)).toEqual([]);
  });

  it('separates multiple client tool calls in block order, leaving content untouched', () => {
    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'text', buffer: '' });
    acc.getBlock(0)?.appendTextDelta('Doing two things.');
    acc.openBlock(1, { type: 'tool_use', id: 'call-a', name: 'first', inputBuffer: '' });
    acc.getBlock(1)?.appendInputJsonDelta('{"x":1}');
    acc.openBlock(2, { type: 'tool_use', id: 'call-b', name: 'second', inputBuffer: '' });
    acc.getBlock(2)?.appendInputJsonDelta('{"y":2}');

    const result = acc.finalize();
    expect(contentOf(result)).toEqual([{ type: 'text', text: 'Doing two things.' }]);
    expect(toolCallsOf(result)).toEqual([
      { id: 'call-a', name: 'first', arguments: { x: 1 } },
      { id: 'call-b', name: 'second', arguments: { y: 2 } },
    ]);
  });

  it('accumulates a thinking block with thinking_delta and signature', () => {
    const SIG = 'test-signature-abc==';
    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'thinking', buffer: '', signature: '' });
    acc.getBlock(0)?.appendThinkingDelta('I should think about this.');
    acc.getBlock(0)?.appendSignatureDelta(SIG);

    expect(contentOf(acc.finalize())).toEqual([
      { type: 'thinking', thinking: 'I should think about this.', signature: SIG },
    ]);
  });

  it('also accepts text deltas for thinking blocks', () => {
    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'thinking', buffer: '', signature: '' });
    acc.getBlock(0)?.appendTextDelta('thinking as text delta');
    acc.getBlock(0)?.appendSignatureDelta('sig==');

    expect(contentOf(acc.finalize())).toEqual([
      { type: 'thinking', thinking: 'thinking as text delta', signature: 'sig==' },
    ]);
  });

  it('accumulates a signature delivered across multiple signature_delta chunks byte-for-byte', () => {
    // Anthropic may split the signature across several signature_delta events;
    // appendSignatureDelta must concatenate, not replace, or the byte-for-byte
    // signature breaks extended-thinking replay.
    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'thinking', buffer: '', signature: '' });
    acc.getBlock(0)?.appendThinkingDelta('reasoning');
    acc.getBlock(0)?.appendSignatureDelta('EqoBCkgIA');
    acc.getBlock(0)?.appendSignatureDelta('RABGAIiQ');
    acc.getBlock(0)?.appendSignatureDelta('L8gy6==');

    expect(contentOf(acc.finalize())).toEqual([
      { type: 'thinking', thinking: 'reasoning', signature: 'EqoBCkgIARABGAIiQL8gy6==' },
    ]);
  });

  it('accumulates citations_delta entries onto a streamed text block', () => {
    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'text', buffer: '' });
    acc.getBlock(0)?.appendTextDelta('The answer is 4.');
    acc.getBlock(0)?.appendCitationsDelta({ type: 'char_location', cited_text: 'a', start: 0 });
    acc.getBlock(0)?.appendCitationsDelta({ type: 'char_location', cited_text: 'b', start: 5 });

    expect(contentOf(acc.finalize())).toEqual([
      {
        type: 'text',
        text: 'The answer is 4.',
        citations: [
          { type: 'char_location', cited_text: 'a', start: 0 },
          { type: 'char_location', cited_text: 'b', start: 5 },
        ],
      },
    ]);
  });

  it('accumulates a streamed web_fetch_tool_result block', () => {
    const acc = createStreamingAccumulator();
    acc.openBlock(0, {
      type: 'web_fetch_tool_result',
      tool_use_id: 'wf-1',
      content: { url: 'https://example.com', text: 'page body' },
    });

    expect(contentOf(acc.finalize())).toEqual([
      {
        type: 'web_fetch_tool_result',
        tool_use_id: 'wf-1',
        content: { url: 'https://example.com', text: 'page body' },
      },
    ]);
  });

  it('accumulates a redacted_thinking block (data seeded at openBlock, no signature)', () => {
    const DATA = 'encrypted-redacted-payload==';
    const acc = createStreamingAccumulator();
    // redacted_thinking carries its encrypted `data` in the start event.
    acc.openBlock(0, { type: 'redacted_thinking', data: DATA });

    expect(contentOf(acc.finalize())).toEqual([{ type: 'redacted_thinking', data: DATA }]);
  });

  it('preserves block order by index regardless of open order', () => {
    const acc = createStreamingAccumulator();
    const requireBlock = (index: number) => {
      const block = acc.getBlock(index);
      if (!block) throw new Error(`missing block ${index}`);
      return block;
    };
    // Open block 2 first, then 0, then 1
    acc.openBlock(2, { type: 'text', buffer: '' });
    requireBlock(2).appendTextDelta('Third');

    acc.openBlock(0, { type: 'thinking', buffer: '', signature: '' });
    requireBlock(0).appendThinkingDelta('First');
    requireBlock(0).appendSignatureDelta('sig==');

    acc.openBlock(1, { type: 'text', buffer: '' });
    requireBlock(1).appendTextDelta('Second');

    const content = contentOf(acc.finalize());
    expect(content).toHaveLength(3);
    expect(content[0]?.type).toBe('thinking');
    expect(content[1]?.type).toBe('text');
    expect(content[2]?.type).toBe('text');
    if (content[1]?.type === 'text') expect(content[1].text).toBe('Second');
    if (content[2]?.type === 'text') expect(content[2].text).toBe('Third');
  });

  it('finalizes a zero-argument tool call (no input_json_delta) with input {}', () => {
    // A no-arg tool streams with no input_json_delta, so inputBuffer stays ''.
    // That is a legitimate `{}` input, not a corrupt stream — it must NOT throw.
    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'tool_use', id: 'call-noarg', name: 'ping', inputBuffer: '' });

    expect(toolCallsOf(acc.finalize())).toEqual([
      { id: 'call-noarg', name: 'ping', arguments: {} },
    ]);
  });

  it('throws on NON-EMPTY malformed JSON in a tool_use block rather than emitting empty input', () => {
    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'tool_use', id: 'call-bad', name: 'pay', inputBuffer: '' });
    acc.getBlock(0)?.appendInputJsonDelta('{invalid json');

    // A corrupt/incomplete (non-empty) stream must not silently become a
    // valid-looking tool call — finalize throws, naming the tool.
    expect(() => acc.finalize()).toThrow(/Streamed tool input for "pay" is not valid JSON/);
  });

  it('throws on malformed JSON in a server_tool_use block', () => {
    const acc = createStreamingAccumulator();
    acc.openBlock(0, {
      type: 'server_tool_use',
      id: 'stu-bad',
      name: 'web_search',
      inputBuffer: '',
    });
    acc.getBlock(0)?.appendInputJsonDelta('{"query":');

    expect(() => acc.finalize()).toThrow(/Streamed tool input for "web_search" is not valid JSON/);
  });

  it('finalizes a thinking block with an empty buffer when no thinking_delta arrives', () => {
    const SIG = 'sig-only==';
    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'thinking', buffer: '', signature: '' });
    // Only the signature arrives (no thinking_delta).
    acc.getBlock(0)?.appendSignatureDelta(SIG);

    expect(contentOf(acc.finalize())).toEqual([{ type: 'thinking', thinking: '', signature: SIG }]);
  });

  it('getBlock returns undefined for a block index that has not been opened', () => {
    const acc = createStreamingAccumulator();
    expect(acc.getBlock(99)).toBeUndefined();
  });

  it('round-trips a streamed client tool call into a conversation and pairs its tool-result', async () => {
    // Regression for the Cursor finding: a streamed client tool_use must produce
    // a tool-call message so a later tool-result pairs to it. Appending the
    // assistant content + the tool-call + the matching tool-result must NOT throw
    // an orphan-tool-result integrity error.
    const { appendMessages, createConversationHistory } = await import('../src/conversation/index');

    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'text', buffer: '' });
    acc.getBlock(0)?.appendTextDelta('Let me pay.');
    acc.openBlock(1, { type: 'tool_use', id: 'call-pay', name: 'pay', inputBuffer: '' });
    acc.getBlock(1)?.appendInputJsonDelta('{"amount":5}');

    const { segments } = acc.finalize();

    let conversation = createConversationHistory({ id: 'stream-pairing' }, testEnvironment);
    for (const segment of segments) {
      conversation =
        segment.kind === 'content'
          ? appendMessages(
              conversation,
              { role: 'assistant', content: segment.content },
              testEnvironment,
            )
          : appendMessages(
              conversation,
              { role: 'tool-call', content: '', toolCall: segment.toolCall },
              testEnvironment,
            );
    }

    // The matching tool-result pairs cleanly — no throw.
    expect(() => {
      appendMessages(
        conversation,
        {
          role: 'tool-result',
          content: '',
          toolResult: { callId: 'call-pay', outcome: 'success', content: { ok: true } },
        },
        testEnvironment,
      );
    }).not.toThrow();
  });

  it('accumulates a streamed web_search_tool_result block (content seeded at openBlock)', () => {
    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'server_tool_use', id: 'stu-1', name: 'web_search', inputBuffer: '' });
    acc.getBlock(0)?.appendInputJsonDelta('{"query":"news"}');
    // The search result arrives as its own block with content in the start event.
    acc.openBlock(1, {
      type: 'web_search_tool_result',
      tool_use_id: 'stu-1',
      content: [{ url: 'https://example.com', title: 'News' }],
    });

    const content = contentOf(acc.finalize());
    expect(content.map((c) => c.type)).toEqual(['server_tool_use', 'web_search_tool_result']);
    expect(content[1]).toEqual({
      type: 'web_search_tool_result',
      tool_use_id: 'stu-1',
      content: [{ url: 'https://example.com', title: 'News' }],
    });
  });

  it('accumulates a streamed code-execution result block', () => {
    const acc = createStreamingAccumulator();
    acc.openBlock(0, {
      type: 'bash_code_execution_tool_result',
      tool_use_id: 'stu-bash',
      content: { stdout: 'ok', exit_code: 0 },
    });

    expect(contentOf(acc.finalize())).toEqual([
      {
        type: 'bash_code_execution_tool_result',
        tool_use_id: 'stu-bash',
        content: { stdout: 'ok', exit_code: 0 },
      },
    ]);
  });

  it('accumulates a container_upload block (file id seeded at openBlock)', () => {
    const acc = createStreamingAccumulator();
    acc.openBlock(0, { type: 'container_upload', file_id: 'file-123' });

    expect(contentOf(acc.finalize())).toEqual([{ type: 'container_upload', file_id: 'file-123' }]);
  });

  it('finalizes one block on its own, so a caller can report it complete as its stop event arrives', () => {
    expect(finalizeBlockState({ type: 'thinking', buffer: 'Plan.', signature: 'sig-1' })).toEqual({
      type: 'thinking',
      thinking: 'Plan.',
      signature: 'sig-1',
    });
    expect(
      finalizeBlockState({
        type: 'server_tool_use',
        id: 's1',
        name: 'web_search',
        inputBuffer: '{"q":"x"}',
      }),
    ).toEqual({ type: 'server_tool_use', id: 's1', name: 'web_search', input: { q: 'x' } });
    expect(
      finalizeBlockState({ type: 'text', buffer: 'cited', citations: [{ cited_text: 'c' }] }),
    ).toEqual({ type: 'text', text: 'cited', citations: [{ cited_text: 'c' }] });
    expect(
      finalizeBlockState({ type: 'tool_use', id: 't1', name: 'tool', inputBuffer: '{}' }),
    ).toBe(undefined);
  });
});
