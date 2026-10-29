import type { AnthropicStreamEvent } from '../../src/providers/anthropic-types';

/** A recorded Anthropic content block: the exact shape the API returns, kept verbatim for replay checks. */
export type RecordedAnthropicBlock = { type: string } & Record<string, unknown>;

export const thinkingBlock = {
  type: 'thinking',
  thinking: 'I should look at the weather first.',
  signature: 'EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds',
} satisfies RecordedAnthropicBlock;

export const redactedThinkingBlock = {
  type: 'redacted_thinking',
  data: 'EmwKAhgBEgy3va3pzix/LafPsn4aDFIT2Xlxh0L5L8rLVyIwxtE3rAFBa8cr3qpP',
} satisfies RecordedAnthropicBlock;

export const toolUseBlock = {
  type: 'tool_use',
  id: 'toolu_01A',
  name: 'get_weather',
  input: { location: 'Paris' },
} satisfies RecordedAnthropicBlock;

export const citedTextBlock = {
  type: 'text',
  text: 'The grass is green.',
  citations: [
    {
      type: 'char_location',
      cited_text: 'The grass is green.',
      document_index: 0,
      document_title: 'My Document',
      start_char_index: 0,
      end_char_index: 19,
    },
  ],
} satisfies RecordedAnthropicBlock;

export const serverToolBlocks = [
  { type: 'server_tool_use', id: 'srvtoolu_01', name: 'web_search', input: { query: 'weather' } },
  {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_01',
    content: [{ type: 'web_search_result', url: 'https://example.com', title: 'Weather' }],
  },
  {
    type: 'server_tool_use',
    id: 'srvtoolu_02',
    name: 'web_fetch',
    input: { url: 'https://x.test' },
  },
  {
    type: 'web_fetch_tool_result',
    tool_use_id: 'srvtoolu_02',
    content: { type: 'web_fetch_result', url: 'https://x.test' },
  },
  { type: 'server_tool_use', id: 'srvtoolu_03', name: 'code_execution', input: { code: '1+1' } },
  {
    type: 'code_execution_tool_result',
    tool_use_id: 'srvtoolu_03',
    content: { type: 'code_execution_result', stdout: '2', stderr: '', return_code: 0 },
  },
  {
    type: 'bash_code_execution_tool_result',
    tool_use_id: 'srvtoolu_04',
    content: { type: 'bash_code_execution_result', stdout: 'ok', return_code: 0 },
  },
  {
    type: 'text_editor_code_execution_tool_result',
    tool_use_id: 'srvtoolu_05',
    content: { type: 'text_editor_code_execution_view_result', content: 'x' },
  },
  { type: 'container_upload', file_id: 'file_011' },
] satisfies RecordedAnthropicBlock[];

const RESULT_BLOCK_TYPES = new Set([
  'web_search_tool_result',
  'web_fetch_tool_result',
  'code_execution_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
]);

/**
 * The stream events the API would emit for these recorded blocks, in order: each block opens with
 * its content-bearing fields, then its deltas, then a stop. Results and uploads arrive whole in the
 * start event; text, thinking (and its signature), citations and tool input arrive as deltas.
 */
export function anthropicStreamEventsFor(
  blocks: readonly RecordedAnthropicBlock[],
  usage = { input: 12, output: 7 },
): AnthropicStreamEvent[] {
  const events: AnthropicStreamEvent[] = [
    { type: 'message_start', message: { usage: { input_tokens: usage.input, output_tokens: 0 } } },
  ];
  for (const [index, block] of blocks.entries()) {
    const type = block['type'];
    if (type === 'text') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });
      const text = block['text'] as string;
      const middle = Math.ceil(text.length / 2);
      for (const piece of [text.slice(0, middle), text.slice(middle)]) {
        events.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: piece },
        });
      }
      for (const citation of (block['citations'] as unknown[] | undefined) ?? []) {
        events.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'citations_delta', citation },
        });
      }
    } else if (type === 'thinking') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '' },
      });
      const thinking = block['thinking'] as string;
      const middle = Math.ceil(thinking.length / 2);
      for (const piece of [thinking.slice(0, middle), thinking.slice(middle)]) {
        events.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'thinking_delta', thinking: piece },
        });
      }
      const signature = block['signature'] as string;
      for (const piece of [signature.slice(0, 10), signature.slice(10)]) {
        events.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'signature_delta', signature: piece },
        });
      }
    } else if (type === 'tool_use' || type === 'server_tool_use') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type, id: block['id'] as string, name: block['name'] as string },
      });
      const json = JSON.stringify(block['input']);
      const middle = Math.ceil(json.length / 2);
      for (const piece of [json.slice(0, middle), json.slice(middle)]) {
        events.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: piece },
        });
      }
    } else if (
      type === 'redacted_thinking' ||
      type === 'container_upload' ||
      RESULT_BLOCK_TYPES.has(type)
    ) {
      events.push({ type: 'content_block_start', index, content_block: block });
    } else {
      events.push({ type: 'content_block_start', index, content_block: { type } });
    }
    events.push({ type: 'content_block_stop', index });
  }
  events.push(
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: usage.output },
    },
    { type: 'message_stop' },
  );
  return events;
}
