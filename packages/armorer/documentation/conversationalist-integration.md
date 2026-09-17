# Using `armorer` with `conversationalist`

`armorer` and `conversationalist` now share a deliberate tool-loop boundary:

- `armorer` owns tool schemas, provider tool definitions, provider tool-call parsing, and tool execution.
- `conversationalist` owns persistent conversation state, message history, serialization, and provider message formatting.

The canonical loop is the same for every provider:

1. Convert the current conversation into provider messages with `@repo/conversationalist`.
2. Convert the toolbox into provider tool definitions with `@repo/armorer`.
3. Call the provider SDK.
4. Parse the provider tool calls with `@repo/armorer`.
5. Append those calls to the conversation with `appendToolCalls(...)`.
6. Execute them with `toolbox.execute(...)`.
7. Append the results with `appendToolResults(...)` or `appendToolResultsAsync(...)`.
8. Repeat until the provider stops calling tools.

## OpenAI

```ts
import {
  appendToolCalls,
  appendToolResultsAsync,
  appendUserMessage,
  createConversationHistory,
} from '@repo/conversationalist';
import { toOpenAIMessagesGrouped } from '@repo/conversationalist';
import { createToolbox } from '@repo/armorer';
import { parseOpenAIToolCalls, toOpenAITools } from '@repo/armorer';

let conversation = createConversationHistory({ title: 'Weather' });
conversation = appendUserMessage(conversation, 'What is the weather in Denver?');

const tools = toOpenAITools(toolbox);
const messages = toOpenAIMessagesGrouped(conversation);
const completion = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages,
  tools,
});

const toolCalls = parseOpenAIToolCalls(completion.choices[0]?.message?.tool_calls);
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
} from '@repo/conversationalist';
import { toAnthropicMessagesForSdk } from '@repo/conversationalist';
import { createToolbox } from '@repo/armorer';
import { parseAnthropicToolCalls, toAnthropicTools } from '@repo/armorer';

let conversation = createConversationHistory({ title: 'Weather' });
conversation = appendUserMessage(conversation, 'Use the weather tool for Denver.');

const { system, messages } = toAnthropicMessagesForSdk(conversation);
const response = await anthropic.messages.create({
  model: 'claude-sonnet-4-20250514',
  system,
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
} from '@repo/conversationalist';
import { toGeminiMessages } from '@repo/conversationalist';
import { createToolbox } from '@repo/armorer';
import { parseGeminiToolCalls, toGeminiTools } from '@repo/armorer';

let conversation = createConversationHistory({ title: 'Weather' });
conversation = appendUserMessage(conversation, 'Stream the weather for Denver.');

const { systemInstruction, contents } = toGeminiMessages(conversation);
const response = await model.generateContent({
  systemInstruction,
  contents,
  tools: toGeminiTools(toolbox),
});

const parsedCalls = parseGeminiToolCalls(response.response.candidates?.[0]?.content?.parts ?? []);
const toolCalls = parsedCalls.map((toolCall, index) => ({
  ...toolCall,
  id: `call-gemini-${index + 1}`,
}));

conversation = appendToolCalls(conversation, toolCalls);

const results = await toolbox.execute(toolCalls, { stream: true });
conversation = await appendToolResultsAsync(conversation, results);
```
