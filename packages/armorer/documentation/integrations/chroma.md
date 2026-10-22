# Chroma Integration

## Overview

[Chroma](https://www.trychroma.com/) is an open-source embedding database designed for AI applications. It can run embedded (in-memory or persistent) or as a client-server setup, making it flexible for development and production use.

This guide shows how to integrate Chroma with Toolbox for semantic tool search.

## Setup

Install the required dependencies:

```bash
bun add chromadb openai
```

For persistent storage or better performance, you can also run Chroma as a server:

```bash
# Using Docker
docker run -p 8000:8000 chromadb/chroma

# Or using pip
pip install chromadb
chroma run --path ./chroma-data
```

## The Chroma Client Members These Examples Use

The examples below import Chroma's client from a local `chroma.ts` that declares only the members they call, so they type-check without `chromadb` installed. In your project, import the same names from `'chromadb'` instead.

```typescript file=chroma.ts
export type ChromaMetadata = Record<string, string | number | boolean>;
export type ChromaWhere = Record<string, unknown>;

export interface ChromaEmbeddingFunction {
  generate(texts: string[]): Promise<number[][]>;
}

export interface ChromaCollection {
  add(records: {
    ids: string[];
    embeddings?: number[][];
    documents?: string[];
    metadatas?: ChromaMetadata[];
  }): Promise<void>;
  delete(filter: { ids?: string[]; where?: ChromaWhere }): Promise<void>;
  query(args: {
    queryEmbeddings: number[][];
    nResults?: number;
    where?: ChromaWhere | undefined;
    whereDocument?: Record<string, unknown>;
  }): Promise<{ ids: string[][]; metadatas: (ChromaMetadata | null)[][] }>;
  get(): Promise<{ ids: string[]; metadatas: (ChromaMetadata | null)[] }>;
  count(): Promise<number>;
}

export interface ChromaClient {
  getOrCreateCollection(options: {
    name: string;
    metadata?: ChromaMetadata;
    embeddingFunction?: ChromaEmbeddingFunction;
  }): Promise<ChromaCollection>;
}

export declare const ChromaClient: new (options?: {
  path?: string;
  auth?: { provider: 'token'; credentials: string };
}) => ChromaClient;

export declare const OpenAIEmbeddingFunction: new (options: {
  openai_api_key: string;
  openai_model: string;
}) => ChromaEmbeddingFunction;

export declare const CohereEmbeddingFunction: new (options: {
  cohere_api_key: string;
  model: string;
}) => ChromaEmbeddingFunction;

export declare const HuggingFaceEmbeddingServerFunction: new (options: {
  url: string;
}) => ChromaEmbeddingFunction;
```

## Basic Chroma Integration

Here's a simple example using Chroma's embedded mode:

```typescript file=basic.ts
import { createToolbox, type Tool } from 'armorer';
import OpenAI from 'openai';
import { ChromaClient } from './chroma.ts';

// Your tools
declare const tools: readonly Tool[];

// Initialize clients
export const chroma = new ChromaClient();
const openai = new OpenAI();

// Embedding function for Toolbox
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

// Create or get a collection for tools
export const collection = await chroma.getOrCreateCollection({
  name: 'toolbox_tools',
  metadata: { description: 'Toolbox tool embeddings' },
});
```

## Using Chroma's Built-in Embedding Functions

Chroma supports built-in embedding functions, which simplifies the setup:

```typescript
import { ChromaClient, OpenAIEmbeddingFunction } from './chroma.ts';

const chroma = new ChromaClient();

const embedder = new OpenAIEmbeddingFunction({
  openai_api_key: process.env['OPENAI_API_KEY']!,
  openai_model: 'text-embedding-3-small',
});

const collection = await chroma.getOrCreateCollection({
  name: 'toolbox_tools',
  embeddingFunction: embedder,
});

// Now you can add documents without providing embeddings
await collection.add({
  ids: ['tool-1'],
  documents: ['Send an email to recipients'],
  metadatas: [{ toolName: 'send-email', field: 'description' }],
});
```

## Syncing Tools to Chroma

Index the toolbox's tools in Chroma once the toolbox is built:

```typescript
import { collection, embed, toolbox } from './basic.ts';

for (const tool of toolbox.tools()) {
  // Prepare documents for each searchable field
  const fields = [
    { field: 'name', text: tool.name },
    { field: 'description', text: tool.description },
    { field: 'tags', text: tool.tags?.join(' ') ?? '' },
  ].filter((f) => f.text);

  // Generate embeddings
  const embeddings = await embed(fields.map((f) => f.text));

  // Delete existing entries for this tool
  try {
    await collection.delete({
      where: { toolName: tool.name },
    });
  } catch {
    // Collection might be empty
  }

  // Add new entries
  await collection.add({
    ids: fields.map((f) => `${tool.name}:${f.field}`),
    embeddings,
    documents: fields.map((f) => f.text),
    metadatas: fields.map((f) => ({
      toolName: tool.name,
      field: f.field,
      tags: JSON.stringify(tool.tags ?? []),
    })),
  });
}
```

## Semantic Search with Chroma

Chroma's query API makes semantic search straightforward:

```typescript
import type { Tool } from 'armorer';
import { collection, embed, toolbox } from './basic.ts';

async function searchTools(query: string, limit = 5): Promise<Tool[]> {
  // Generate embedding for the query
  const [queryEmbedding] = await embed([query]);
  if (!queryEmbedding) return [];

  // Query Chroma
  const results = await collection.query({
    queryEmbeddings: [queryEmbedding],
    nResults: limit * 3, // Get extra for deduplication
  });

  // Deduplicate by tool name
  const seen = new Set<string>();
  const tools: Tool[] = [];

  for (const metadata of results.metadatas[0] ?? []) {
    const toolName = metadata?.['toolName'];
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

## Full Example: Chroma-backed Tool Registry

Here's a complete, production-ready example:

```typescript file=registry.ts
import { createToolbox, createTool, queryTools, type Tool, type ToolQuery } from 'armorer';
import OpenAI from 'openai';
import { z } from 'zod';
import { ChromaClient, type ChromaCollection, type ChromaMetadata } from './chroma.ts';

// Configuration
const COLLECTION_NAME = 'toolbox_tools';
const EMBEDDING_MODEL = 'text-embedding-3-small';

// Initialize clients
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

// Read the distinct tool names from a Chroma result, in rank order
function toolNamesFrom(metadatas: readonly (ChromaMetadata | null)[]): string[] {
  const names = new Set<string>();
  for (const metadata of metadatas) {
    const toolName = metadata?.['toolName'];
    if (typeof toolName === 'string') {
      names.add(toolName);
    }
  }
  return Array.from(names);
}

export type ChromaToolRegistryOptions = {
  /** Chroma server URL. If not provided, uses embedded mode. */
  chromaUrl?: string;
  /** Collection name. Defaults to 'toolbox_tools'. */
  collectionName?: string;
  /** Path for persistent storage in embedded mode. */
  persistPath?: string;
};

export async function createChromaToolRegistry(
  tools: readonly Tool[],
  options: ChromaToolRegistryOptions = {},
) {
  // Connect to Chroma
  const chroma = options.chromaUrl
    ? new ChromaClient({ path: options.chromaUrl })
    : new ChromaClient();

  // Create or get collection
  const collection = await chroma.getOrCreateCollection({
    name: options.collectionName ?? COLLECTION_NAME,
    metadata: {
      description: 'Toolbox tool embeddings for semantic search',
      'hnsw:space': 'cosine',
    },
  });

  const toolbox = createToolbox(tools, { embed });

  // Index the toolbox's tools in Chroma
  for (const tool of toolbox.tools()) {
    await syncToolToChroma(collection, tool);
  }

  async function syncToolToChroma(col: ChromaCollection, tool: Tool): Promise<void> {
    const fields = [
      { field: 'name', text: tool.name },
      { field: 'description', text: tool.description },
      { field: 'tags', text: tool.tags?.join(' ') ?? '' },
    ].filter((f) => f.text);

    const embeddings = await embed(fields.map((f) => f.text));

    // Delete existing entries
    try {
      await col.delete({
        where: { toolName: tool.name },
      });
    } catch {
      // Ignore if nothing to delete
    }

    // Add new entries
    await col.add({
      ids: fields.map((f) => `${tool.name}:${f.field}`),
      embeddings,
      documents: fields.map((f) => f.text),
      metadatas: fields.map((f) => ({
        toolName: tool.name,
        field: f.field,
        tags: JSON.stringify(tool.tags ?? []),
        metadata: JSON.stringify(tool.metadata ?? {}),
      })),
    });
  }

  // Map ranked tool names back to the toolbox's tools
  function toolsNamed(names: readonly string[], limit: number): Tool[] {
    return names
      .map((name) => toolbox.getTool(name))
      .filter((t): t is Tool => t !== undefined)
      .slice(0, limit);
  }

  /**
   * Semantic search for tools
   */
  async function search(query: string, limit = 10): Promise<Tool[]> {
    const [queryEmbedding] = await embed([query]);
    if (!queryEmbedding) return [];

    const results = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: limit * 3,
    });

    return toolsNamed(toolNamesFrom(results.metadatas[0] ?? []), limit);
  }

  return {
    toolbox,
    chroma,
    collection,
    search,

    /**
     * Search with Chroma metadata filtering
     */
    async searchWithFilter(
      query: string,
      filter: {
        field?: 'name' | 'description' | 'tags';
        toolNames?: string[];
      },
      limit = 10,
    ): Promise<Tool[]> {
      const [queryEmbedding] = await embed([query]);
      if (!queryEmbedding) return [];

      // Build Chroma where clause
      const whereConditions: Record<string, unknown>[] = [];

      if (filter.field) {
        whereConditions.push({ field: filter.field });
      }

      if (filter.toolNames?.length) {
        whereConditions.push({ toolName: { $in: filter.toolNames } });
      }

      const whereClause =
        whereConditions.length > 1 ? { $and: whereConditions } : whereConditions[0];

      const results = await collection.query({
        queryEmbeddings: [queryEmbedding],
        nResults: limit * 3,
        where: whereClause,
      });

      return toolsNamed(toolNamesFrom(results.metadatas[0] ?? []), limit);
    },

    /**
     * Search with document content filtering
     */
    async searchWithDocumentFilter(
      query: string,
      documentFilter: string,
      limit = 10,
    ): Promise<Tool[]> {
      const [queryEmbedding] = await embed([query]);
      if (!queryEmbedding) return [];

      const results = await collection.query({
        queryEmbeddings: [queryEmbedding],
        nResults: limit * 3,
        whereDocument: { $contains: documentFilter },
      });

      return toolsNamed(toolNamesFrom(results.metadatas[0] ?? []), limit);
    },

    /**
     * Hybrid search: Chroma semantic + Toolbox filters
     */
    async hybridSearch(
      query: string,
      toolboxFilter?: Pick<ToolQuery, 'tags' | 'metadata'>,
      limit = 10,
    ): Promise<Tool[]> {
      const [queryEmbedding] = await embed([query]);
      if (!queryEmbedding) return [];

      // Get semantic candidates from Chroma
      const results = await collection.query({
        queryEmbeddings: [queryEmbedding],
        nResults: 50, // Get more for filtering
      });

      // Get tools and apply Toolbox filters
      const candidates = toolsNamed(toolNamesFrom(results.metadatas[0] ?? []), Infinity);

      if (!toolboxFilter) {
        return candidates.slice(0, limit);
      }

      return queryTools(candidates, { ...toolboxFilter, limit });
    },

    /**
     * Get similar tools based on an existing tool
     */
    async findSimilar(toolName: string, limit = 5): Promise<Tool[]> {
      const tool = toolbox.getTool(toolName);
      if (!tool) return [];

      // Use the tool's description as the query
      const results = await search(tool.description, limit + 1);
      return results.filter((t) => t.name !== toolName).slice(0, limit);
    },

    /**
     * Delete a tool from Chroma
     */
    async deleteTool(toolName: string): Promise<void> {
      await collection.delete({
        where: { toolName },
      });
    },

    /**
     * Rebuild all tool embeddings
     */
    async rebuildIndex(): Promise<void> {
      // Get all current IDs and delete them
      const existing = await collection.get();
      if (existing.ids.length > 0) {
        await collection.delete({ ids: existing.ids });
      }

      // Re-embed all tools
      for (const tool of toolbox.tools()) {
        await syncToolToChroma(collection, tool);
      }
    },

    /**
     * Get collection statistics
     */
    async stats(): Promise<{ toolCount: number; documentCount: number }> {
      const count = await collection.count();
      const data = await collection.get();
      return {
        toolCount: toolNamesFrom(data.metadatas).length,
        documentCount: count,
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
    metadata: { category: 'communication', priority: 'high' },
    async execute({ to, subject, body }) {
      console.log(`Sending email to ${to.join(', ')}`);
      return { sent: true, recipients: to.length };
    },
  });

  const sendSlackMessage = createTool({
    name: 'send-slack-message',
    description: 'Post a message to a Slack channel or user',
    input: z.object({
      channel: z.string(),
      message: z.string(),
      threadTs: z.string().optional(),
    }),
    tags: ['communication', 'slack', 'messaging'],
    metadata: { category: 'communication', priority: 'medium' },
    async execute({ channel, message }) {
      console.log(`Posting to Slack: ${channel}`);
      return { posted: true };
    },
  });

  const createJiraTicket = createTool({
    name: 'create-jira-ticket',
    description: 'Create a new issue or ticket in Jira',
    input: z.object({
      project: z.string(),
      summary: z.string(),
      description: z.string(),
      issueType: z.enum(['bug', 'story', 'task']),
    }),
    tags: ['project-management', 'jira', 'tickets'],
    metadata: { category: 'productivity', priority: 'medium' },
    async execute({ project, summary }) {
      console.log(`Creating Jira ticket in ${project}`);
      return { created: true, key: 'PROJ-123' };
    },
  });

  const scheduleMeeting = createTool({
    name: 'schedule-meeting',
    description: 'Create a calendar event and send invites to attendees',
    input: z.object({
      title: z.string(),
      startTime: z.string().datetime(),
      duration: z.number(),
      attendees: z.array(z.string().email()),
    }),
    tags: ['calendar', 'scheduling', 'meetings'],
    metadata: { category: 'productivity', priority: 'high' },
    async execute({ title }) {
      console.log(`Scheduling: ${title}`);
      return { scheduled: true };
    },
  });

  // Resolves once every tool is indexed in Chroma
  const { search, hybridSearch, findSimilar } = await createChromaToolRegistry([
    sendEmail,
    sendSlackMessage,
    createJiraTicket,
    scheduleMeeting,
  ]);

  // Semantic search
  console.log('\n--- Semantic Search: "notify the team" ---');
  const notifyTools = await search('notify the team about something');
  console.log(
    'Found:',
    notifyTools.map((t) => t.name),
  );
  // Output: ['send-email', 'send-slack-message']

  // Hybrid search with Toolbox filters
  console.log('\n--- Hybrid Search: "message" with communication tag ---');
  const messageTools = await hybridSearch('send a message', {
    tags: { any: ['communication'] },
  });
  console.log(
    'Found:',
    messageTools.map((t) => t.name),
  );
  // Output: ['send-email', 'send-slack-message']

  // Find similar tools
  console.log('\n--- Similar to "send-email" ---');
  const similar = await findSimilar('send-email');
  console.log(
    'Found:',
    similar.map((t) => t.name),
  );
  // Output: ['send-slack-message', 'schedule-meeting']

  // Hybrid search with metadata
  console.log('\n--- High priority tools for "communicate" ---');
  const highPriority = await hybridSearch('communicate with someone', {
    metadata: { eq: { priority: 'high' } },
  });
  console.log(
    'Found:',
    highPriority.map((t) => t.name),
  );
  // Output: ['send-email', 'schedule-meeting']
}

