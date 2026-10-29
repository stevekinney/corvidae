import type { GeminiGenerateContentResult } from '../gemini-types.ts';

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

export const geminiNoUsageResponse: GeminiGenerateContentResult = {
  candidates: [
    {
      content: {
        parts: [{ text: 'No usage info.' }],
      },
    },
  ],
};

export const geminiStreamTextChunks: GeminiGenerateContentResult[] = [
  {
    candidates: [{ content: { parts: [{ text: 'Hello ' }] } }],
  },
  {
    candidates: [{ content: { parts: [{ text: 'from Gemini!' }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  },
];

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

export const geminiStreamEmptyChunks: GeminiGenerateContentResult[] = [
  {
    candidates: [],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0, totalTokenCount: 5 },
  },
];

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
