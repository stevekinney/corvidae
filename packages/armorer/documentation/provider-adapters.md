# Provider Adapters

## Overview

Export tools as static JSON Schema definitions for use with [OpenAI](https://platform.openai.com/docs/api-reference), [Anthropic](https://docs.anthropic.com/en/api/messages), and [Google Gemini](https://ai.google.dev/gemini-api/docs) SDKs. Each adapter is available from the `armorer` entry point.

These adapters are **schema-only converters**. They serialize your tool definitions (name, description, and Zod schema) into the JSON format each provider expects, but they do not execute tools or handle results. You pass the output directly to the provider SDK when making API calls.

If tools define `availability` hooks, prefer the async toolbox exporters (`await toolbox.toOpenAITools()`, `await toolbox.toAnthropicTools()`, `await toolbox.toGeminiTools()`, or `await toolbox.toProvider(...)`). Those methods evaluate availability against the toolbox context and omit unavailable tools from provider manifests. The direct adapter functions remain synchronous schema converters and do not evaluate runtime hooks.

### OpenAI

```typescript
import { toOpenAITools, type AnyToolbox, type Tool } from 'armorer';

declare const myTool: Tool, tool1: Tool, tool2: Tool;
declare const toolbox: AnyToolbox;

// Single tool
const openAITool = toOpenAITools(myTool);

// Multiple tools
const openAITools = toOpenAITools([tool1, tool2]);

// From a toolbox, applying availability filters
const availableOpenAITools = await toolbox.toOpenAITools();
```

```typescript
import OpenAI from 'openai';
import type { AnyToolbox } from 'armorer';

declare const toolbox: AnyToolbox;
declare const messages: OpenAI.Chat.ChatCompletionMessageParam[];
const openai = new OpenAI();

// Use with OpenAI SDK
const response = await openai.chat.completions.create({
  model: 'gpt-4',
  messages,
  tools: await toolbox.toOpenAITools(),
});
```

> **OpenAI Chat Completions vs OpenAI Agents SDK**: The `toOpenAITools()` adapter here produces static tool definitions for the [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat). If you're building with the **OpenAI Agents SDK** (`@openai/agents`), use the separate [OpenAI Agents adapter](./openai-agents-sdk.md) (`armorer/open-ai/agents`) instead. It produces executable tool objects with result handling and tool gating.

### Anthropic

```typescript
import { toAnthropicTools, type AnyToolbox, type Tool } from 'armorer';

declare const myTool: Tool, tool1: Tool, tool2: Tool;
declare const toolbox: AnyToolbox;

// Single tool
const anthropicTool = toAnthropicTools(myTool);

// Multiple tools
const anthropicTools = toAnthropicTools([tool1, tool2]);

// From a toolbox, applying availability filters
const availableAnthropicTools = await toolbox.toAnthropicTools();
```

```typescript
import Anthropic from '@anthropic-ai/sdk';
import type { AnyToolbox } from 'armorer';

declare const toolbox: AnyToolbox;
declare const messages: Anthropic.MessageParam[];
const anthropic = new Anthropic();

// Use with Anthropic SDK
const response = await anthropic.messages.create({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 1024,
  messages,
  tools: await toolbox.toAnthropicTools(),
});
```

### Google Gemini

```typescript
import { toGeminiTools, type AnyToolbox, type Tool } from 'armorer';

declare const myTool: Tool, tool1: Tool, tool2: Tool;
declare const toolbox: AnyToolbox;

// Single tool
const geminiTool = toGeminiTools(myTool);

// Multiple tools
const geminiTools = toGeminiTools([tool1, tool2]);

// From a toolbox, applying availability filters
const availableGeminiTools = await toolbox.toGeminiTools();
```

```typescript
import { GoogleGenAI, type Content } from '@google/genai';
import type { AnyToolbox } from 'armorer';

declare const toolbox: AnyToolbox;
declare const contents: Content[];
const client = new GoogleGenAI({});

// Use with Gemini SDK
const response = await client.models.generateContent({
  model: 'gemini-pro',
  contents,
  config: { tools: await toolbox.toGeminiTools() },
});
```
