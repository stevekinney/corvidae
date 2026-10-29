import type { AnthropicMessageResponse, AnthropicStreamEvent } from '../anthropic-types.ts';

export const anthropicTextResponse: AnthropicMessageResponse = {
  content: [{ type: 'text', text: 'Hello from Anthropic!' }],
  usage: { input_tokens: 10, output_tokens: 5 },
  stop_reason: 'end_turn',
};

export const anthropicToolUseResponse: AnthropicMessageResponse = {
  content: [
    {
      type: 'tool_use',
      id: 'toolu_01',
      name: 'get_weather',
      input: { location: 'San Francisco' },
    },
  ],
  usage: { input_tokens: 15, output_tokens: 20 },
  stop_reason: 'tool_use',
};

export const anthropicMixedResponse: AnthropicMessageResponse = {
  content: [
    { type: 'text', text: 'Let me check the weather.' },
    {
      type: 'tool_use',
      id: 'toolu_02',
      name: 'get_weather',
      input: { location: 'New York' },
    },
  ],
  usage: { input_tokens: 20, output_tokens: 25 },
  stop_reason: 'tool_use',
};

export const anthropicNoUsageResponse: AnthropicMessageResponse = {
  content: [{ type: 'text', text: 'No usage info.' }],
  stop_reason: 'end_turn',
};

export const anthropicStreamTextEvents: AnthropicStreamEvent[] = [
  {
    type: 'message_start',
    message: { usage: { input_tokens: 10, output_tokens: 0 } },
  },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Hello ' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'from Anthropic!' },
  },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 5 },
  },
  { type: 'message_stop' },
];

export const anthropicStreamToolUseEvents: AnthropicStreamEvent[] = [
  {
    type: 'message_start',
    message: { usage: { input_tokens: 15, output_tokens: 0 } },
  },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'toolu_01', name: 'get_weather' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '{"location":' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '"San Francisco"}' },
  },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use' },
    usage: { output_tokens: 20 },
  },
  { type: 'message_stop' },
];

export const anthropicStreamMixedEvents: AnthropicStreamEvent[] = [
  {
    type: 'message_start',
    message: { usage: { input_tokens: 20, output_tokens: 0 } },
  },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Let me check.' },
  },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'toolu_mixed_01', name: 'get_weather' },
  },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"location":"New York"}' },
  },
  { type: 'content_block_stop', index: 1 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use' },
    usage: { output_tokens: 25 },
  },
  { type: 'message_stop' },
];

export const anthropicStreamEmptyEvents: AnthropicStreamEvent[] = [
  {
    type: 'message_start',
    message: { usage: { input_tokens: 5, output_tokens: 0 } },
  },
  {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 0 },
  },
  { type: 'message_stop' },
];

export const anthropicStreamMultiToolEvents: AnthropicStreamEvent[] = [
  {
    type: 'message_start',
    message: { usage: { input_tokens: 25, output_tokens: 0 } },
  },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'toolu_multi_01', name: 'get_weather' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '{"location":"Paris"}' },
  },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'toolu_multi_02', name: 'get_weather' },
  },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"location":"London"}' },
  },
  { type: 'content_block_stop', index: 1 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use' },
    usage: { output_tokens: 30 },
  },
  { type: 'message_stop' },
];
