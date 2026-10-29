import type { OpenAIChatCompletion, OpenAIChatCompletionChunk } from '../openai-types.ts';

export const openAITextResponse: OpenAIChatCompletion = {
  choices: [
    {
      message: { content: 'Hello from OpenAI!' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

export const openAIToolCallResponse: OpenAIChatCompletion = {
  choices: [
    {
      message: {
        content: null,
        tool_calls: [
          {
            id: 'call_01',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: '{"location":"San Francisco"}',
            },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 15, completion_tokens: 20, total_tokens: 35 },
};

export const openAIMixedResponse: OpenAIChatCompletion = {
  choices: [
    {
      message: {
        content: 'Let me check the weather.',
        tool_calls: [
          {
            id: 'call_02',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: '{"location":"New York"}',
            },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 20, completion_tokens: 25, total_tokens: 45 },
};

export const openAINoUsageResponse: OpenAIChatCompletion = {
  choices: [
    {
      message: { content: 'No usage info.' },
      finish_reason: 'stop',
    },
  ],
};

export const openAIStreamTextChunks: OpenAIChatCompletionChunk[] = [
  { choices: [{ delta: { content: 'Hello ' }, finish_reason: null }], usage: null },
  { choices: [{ delta: { content: 'from OpenAI!' }, finish_reason: null }], usage: null },
  {
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  },
];

export const openAIStreamToolCallChunks: OpenAIChatCompletionChunk[] = [
  {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_01',
              type: 'function',
              function: { name: 'get_weather', arguments: '' },
            },
          ],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  },
  {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, function: { arguments: '{"location":' } }],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  },
  {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, function: { arguments: '"San Francisco"}' } }],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  },
  {
    choices: [{ delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 15, completion_tokens: 20, total_tokens: 35 },
  },
];

export const openAIStreamMixedChunks: OpenAIChatCompletionChunk[] = [
  { choices: [{ delta: { content: 'Checking ' }, finish_reason: null }], usage: null },
  { choices: [{ delta: { content: 'weather.' }, finish_reason: null }], usage: null },
  {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_mixed_01',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"location":' },
            },
          ],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  },
  {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, function: { arguments: '"NYC"}' } }],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  },
  {
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  },
];

export const openAIStreamEmptyChunks: OpenAIChatCompletionChunk[] = [
  {
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
  },
];

export const openAIStreamMultiToolChunks: OpenAIChatCompletionChunk[] = [
  {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_multi_01',
              type: 'function',
              function: { name: 'get_weather', arguments: '' },
            },
          ],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  },
  {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, function: { arguments: '{"location":"Paris"}' } }],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  },
  {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 1,
              id: 'call_multi_02',
              type: 'function',
              function: { name: 'get_weather', arguments: '' },
            },
          ],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  },
  {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 1, function: { arguments: '{"location":"London"}' } }],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  },
  {
    choices: [{ delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 25, completion_tokens: 30, total_tokens: 55 },
  },
];