main().catch(console.error);
```

## Running Chroma as a Server

For production or multi-process access, run Chroma as a standalone server:

```typescript
import type { Tool } from 'armorer';
import { createChromaToolRegistry } from './registry.ts';

declare const tools: readonly Tool[];

// Connect to Chroma server
const { toolbox, search } = await createChromaToolRegistry(tools, {
  chromaUrl: 'http://localhost:8000',
});
```

### Docker Compose Setup

```yaml
version: '3.8'
services:
  chroma:
    image: chromadb/chroma:latest
    ports:
      - '8000:8000'
    volumes:
      - chroma-data:/chroma/chroma
    environment:
      - CHROMA_SERVER_AUTH_PROVIDER=chromadb.auth.token.TokenAuthServerProvider
      - CHROMA_SERVER_AUTH_TOKEN_TRANSPORT_HEADER=Authorization
      - CHROMA_SERVER_AUTH_CREDENTIALS=${CHROMA_AUTH_TOKEN}

volumes:
  chroma-data:
```

### Authenticated Client

```typescript
import { ChromaClient } from './chroma.ts';

const chroma = new ChromaClient({
  path: 'http://localhost:8000',
  auth: {
    provider: 'token',
    credentials: process.env['CHROMA_AUTH_TOKEN']!,
  },
});
```

## Using Chroma's Built-in Embedding Functions

Chroma supports several built-in embedding functions:

```typescript
import {
  ChromaClient,
  OpenAIEmbeddingFunction,
  CohereEmbeddingFunction,
  HuggingFaceEmbeddingServerFunction,
} from './chroma.ts';

