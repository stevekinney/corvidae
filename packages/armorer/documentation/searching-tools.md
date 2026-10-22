# Querying Tools

## Overview

Toolbox uses `queryTools(...)` for programmatic tool discovery.

- Filter by tags, text, schema keys, metadata, and custom predicates.
- Works with a toolbox, a single tool, or any iterable of tools.
- Supports semantic text matching when the toolbox has an `embed` function.

Import from `armorer`:

```typescript
import { queryTools } from 'armorer';
```

## Quick Start

```typescript
import { createToolbox } from 'armorer';
import { queryTools } from 'armorer';

const toolbox = createToolbox();

const communicationTools = queryTools(toolbox, {
  tags: { any: ['communication'] },
});

const nonDangerous = queryTools(toolbox, {
  tags: { none: ['dangerous'] },
});
```

## Query Criteria

```typescript
import { createTool, createToolbox, queryTools } from 'armorer';
import { z } from 'zod';

const sendMessage = createTool({
  name: 'send-message',
  description: 'Send a message to a recipient',
  input: z.object({ recipient: z.string(), subject: z.string(), body: z.string() }),
  tags: ['communication'],
  metadata: { tier: 'premium' },
  async execute() {
    return { sent: true };
  },
});

const toolbox = createToolbox([sendMessage]);

const byText = queryTools(toolbox, {
  text: { query: 'send message', mode: 'fuzzy', threshold: 0.6 },
});

const bySchemaKeys = queryTools(toolbox, {
  schema: { keys: ['recipient', 'subject'] },
});

const bySchemaShape = queryTools(toolbox, {
  schema: { matches: z.object({ recipient: z.string() }) },
});

const byMetadata = queryTools(toolbox, {
  metadata: { eq: { tier: 'premium' } },
});

const booleanGroups = queryTools(toolbox, {
  and: [{ tags: { any: ['communication'] } }],
  or: [{ text: 'email' }, { text: 'sms' }],
  not: { tags: { any: ['deprecated'] } },
});
```

## Embeddings

When `createToolbox` is configured with `embed`, a `fuzzy` `text` query also matches tools whose embeddings are similar to the query's, at or above the query's `threshold` (0.7 by default).

`queryTools` and `searchTools` are synchronous, so they read only embeddings that have already resolved. With an asynchronous `embed` function, a tool's embeddings are pending until the embedder returns, and a query's embedding is requested by the first call that uses that query text; until both resolve, the call matches by text alone. Await `awaitToolEmbeddings(tool)` for each tool before querying, and expect the first call for a new query text to fall back to text matching. [`createSearchTool`](search-tool.md) waits for both, so its first search already uses embeddings.

```typescript
import { createToolbox } from 'armorer';
import { queryTools } from 'armorer';

declare const embeddingClient: { embed(texts: string[]): Promise<number[][]> };

const toolbox = createToolbox([], {
  embed: async (texts) => embeddingClient.embed(texts),
});

const matches = queryTools(toolbox, {
  text: { query: 'notify customer about shipment delay', mode: 'fuzzy' },
  tags: { any: ['communication'] },
});
```

## Type Safety and IntelliSense

`queryTools` is generic over the toolbox’s concrete tool set:

- `tags.any/all/none` get IntelliSense from known tool tags.
- `schema.keys` gets IntelliSense from known input schema keys.
- Result shapes stay typed when you use `select`.

This is especially helpful when your toolbox is created from `as const` tool entries.

## Selection and Pagination

```typescript
import { queryTools, type Toolbox } from 'armorer';

declare const toolbox: Toolbox;

const summaries = queryTools(toolbox, {
  select: 'summary',
  includeSchema: true,
  includeToolConfiguration: false,
  offset: 10,
  limit: 10,
});

const names = queryTools(toolbox, { select: 'name' });
```

## Events

Calling `queryTools` with a toolbox emits a `query` event on that toolbox.

See [Eventing](eventing.md) for subscription patterns.
