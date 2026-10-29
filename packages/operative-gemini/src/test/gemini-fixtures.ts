import type { GeminiGenerateContentResult } from '../gemini-types.ts';

/** A response with one text part and usage. */
export const geminiTextResponse: GeminiGenerateContentResult = {
  candidates: [
    {
      content: {
        parts: [{ text: 'Hello from Gemini!' }],
      },
    },
  ],
  usageMetadata: {
    promptTokenCount: 10,
    candidatesTokenCount: 5,
    totalTokenCount: 15,
  },
};

/** A response with one `get_weather` function call and usage. */
export const geminiFunctionCallResponse: GeminiGenerateContentResult = {
  candidates: [
    {
      content: {
        parts: [
          {
            functionCall: {
              name: 'get_weather',
              args: { location: 'San Francisco' },
            },
          },
        ],
      },
    },
  ],
  usageMetadata: {
    promptTokenCount: 15,
    candidatesTokenCount: 20,
    totalTokenCount: 35,
  },
};

/** A response with a text part followed by a `get_weather` function call, and usage. */
export const geminiMixedResponse: GeminiGenerateContentResult = {
  candidates: [
    {
      content: {
        parts: [
          { text: 'Let me check the weather.' },
          {
            functionCall: {
              name: 'get_weather',
              args: { location: 'New York' },
            },
          },
        ],
      },
    },
  ],
  usageMetadata: {
    promptTokenCount: 20,
    candidatesTokenCount: 25,
    totalTokenCount: 45,
  },
};

/** A response with one text part and no usage metadata. */
export const geminiNoUsageResponse: GeminiGenerateContentResult = {
  candidates: [
    {
      content: {
        parts: [{ text: 'No usage info.' }],
      },
    },
  ],
};

/** Two streamed chunks of text, with usage on the last. */
export const geminiStreamTextChunks: GeminiGenerateContentResult[] = [
  {
    candidates: [{ content: { parts: [{ text: 'Hello ' }] } }],
  },
  {
    candidates: [{ content: { parts: [{ text: 'from Gemini!' }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  },
];

/** One streamed chunk carrying a `get_weather` function call and usage. */
export const geminiStreamFunctionCallChunks: GeminiGenerateContentResult[] = [
  {
    candidates: [
      {
        content: {
          parts: [{ functionCall: { name: 'get_weather', args: { location: 'San Francisco' } } }],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 20, totalTokenCount: 35 },
  },
];

/** One streamed chunk carrying text and a `get_weather` function call, and usage. */
export const geminiStreamMixedChunks: GeminiGenerateContentResult[] = [
  {
    candidates: [
      {
        content: {
          parts: [
            { text: 'Checking weather...' },
            { functionCall: { name: 'get_weather', args: { location: 'Tokyo' } } },
          ],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 },
  },
];

/** One streamed chunk with no candidates and usage only. */
export const geminiStreamEmptyChunks: GeminiGenerateContentResult[] = [
  {
    candidates: [],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0, totalTokenCount: 5 },
  },
];

/** One streamed chunk carrying two `get_weather` function calls and usage. */
export const geminiStreamMultiFunctionCallChunks: GeminiGenerateContentResult[] = [
  {
    candidates: [
      {
        content: {
          parts: [
            { functionCall: { name: 'get_weather', args: { location: 'Paris' } } },
            { functionCall: { name: 'get_weather', args: { location: 'London' } } },
          ],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 25, candidatesTokenCount: 30, totalTokenCount: 55 },
  },
];
