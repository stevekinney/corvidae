# Search Tools Tool

## Overview

Toolbox provides a pre-configured `search-tools` tool that enables semantic discovery of registered tools. This is particularly useful for:

- **Agentic workflows**: Where the LLM needs to discover which tools are available for a task
- **Large tool registries**: When you have many tools and don't want to pass all of them in every request
- **Meta-tools**: Building assistants that help users find the right tool for their task

The search tool works both with and without vector embeddings:

- **With embeddings**: Also matches and ranks tools by embedding similarity, so a query such as "notify someone" can find `send-email` when the embedding model places them close together
- **Without embeddings**: Matches by fuzzy text on names, descriptions, tags, and schema and metadata keys

Either way it searches with [`searchTools`](searching-tools.md), filtered to the query's fuzzy text matches (and any `tags`), and returns the matches in `searchTools`' ranked order with its scores.

## Installation

The search tools tool is available via the `armorer` export:

```typescript
import { createSearchTool } from 'armorer';
```

## Basic Usage

```typescript
import { createToolbox, createTool } from 'armorer';
import { createSearchTool } from 'armorer';
import { z } from 'zod';

const sendEmail = createTool({
  name: 'send-email',
  description: 'Send an email message to one or more recipients',
  input: z.object({
    to: z.array(z.string().email()),
    subject: z.string(),
    body: z.string(),
  }),
  tags: ['communication', 'email'],
  async execute({ to, subject, body }) {
    console.log(`Sending email to ${to.join(', ')}`);
    return { sent: true };
  },
});

const scheduleMeeting = createTool({
  name: 'schedule-meeting',
  description: 'Create a calendar event and invite attendees',
  input: z.object({
    title: z.string(),
    startTime: z.string().datetime(),
    attendees: z.array(z.string().email()),
  }),
  tags: ['calendar', 'scheduling'],
  async execute({ title }) {
    return { scheduled: true, eventId: 'evt_123' };
  },
});

// Create a toolbox with some tools
const toolbox = createToolbox([sendEmail, scheduleMeeting]);

// Create a search tool that searches that toolbox
const searchTool = createSearchTool(toolbox);

// Search for tools
const results = await searchTool({ query: 'send message' });
console.log(results);
// [
//   {
//     name: 'send-email',
//     description: 'Send an email message to one or more recipients',
//     tags: ['communication', 'email'],
//     score: 3,
//   },
// ]
```

Without embeddings, only tools whose text matches the query are returned: `schedule-meeting` shares no words with "send message", and a query such as "contact someone" returns `[]` because neither tool mentions contacting.

## With Semantic Search (Embeddings)

For better search results, configure your toolbox with an embedding function. The search tool uses the toolbox's `embed` function and any vectors stored with `registerToolEmbeddings`:

```typescript
import { createToolbox } from 'armorer';
import { createSearchTool } from 'armorer';
import OpenAI from 'openai';

const openai = new OpenAI();

const toolbox = createToolbox([], {
  embed: async (texts) => {
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: texts,
    });
    return response.data.map((item) => item.embedding);
  },
});

// Register tools...

// Create search tool
const searchTool = createSearchTool(toolbox, { explain: true });

// Semantic search can find tools that share no words with the query
const results = await searchTool({ query: 'notify user about something' });
// With a registered `send-email` tool that the embedding model places close to the query:
// [{ name: 'send-email', ..., score: 0.95, reasons: ['embedding:name:0.95'] }]
```

A tool matches when its text matches the query or when the cosine similarity between the query's embedding and one of the tool's field embeddings reaches the fuzzy threshold (0.7 by default). Each embedding match adds the best field's similarity, weighted by that field, to the score and reports it as an `embedding:<field>:<similarity>` reason. The search tool waits for an asynchronous `embed` function to finish embedding the query and the tools before it searches, so embeddings apply from the first call.

## Configuration Options

```typescript
interface CreateSearchToolOptions {
  /** Default maximum number of tools to return. @default 10 */
  limit?: number;

  /** Include matching reasons in results for debugging. @default false */
  explain?: boolean;

  /** Custom name for the tool. @default 'search-tools' */
  name?: string;

  /** Custom description for the tool. */
  description?: string;

  /** Additional tags to add to the tool. */
  tags?: string[];
}
```

### Example with Options

```typescript
import { createSearchTool, type AnyToolbox } from 'armorer';

declare const toolbox: AnyToolbox;

const searchTool = createSearchTool(toolbox, {
  limit: 5, // Return at most 5 tools
  explain: true, // Include match reasons
  name: 'find-tools', // Custom tool name
  tags: ['meta'], // Additional tags
});

const results = await searchTool({ query: 'send message' });
// Results include reasons when explain is true:
// [
//   {
//     name: 'send-email',
//     description: 'Send an email message to one or more recipients',
//     tags: ['communication', 'email'],
//     score: 3,
//     reasons: ['text:name', 'text:description'],
//   },
// ]
```

## Search Input Parameters

The search tool accepts these parameters:

| Parameter | Type       | Required | Description                                          |
| --------- | ---------- | -------- | ---------------------------------------------------- |
| `query`   | `string`   | Yes      | The search query to find relevant tools              |
| `limit`   | `number`   | No       | Override the default limit for this search           |
| `tags`    | `string[]` | No       | Filter to tools that have at least one of these tags |

### Filtering by Tags

```typescript
import type { SearchTool } from 'armorer';

declare const searchTool: SearchTool;

// Find only communication-related tools
const results = await searchTool({
  query: 'send something',
  tags: ['communication', 'messaging'],
});
```

## Search Results

Each result contains:

