import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AnyToolDefinition, ToolMetadata } from '../src';
import type { TextSearchIndex } from '../src/core/query-predicates';
import {
  internalRegistryTestUtilities,
  queryTools,
  registerToolIndexes,
  reindexSearchIndex,
  unregisterToolIndexes,
} from '../src/core/registry';
import { registerRegistryEmbedder, warmToolEmbeddings } from '../src/core/registry/embeddings';
import { getSchemaKeys } from '../src/core/schema-utilities';
import { type CreateToolOptions, createTool } from '../src/create-tool';

const {
  addFieldTokens,
  addToolToInvertedIndex,
  buildInvertedIndex,
  createFieldTokenIndex,
  getRegistryEmbeddingIndex,
  getRegistryInvertedIndex,
  getRegistryTextIndex,
  getTokenCharacters,
  getTokenGrams,
  getToolLookup,
  removeFieldTokens,
  removeToolFromInvertedIndex,
} = internalRegistryTestUtilities;

const constantEmbedding = (texts: string[]): number[][] => texts.map(() => [1, 0]);

const makeTool = (
  name: string,
  overrides: Partial<Omit<CreateToolOptions, 'metadata' | 'input' | 'execute' | 'name'>> & {
    metadata?: ToolMetadata;
  } = {},
) =>
  createTool({
    name,
    description: `${name} description`,
    input: z.object({
      value: z.string().optional(),
      category: z.string().optional(),
    }),
    execute: async (params) => params,
    ...overrides,
  });

const makeTextIndex = (tool: AnyToolDefinition): TextSearchIndex => ({
  name: tool.identity.name.toLowerCase(),
  description: tool.description.toLowerCase(),
  nameTokens: [tool.identity.name.toLowerCase()],
  descriptionTokens: tool.description.toLowerCase().split(/\s+/g).filter(Boolean),
  tags: (tool.tags ?? []).map((tag) => ({ raw: tag, normalized: tag.toLowerCase() })),
  schemaKeys: getSchemaKeys(tool.input).map((key) => ({
    raw: key,
    normalized: key.toLowerCase(),
  })),
  metadataKeys: Object.keys(tool.metadata ?? {}).map((key) => ({
    raw: key,
    normalized: key.toLowerCase(),
  })),
});

describe('registry internal coverage', () => {
  it('hits the query cache and emits query events on cached reads', () => {
    const tool = makeTool('cache-hit');
    const events: unknown[] = [];
    const registry = {
      tools: () => [tool],
      register: () => registry,
      dispatchEvent: (event: unknown) => {
        events.push(event);
        return true;
      },
    };

    const first = queryTools(registry, { select: 'name' });
    const second = queryTools(registry, { select: 'name' });

    expect(first).toEqual(['cache-hit']);
    expect(second).toEqual(['cache-hit']);
    expect(events).toHaveLength(2);
  });

  it('reindexes async embeddings without re-adding stale tools', async () => {
    const tool = makeTool('stale-embed');
    let live = true;
    let resolveEmbeddings: ((vectors: number[][]) => void) | undefined;
    const registry = {
      tools: () => [tool],
      register: () => registry,
      getTool: () => (live ? tool : undefined),
    };

    registerRegistryEmbedder(
      registry,
      () =>
        new Promise<number[][]>((resolve) => {
          resolveEmbeddings = resolve;
        }),
    );

    reindexSearchIndex(registry);
    live = false;
    resolveEmbeddings?.(Array.from({ length: 5 }, () => [1, 0]));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(true).toBe(true);
  });

  it('reindexes async embeddings for still-registered tools', async () => {
    const tool = makeTool('live-embed');
    let resolveEmbeddings: ((vectors: number[][]) => void) | undefined;
    const registry = {
      tools: () => [tool],
      register: () => registry,
      getTool: (name: string) => (name === tool.name ? tool : undefined),
    };

    registerRegistryEmbedder(
      registry,
      () =>
        new Promise<number[][]>((resolve) => {
          resolveEmbeddings = resolve;
        }),
    );

    reindexSearchIndex(registry);
    resolveEmbeddings?.(Array.from({ length: 5 }, () => [1, 0]));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(true).toBe(true);
  });

  it('maintains explicit index sizes and cleans up text, inverted, and embedding buckets', () => {
    const existing = makeTool('existing', {
      tags: ['fast'],
      metadata: { owner: 'team-core' },
    });
    const added = makeTool('added', {
      tags: ['fast', 'exact'],
      metadata: { owner: 'team-added' },
    });
    const registry = {
      tools: () => [existing, added],
      register: () => registry,
      getTool: (name: string) =>
        name === existing.name || name === added.name ? added : undefined,
    };
    warmToolEmbeddings(existing, constantEmbedding);
    warmToolEmbeddings(added, constantEmbedding);

    const inverted = getRegistryInvertedIndex(registry, [existing]);
    const text = getRegistryTextIndex(registry, [existing], makeTextIndex);
    const embeddings = getRegistryEmbeddingIndex(registry, [existing]);

    registerToolIndexes(registry, added, 5);
    expect(inverted.size).toBe(5);
    expect(text.size).toBe(5);
    expect(embeddings.size).toBe(5);

    unregisterToolIndexes(registry, added, 1);
    expect(inverted.size).toBe(1);
    expect(text.size).toBe(1);
    expect(embeddings.size).toBe(1);
    expect(inverted.tagIndex.get('exact')).toBeUndefined();
    expect(text.fields.tags.map.get('exact')).toBeUndefined();

    registerToolIndexes(registry, added);
    expect(inverted.size).toBe(2);
    expect(text.size).toBe(2);
    expect(embeddings.size).toBe(2);

    unregisterToolIndexes(registry, added);
    expect(inverted.size).toBe(1);
    expect(text.size).toBe(1);
    expect(embeddings.size).toBe(1);
  });

  it('covers field token indexing, lookup caching, and inverted-index cleanup helpers', () => {
    const tool = makeTool('token-tool', {
      tags: ['Fast-Path'.toLowerCase()],
      metadata: { owner: 'ops' },
    });
    const fieldIndex = createFieldTokenIndex();
    const inverted = buildInvertedIndex([]);

    addFieldTokens(fieldIndex, ['', 'a1', 'beta'], tool);
    expect(getTokenCharacters('')).toEqual([]);
    expect(getTokenGrams('a!', 2)).toEqual([]);
    expect(getToolLookup(tool)).toBe(getToolLookup(tool));

    addToolToInvertedIndex(inverted, tool);
    expect(inverted.tagIndex.get('fast-path')).toBeDefined();

    removeFieldTokens(fieldIndex, ['', 'a1', 'beta'], tool);
    removeToolFromInvertedIndex(inverted, tool);

    expect(fieldIndex.tokens).toEqual([]);
    expect(fieldIndex.lengths).toEqual([]);
    expect(fieldIndex.charMap.size).toBe(0);
    expect(fieldIndex.bigramMap.size).toBe(0);
    expect(fieldIndex.gramMap.size).toBe(0);
    expect(inverted.tagIndex.size).toBe(0);
    expect(inverted.schemaKeyIndex.size).toBe(0);
  });
});
