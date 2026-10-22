# Using `armorer` with `conversationalist`

`armorer` and `conversationalist` now share a deliberate tool-loop boundary:

- `armorer` owns tool schemas, provider tool definitions, provider tool-call parsing, and tool execution.
- `conversationalist` owns persistent conversation state, message history, serialization, and provider message formatting.

The canonical loop is the same for every provider:

1. Convert the current conversation into provider messages with `conversationalist`.
2. Convert the toolbox into provider tool definitions with `armorer`.
3. Call the provider SDK.
4. Parse the provider tool calls with `armorer`.
5. Append those calls to the conversation with `appendToolCalls(...)`.
6. Execute them with `toolbox.execute(...)`.
7. Append the results with `appendToolResults(...)` or `appendToolResultsAsync(...)`.
8. Repeat until the provider stops calling tools.

The examples below share one toolbox:

```ts file=weather-toolbox.ts
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

const getWeather = createTool({
  name: 'get-weather',
  description: 'Get the current weather for a city',
  input: z.object({ city: z.string() }),
  async execute({ city }) {
    return { city, forecast: 'sunny' };
  },
});

export const toolbox = createToolbox([getWeather]);
```

## OpenAI

```ts
import {
  appendToolCalls,
  appendToolResultsAsync,
  appendUserMessage,
  createConversationHistory,
} from 'conversationalist';
import { toOpenAIMessagesGrouped } from 'conversationalist';
import { parseOpenAIToolCalls, toOpenAITools } from 'armorer';
import OpenAI from 'openai';
import { toolbox } from './weather-toolbox.ts';

const openai = new OpenAI();

let conversation = createConversationHistory({ title: 'Weather' });
conversation = appendUserMessage(conversation, 'What is the weather in Denver?');

const tools = toOpenAITools(toolbox);
const { messages } = toOpenAIMessagesGrouped(conversation);
const completion = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages,
  tools,
});

// Armorer tools are function tools, so parse only the function tool calls.
const functionToolCalls = completion.choices[0]?.message?.tool_calls?.filter(
  (toolCall) => toolCall.type === 'function',
);
const toolCalls = parseOpenAIToolCalls(functionToolCalls);
conversation = appendToolCalls(conversation, toolCalls);

const results = await toolbox.execute(toolCalls, { stream: true });
conversation = await appendToolResultsAsync(conversation, results);
```

## Anthropic

```ts
import {
  appendToolCalls,
  appendToolResults,
  appendUserMessage,
  createConversationHistory,
} from 'conversationalist';
import { toAnthropicMessagesForSdk } from 'conversationalist/adapters/anthropic/sdk';
import { parseAnthropicToolCalls, toAnthropicTools } from 'armorer';
import Anthropic from '@anthropic-ai/sdk';
import { toolbox } from './weather-toolbox.ts';

const anthropic = new Anthropic();

let conversation = createConversationHistory({ title: 'Weather' });
conversation = appendUserMessage(conversation, 'Use the weather tool for Denver.');

const { system, messages } = toAnthropicMessagesForSdk(conversation);
const response = await anthropic.messages.create({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 1024,
  ...(system === undefined ? {} : { system }),
  messages,
  tools: toAnthropicTools(toolbox),
});

const toolCalls = parseAnthropicToolCalls(response.content);
conversation = appendToolCalls(conversation, toolCalls);

const results = await toolbox.execute(toolCalls);
conversation = appendToolResults(conversation, results);
```

## Gemini

Gemini function calls do not include stable call IDs, so assign them before you append the calls and before you execute them.

```ts
import {
  appendToolCalls,
  appendToolResultsAsync,
  appendUserMessage,
  createConversationHistory,
} from 'conversationalist';
import { toGeminiMessages } from 'conversationalist';
import { parseGeminiToolCalls, toGeminiTools } from 'armorer';
import { GoogleGenAI } from '@google/genai';
import { toolbox } from './weather-toolbox.ts';

const client = new GoogleGenAI({});

let conversation = createConversationHistory({ title: 'Weather' });
conversation = appendUserMessage(conversation, 'Stream the weather for Denver.');

const { systemInstruction, contents } = toGeminiMessages(conversation);
const response = await client.models.generateContent({
  model: 'gemini-2.5-flash',
  contents,
  config: { ...(systemInstruction ? { systemInstruction } : {}), tools: toGeminiTools(toolbox) },
});

const parsedCalls = parseGeminiToolCalls(response.candidates?.[0]?.content?.parts ?? []);
const toolCalls = parsedCalls.map((toolCall, index) => ({
  ...toolCall,
  id: `call-gemini-${index + 1}`,
}));

conversation = appendToolCalls(conversation, toolCalls);

const results = await toolbox.execute(toolCalls, { stream: true });
conversation = await appendToolResultsAsync(conversation, results);
```
