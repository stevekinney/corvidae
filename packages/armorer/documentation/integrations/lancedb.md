# LanceDB Integration

## Overview

[LanceDB](https://lancedb.com/) is a serverless vector database that can run embedded (no separate server required) or as a cloud service. This makes it an excellent choice for local development, testing, and production deployments where you want to avoid infrastructure complexity.

This guide shows how to integrate LanceDB with Toolbox for semantic tool search.

## Setup

Install the required dependencies:

```bash
bun add @lancedb/lancedb openai apache-arrow
```

## The LanceDB Client Members These Examples Use

The examples below import LanceDB from a local `lancedb.ts` that declares only the members they call, so they type-check without `@lancedb/lancedb` installed. In your project, write `import * as lancedb from '@lancedb/lancedb'` instead.

```typescript file=lancedb.ts
export type LanceRecord = Record<string, unknown>;

export interface Query {
  limit(limit: number): Query;
  where(predicate: string): Query;
  select(columns: string[]): Query;
  toArray(): Promise<LanceRecord[]>;
}

export interface Table {
  add(data: LanceRecord[]): Promise<void>;
  delete(predicate: string): Promise<void>;
  search(vector: number[]): Query;
  query(): Query;
  countRows(filter?: string): Promise<number>;
}

export interface Connection {
  openTable(name: string): Promise<Table>;
  createTable(name: string, data: LanceRecord[]): Promise<Table>;
}

export declare function connect(uri: string, options?: { apiKey?: string }): Promise<Connection>;
```

## Basic LanceDB Integration

Here's a simple example using LanceDB for local vector storage:

```typescript file=basic.ts
import { createToolbox, type Tool } from 'armorer';
import OpenAI from 'openai';
import * as lancedb from './lancedb.ts';

// Your tools
declare const tools: readonly Tool[];

// Initialize OpenAI for embeddings
const openai = new OpenAI();

// Embedding function
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: texts,
  });

  return response.data.map((item) => item.embedding);
}

// Create toolbox with embedding support
export const toolbox = createToolbox(tools, { embed });

// Connect to LanceDB (creates a local database)
const db = await lancedb.connect('./data/lancedb');

// Create or open the tools table
let toolsTable: lancedb.Table;
try {
  toolsTable = await db.openTable('tools');
} catch {
  // Table doesn't exist, create it with initial schema
  toolsTable = await db.createTable('tools', [
    {
      id: 'placeholder',
      toolName: 'placeholder',
      field: 'name',
      text: 'placeholder',
      vector: new Array(1536).fill(0),
    },
  ]);
  // Remove the placeholder row
  await toolsTable.delete('id = "placeholder"');
}

export { toolsTable };
```

## Syncing Tools to LanceDB

Index the toolbox's tools in LanceDB once the toolbox is built:

```typescript
import { embed, toolbox, toolsTable } from './basic.ts';

for (const tool of toolbox.tools()) {
  // Generate embeddings for searchable fields
  const fields = [
    { field: 'name', text: tool.name },
    { field: 'description', text: tool.description },
    { field: 'tags', text: tool.tags?.join(' ') ?? '' },
  ].filter((f) => f.text);

  const embeddings = await embed(fields.map((f) => f.text));

  // Prepare records for LanceDB, pairing each field with its embedding
  const records = fields.flatMap((field, i) => {
    const vector = embeddings[i];
    return vector
      ? [
          {
            id: `${tool.name}:${field.field}`,
            toolName: tool.name,
            field: field.field,
            text: field.text,
            vector,
            tags: [...(tool.tags ?? [])],
          },
        ]
      : [];
  });

  // Delete existing records for this tool and insert new ones
  await toolsTable.delete(`toolName = "${tool.name}"`);
  await toolsTable.add(records);
}
```

## Semantic Search with LanceDB

LanceDB makes vector search simple with its built-in search API:

```typescript
import type { Tool } from 'armorer';
import { embed, toolbox, toolsTable } from './basic.ts';

async function searchTools(query: string, limit = 5): Promise<Tool[]> {
  // Generate embedding for the query
  const [queryEmbedding] = await embed([query]);
  if (!queryEmbedding) return [];

  // Search LanceDB
  const results = await toolsTable
    .search(queryEmbedding)
    .limit(limit * 3) // Get extra for deduplication
    .toArray();

  // Deduplicate by tool name and return tools
  const seen = new Set<string>();
  const tools: Tool[] = [];

  for (const result of results) {
    const toolName = result['toolName'];
    if (typeof toolName === 'string' && !seen.has(toolName)) {
      seen.add(toolName);
      const tool = toolbox.getTool(toolName);
      if (tool) {
        tools.push(tool);
      }
      if (tools.length >= limit) break;
    }
  }

  return tools;
}
```

## Full Example: LanceDB-backed Tool Registry

Here's a complete, production-ready example:

```typescript
import { createToolbox, createTool, queryTools, type Tool, type ToolQuery } from 'armorer';
import OpenAI from 'openai';
import { z } from 'zod';
import * as lancedb from './lancedb.ts';

// Configuration
const LANCEDB_PATH = './data/lancedb';
const TOOLS_TABLE = 'toolbox_tools';
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;

// Initialize OpenAI
const openai = new OpenAI();

// Embedding function
async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });

  return response.data.map((item) => item.embedding);
}

// Tool record schema for LanceDB
type ToolRecord = {
  id: string;
  toolName: string;
  field: string;
  text: string;
  vector: number[];
  tags: string[];
  metadata: string; // JSON-serialized metadata
};

// Embed a tool's searchable fields as one record per field
async function toToolRecords(tool: Tool): Promise<ToolRecord[]> {
  const fields = [
    { field: 'name', text: tool.name },
    { field: 'description', text: tool.description },
    { field: 'tags', text: tool.tags?.join(' ') ?? '' },
  ].filter((f) => f.text);

  const embeddings = await embed(fields.map((f) => f.text));

  return fields.flatMap((field, i) => {
    const vector = embeddings[i];
    return vector
      ? [
          {
            id: `${tool.name}:${field.field}`,
            toolName: tool.name,
            field: field.field,
            text: field.text,
            vector,
            tags: [...(tool.tags ?? [])],
            metadata: JSON.stringify(tool.metadata ?? {}),
          },
        ]
      : [];
  });
}

// Read the distinct tool names from LanceDB rows, in rank order
function toolNamesFrom(rows: readonly lancedb.LanceRecord[]): string[] {
  const names = new Set<string>();
  for (const row of rows) {
    const toolName = row['toolName'];
    if (typeof toolName === 'string') {
      names.add(toolName);
    }
  }
  return Array.from(names);
}

async function createLanceDBTable(db: lancedb.Connection): Promise<lancedb.Table> {
  try {
    return await db.openTable(TOOLS_TABLE);
  } catch {
    // Create table with schema
    const table = await db.createTable(TOOLS_TABLE, [
      {
        id: '__schema__',
        toolName: '',
        field: 'name',
        text: '',
        vector: new Array(EMBEDDING_DIMENSIONS).fill(0),
        tags: [],
        metadata: '{}',
      },
    ]);
    await table.delete('id = "__schema__"');
    return table;
  }
}

export async function createLanceDBToolRegistry(tools: readonly Tool[], dbPath = LANCEDB_PATH) {
  const db = await lancedb.connect(dbPath);
  const table = await createLanceDBTable(db);
  const toolbox = createToolbox(tools, { embed });

  // Index the toolbox's tools in LanceDB
  for (const tool of toolbox.tools()) {
    const records = await toToolRecords(tool);

    // Delete existing and insert new
    await table.delete(`toolName = "${tool.name}"`);
    await table.add(records);
  }

  // Map ranked tool names back to the toolbox's tools
  function toolsNamed(names: readonly string[], limit: number): Tool[] {
    return names
      .map((name) => toolbox.getTool(name))
      .filter((t): t is Tool => t !== undefined)
      .slice(0, limit);
  }

  return {
    toolbox,
    db,
    table,

    /**
     * Semantic search for tools using LanceDB
     */
    async search(query: string, limit = 10): Promise<Tool[]> {
      const [queryEmbedding] = await embed([query]);
      if (!queryEmbedding) return [];

      const results = await table
        .search(queryEmbedding)
        .limit(limit * 3)
        .toArray();

      return toolsNamed(toolNamesFrom(results), limit);
    },

    /**
     * Search with metadata filtering
     */
    async searchWithFilter(
      query: string,
      filter: { tags?: string[]; field?: string },
      limit = 10,
    ): Promise<Tool[]> {
      const [queryEmbedding] = await embed([query]);
      if (!queryEmbedding) return [];

      let searchQuery = table.search(queryEmbedding).limit(limit * 5);

      // Apply filters using LanceDB's SQL-like syntax
      const conditions: string[] = [];
      if (filter.field) {
        conditions.push(`field = "${filter.field}"`);
      }

      if (conditions.length > 0) {
        searchQuery = searchQuery.where(conditions.join(' AND '));
      }

      const results = await searchQuery.toArray();

      // Post-filter by tags if needed (LanceDB array filtering)
      const matching = results.filter((result) => {
        if (!filter.tags?.length) return true;
        const resultTags = result['tags'];
        if (!Array.isArray(resultTags)) return false;
        return filter.tags.every((tag) =>
          resultTags.some((t) => String(t).toLowerCase() === tag.toLowerCase()),
        );
      });

      return toolsNamed(toolNamesFrom(matching), limit);
    },

    /**
     * Hybrid search: LanceDB semantic + Toolbox filters
     */
    async hybridSearch(
      query: string,
      toolboxFilter?: Pick<ToolQuery, 'tags' | 'metadata'>,
      limit = 10,
    ): Promise<Tool[]> {
      // Get semantic candidates from LanceDB
      const [queryEmbedding] = await embed([query]);
      if (!queryEmbedding) return [];

      const results = await table
        .search(queryEmbedding)
        .limit(50) // Get more candidates for filtering
        .toArray();

      // Get tools and apply Toolbox filters
      const candidates = toolsNamed(toolNamesFrom(results), Infinity);

      if (!toolboxFilter) {
        return candidates.slice(0, limit);
      }

      return queryTools(candidates, { ...toolboxFilter, limit });
    },

    /**
     * Delete a tool from LanceDB
     */
    async deleteTool(toolName: string): Promise<void> {
      await table.delete(`toolName = "${toolName}"`);
    },

    /**
     * Rebuild all tool embeddings
     */
    async rebuildIndex(): Promise<void> {
      // Clear existing data
      await table.delete('id IS NOT NULL');

      // Re-embed all tools
      for (const tool of toolbox.tools()) {
        await table.add(await toToolRecords(tool));
      }
    },

    /**
     * Get database statistics
     */
    async stats(): Promise<{ toolCount: number; recordCount: number }> {
      const rows = await table.query().select(['toolName']).toArray();
      return {
        toolCount: toolNamesFrom(rows).length,
        recordCount: await table.countRows(),
      };
    },
  };
}

// Usage example
async function main() {
  // Define tools
  const sendEmail = createTool({
    name: 'send-email',
    description: 'Send an email message to one or more recipients',
    input: z.object({
      to: z.array(z.string().email()),
      subject: z.string(),
      body: z.string(),
    }),
    tags: ['communication', 'email', 'messaging'],
    metadata: { category: 'communication' },
    async execute({ to, subject, body }) {
      console.log(`Sending email to ${to.join(', ')}`);
      return { sent: true, recipients: to.length };
    },
  });

  const sendSms = createTool({
    name: 'send-sms',
    description: 'Send a text message to a phone number',
    input: z.object({
      phoneNumber: z.string(),
      message: z.string().max(160),
    }),
    tags: ['communication', 'sms', 'messaging'],
    metadata: { category: 'communication' },
    async execute({ phoneNumber, message }) {
      console.log(`Sending SMS to ${phoneNumber}`);
      return { sent: true };
    },
  });

  const scheduleMeeting = createTool({
    name: 'schedule-meeting',
    description: 'Create a calendar event and invite attendees',
    input: z.object({
      title: z.string(),
      startTime: z.string().datetime(),
      duration: z.number().describe('Duration in minutes'),
      attendees: z.array(z.string().email()),
    }),
    tags: ['calendar', 'scheduling', 'meetings'],
    metadata: { category: 'productivity' },
    async execute({ title }) {
      console.log(`Scheduling: ${title}`);
      return { scheduled: true, eventId: 'evt_123' };
    },
  });

  // Resolves once every tool is indexed in LanceDB
  const { search, hybridSearch } = await createLanceDBToolRegistry([
    sendEmail,
    sendSms,
    scheduleMeeting,
  ]);

  // Semantic search
  console.log('\n--- Semantic Search: "notify someone" ---');
  const notifyTools = await search('notify someone about something');
  console.log(
    'Found:',
    notifyTools.map((t) => t.name),
  );
  // Output: ['send-email', 'send-sms']

  // Hybrid search with filters
  console.log('\n--- Hybrid Search: "contact" with communication tag ---');
  const contactTools = await hybridSearch('contact a person', {
    tags: { any: ['communication'] },
  });
  console.log(
    'Found:',
    contactTools.map((t) => t.name),
  );
  // Output: ['send-email', 'send-sms']

  // Search with metadata filter
  console.log('\n--- Hybrid Search: productivity tools ---');
  const productivityTools = await hybridSearch('organize my day', {
    metadata: { eq: { category: 'productivity' } },
  });
  console.log(
    'Found:',
    productivityTools.map((t) => t.name),
  );
  // Output: ['schedule-meeting']
}

main().catch(console.error);
```

## Using LanceDB Cloud

For production deployments, you can use LanceDB Cloud instead of local storage:

```typescript
import * as lancedb from './lancedb.ts';

// Connect to LanceDB Cloud
const db = await lancedb.connect('db://your-project.lancedb.com', {
  apiKey: process.env['LANCEDB_API_KEY']!,
});

// The rest of the code remains the same
```

## Using Local Embedding Models

LanceDB works well with local embedding models for offline or privacy-focused deployments. This example declares the one `@xenova/transformers` member it uses; in your project, write `import { pipeline } from '@xenova/transformers'` instead:

```typescript
import { createToolbox } from 'armorer';

// The subset of `@xenova/transformers` this example uses
type FeatureExtractionPipeline = (
  text: string,
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: Float32Array }>;
declare function pipeline(
  task: 'feature-extraction',
  model: string,
): Promise<FeatureExtractionPipeline>;

// Load a local embedding model
const embeddingPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

async function embedLocal(texts: string[]): Promise<number[][]> {
  const embeddings: number[][] = [];

  for (const text of texts) {
    const output = await embeddingPipeline(text, {
      pooling: 'mean',
      normalize: true,
    });
    embeddings.push(Array.from(output.data));
  }

  return embeddings;
}

// Use with Toolbox
const toolbox = createToolbox([], { embed: embedLocal });
```

## LanceDB vs Pinecone

| Feature           | LanceDB           | Pinecone          |
| ----------------- | ----------------- | ----------------- |
| Deployment        | Embedded or Cloud | Cloud only        |
| Local development | Native support    | Requires internet |
| Setup complexity  | Minimal           | Requires account  |
| Cost              | Free (embedded)   | Usage-based       |
| Scalability       | Good              | Excellent         |
| Filtering         | SQL-like syntax   | Metadata filters  |

Choose LanceDB when:

- You need local/offline development
- You want minimal infrastructure
- You're building desktop or edge applications
- You want to avoid vendor lock-in

Choose Pinecone when:

- You need managed infrastructure
- You have very large scale requirements
- You need advanced features like namespaces

## Best Practices

1. **Use batched embeddings**: Generate embeddings for multiple texts in a single API call to reduce latency.

2. **Index maintenance**: Call `rebuildIndex()` periodically if tool descriptions change frequently.

3. **Hybrid search**: Combine LanceDB's semantic search with Toolbox's tag/metadata filters for precise results.

4. **Local models**: Consider using local embedding models like `all-MiniLM-L6-v2` for faster, offline operation.

5. **Persistence**: LanceDB stores data locally by default. Ensure the data directory is backed up or use LanceDB Cloud for production.

## Related Documentation

- [Embeddings & Semantic Search](../embeddings.md) - General embeddings overview and semantic search behavior
- [Pinecone Integration](pinecone.md) - Managed vector database alternative
- [Chroma Integration](chroma.md) - Alternative open-source embedding database
- [Toolbox Registry](../registry.md) - Querying and searching tools
- [API Reference](../api-reference.md) - Complete type definitions