const chroma = new ChromaClient();

// OpenAI
const openaiEmbedder = new OpenAIEmbeddingFunction({
  openai_api_key: process.env['OPENAI_API_KEY']!,
  openai_model: 'text-embedding-3-small',
});

// Cohere
const cohereEmbedder = new CohereEmbeddingFunction({
  cohere_api_key: process.env['COHERE_API_KEY']!,
  model: 'embed-english-v3.0',
});

// Local HuggingFace model server
const hfEmbedder = new HuggingFaceEmbeddingServerFunction({
  url: 'http://localhost:8080/embed',
});

// Use with collection
const collection = await chroma.getOrCreateCollection({
  name: 'toolbox_tools',
  embeddingFunction: openaiEmbedder,
});

// Add documents without manually generating embeddings
await collection.add({
  ids: ['tool-1:description'],
  documents: ['Send an email to recipients'],
  metadatas: [{ toolName: 'send-email', field: 'description' }],
});
```

## Chroma vs Pinecone vs LanceDB

| Feature             | Chroma              | Pinecone          | LanceDB           |
| ------------------- | ------------------- | ----------------- | ----------------- |
| Deployment          | Embedded or Server  | Cloud only        | Embedded or Cloud |
| Open Source         | Yes                 | No                | Yes               |
| Local dev           | Native              | Requires internet | Native            |
| Built-in embeddings | Yes                 | No                | No                |
| Filtering           | Metadata + Document | Metadata          | SQL-like          |
| Setup complexity    | Low                 | Medium            | Low               |
| Scaling             | Manual              | Automatic         | Manual            |

Choose Chroma when:

- You want open-source with active development
- You need built-in embedding function support
- You want flexibility between embedded and server modes
- You need document content filtering

## Best Practices

1. **Use built-in embeddings**: Chroma's embedding functions simplify the setup and reduce code.

2. **Batch operations**: When registering many tools, batch your `add()` calls for better performance.

3. **Collection metadata**: Use `hnsw:space` to specify the distance metric (cosine, l2, ip).

4. **Hybrid filtering**: Combine Chroma's `where` and `whereDocument` filters with Toolbox's query system.

5. **Server mode for production**: Run Chroma as a server for multi-process access and persistence.

```typescript
import { ChromaClient } from './chroma.ts';

const chroma = new ChromaClient();

// Configure HNSW for better search quality
const collection = await chroma.getOrCreateCollection({
  name: 'toolbox_tools',
  metadata: {
    'hnsw:space': 'cosine',
    'hnsw:construction_ef': 100,
    'hnsw:search_ef': 100,
  },
});
```

## Related Documentation

- [Embeddings & Semantic Search](../embeddings.md) - General embeddings overview and semantic search behavior
- [Pinecone Integration](pinecone.md) - Managed vector database alternative
- [LanceDB Integration](lancedb.md) - Alternative serverless vector database
- [Toolbox Registry](../registry.md) - Querying and searching tools
- [API Reference](../api-reference.md) - Complete type definitions
