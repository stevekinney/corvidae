# Provider Adapters

## Overview

Export tools as static JSON Schema definitions for use with LLM provider SDKs. Each adapter is available from the `@corvidae/armorer` entry point.

These adapters are **schema-only converters**. They serialize your tool definitions (name, description, and Zod schema) into the JSON format each provider expects, but they do not execute tools or handle results. You pass the output directly to the provider SDK when making API calls.

If tools define `availability` hooks, prefer the async toolbox exporters (`await toolbox.toOpenAITools()`, `await toolbox.toAnthropicTools()`, `await toolbox.toGeminiTools()`, or `await toolbox.toProvider(...)`). Those methods evaluate availability against the toolbox context and omit unavailable tools from provider manifests. The direct adapter functions remain synchronous schema converters and do not evaluate runtime hooks.

### OpenAI

```typescript
import { toOpenAITools } from '@corvidae/armorer';

// Single tool
const openAITool = toOpenAITools(myTool);

// Multiple tools
const openAITools = toOpenAITools([tool1, tool2]);

// From a toolbox, applying availability filters
const openAITools = await toolbox.toOpenAITools();

// Use with OpenAI SDK
const response = await openai.chat.completions.create({
  model: 'gpt-4',
  messages,
  tools: await toolbox.toOpenAITools(),
});
```

> **OpenAI Chat Completions vs OpenAI Agents SDK**: The `toOpenAITools()` adapter here produces static tool definitions for the [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat). If you're building with the **OpenAI Agents SDK** (`@openai/agents`), use the separate [OpenAI Agents adapter](./openai-agents-sdk.md) (`@corvidae/armorer`) instead. It produces executable tool objects with result handling and tool gating.

### Anthropic

```typescript
import { toAnthropicTools } from '@corvidae/armorer';

// Single tool
const anthropicTool = toAnthropicTools(myTool);

// Multiple tools
const anthropicTools = toAnthropicTools([tool1, tool2]);

// From a toolbox, applying availability filters
const anthropicTools = await toolbox.toAnthropicTools();

// Use with Anthropic SDK
const response = await anthropic.messages.create({
  model: 'claude-sonnet-4-20250514',
  messages,
  tools: await toolbox.toAnthropicTools(),
});
```

### Google Gemini

```typescript
import { toGeminiTools } from '@corvidae/armorer';

// Single tool
const geminiTools = toGeminiTools(myTool);

// Multiple tools
const geminiTools = toGeminiTools([tool1, tool2]);

// From a toolbox, applying availability filters
const geminiTools = await toolbox.toGeminiTools();

// Use with Gemini SDK
const response = await client.models.generateContent({
  model: 'gemini-pro',
  contents,
  config: { tools: await toolbox.toGeminiTools() },
});
```