| Field         | Type       | Description                                    |
| ------------- | ---------- | ---------------------------------------------- |
| `name`        | `string`   | The tool's name                                |
| `description` | `string`   | The tool's description                         |
| `tags`        | `string[]` | Tags associated with the tool (if any)         |
| `score`       | `number`   | Relevance score (higher is more relevant)      |
| `reasons`     | `string[]` | Match explanations (when `explain` is enabled) |

`score` is the `searchTools` ranking score, not a value between 0 and 1: each matching field, matching tag, and embedding match adds its weight, so compare scores within one result list rather than against a fixed cutoff. Results are sorted by score, highest first, with ties ordered by name.

`reasons` lists what contributed to the score, in this order:

- `tag:<tag>` for each `tags` filter value the tool carries
- `text:<field>` for each field the query text matched (`name`, `description`, `schemaKeys`, `metadataKeys`), and `text:tags(<tags>)` for matching tags
- `embedding:<field>:<similarity>` for the best embedding match, with the cosine similarity to two decimal places

## Dynamic Tool Discovery

The search tool reads `toolbox.getAvailable()` each time it runs, not when it is created, so results reflect each tool's current [availability](registry.md#availability). A tool whose `availability` hook returns `false` is left out of the results.

## Exposing the Search Tool to a Model

`createSearchTool(toolbox)` returns a standalone tool and does not add it to the toolbox. Toolboxes are immutable, so add it with `extend()` to get a toolbox the model can call it through:

```typescript
import { createSearchTool, createTool, createToolbox } from 'armorer';
import { z } from 'zod';

const toolbox = createToolbox([
  createTool({
    name: 'send-email',
    description: 'Send an email',
    input: z.object({ to: z.string(), body: z.string() }),
    async execute({ to, body }) {
      return { sent: true };
    },
  }),
]);

// The search tool searches `toolbox`; `withSearch` also exposes the search tool itself
const withSearch = toolbox.extend(createSearchTool(toolbox));

const results = await withSearch.execute({
  name: 'search-tools',
  arguments: { query: 'send' },
});
// Results include 'send-email'
```

## Using with Provider Adapters

The search tool integrates seamlessly with provider adapters:

```typescript
import { toOpenAITools, type AnyToolbox } from 'armorer';
import OpenAI from 'openai';

declare const withSearch: AnyToolbox;
declare const openai: OpenAI;

// Get all tools including the search tool
const tools = toOpenAITools(withSearch);

// Use with OpenAI
const response = await openai.chat.completions.create({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Find tools that can help me contact someone' }],
  tools,
});
```

## Agentic Workflow Example

Here's a complete example of using the search tool in an agentic workflow:

```typescript
import { createToolbox, createTool } from 'armorer';
import { createSearchTool } from 'armorer';
import { toOpenAITools } from 'armorer';
import OpenAI from 'openai';
import { z } from 'zod';

const openai = new OpenAI();

// Define your tools
const sendEmail = createTool({
  name: 'send-email',
  description: 'Send an email to recipients',
  input: z.object({
    to: z.array(z.string().email()),
    subject: z.string(),
    body: z.string(),
  }),
  tags: ['communication'],
  async execute({ to, subject, body }) {
    // Implementation
    return { sent: true };
  },
});

const getContacts = createTool({
  name: 'get-contacts',
  description: 'Retrieve contact information',
  input: z.object({
    filter: z.string().optional(),
  }),
  tags: ['contacts', 'readonly'],
  async execute({ filter }) {
    // Implementation
    return [{ name: 'John', email: 'john@example.com' }];
  },
});

// Create toolbox with embeddings for semantic search
const tools = createToolbox([sendEmail, getContacts], {
  embed: async (texts) => {
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: texts,
    });
    return response.data.map((item) => item.embedding);
  },
});

// Add the search tool
const toolbox = tools.extend(createSearchTool(tools, { explain: true }));

// Agent loop
async function runAgent(userMessage: string) {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: `You are a helpful assistant with access to various tools.

If you're not sure which tool to use, use the search-tools tool to find relevant tools.
Always explain which tools you found and why you chose the one you're using.`,
    },
    { role: 'user', content: userMessage },
  ];

  while (true) {
    const response = await openai.chat.completions.create({
      model: 'gpt-4',
      messages,
      tools: toOpenAITools(toolbox),
    });

    const choice = response.choices[0];
    if (!choice) break;

    if (choice.finish_reason === 'stop') {
      console.log('Assistant:', choice.message?.content);
      break;
    }

    if (choice.message?.tool_calls) {
      messages.push(choice.message);

      for (const toolCall of choice.message.tool_calls) {
        if (toolCall.type !== 'function') continue;
        const result = await toolbox.execute({
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: JSON.parse(toolCall.function.arguments),
        });

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result.result ?? result.error),
        });
      }
    }
  }
}

// Example: The agent will first search for tools, then use the appropriate one
runAgent('I need to notify John about the meeting tomorrow');
```

## Best Practices

1. **Use embeddings for better results**: Semantic search significantly improves tool discovery, especially when queries don't match exact keywords.

2. **Add descriptive tool descriptions**: The search tool relies on tool names, descriptions, and tags. Better metadata means better search results.

3. **Use consistent tags**: Establish a tagging convention across your tools (e.g., `communication`, `database`, `file-system`) to enable tag-based filtering.

4. **Enable explain for debugging**: When developing or troubleshooting, enable `explain: true` to see why tools are being matched.

5. **Consider the search tool count**: The search tool counts against your tool limit if you're using provider-specific limits. Factor this in when designing your tool set.

## Related Documentation

- [Searching Tools](searching-tools.md) - Programmatic `queryTools` guide
- [Embeddings & Semantic Search](embeddings.md) - Configure embeddings for semantic search
- [Toolbox Registry](registry.md) - Learn about `queryTools`
- [Provider Adapters](provider-adapters.md) - Use tools with OpenAI, Anthropic, and Gemini
