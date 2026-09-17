import { describe, expect, it } from 'bun:test';

import type { ConsolidationState } from '../src/consolidation';
import { createConsolidationTask } from '../src/consolidation';
import type { Memory, MemoryMetadata, MemorySearchResult } from '../src/types';

// Fixed origin for the fake in-test memory double's synthetic timestamps below — only their
// relative ordering matters to these tests, never the real clock.
const FAKE_MEMORY_ORIGIN = Date.parse('2026-01-01T00:00:00.000Z');

async function processAllChunks(
  processChunk: (
    state: ConsolidationState,
    signal: AbortSignal,
  ) => Promise<{ state: ConsolidationState; done: boolean }>,
  initialState: ConsolidationState,
): Promise<ConsolidationState> {
  const controller = new AbortController();
  let state = initialState;
  let done = false;

  while (!done) {
    const result = await processChunk(state, controller.signal);
    state = result.state;
    done = result.done;
  }

  return state;
}

function createSearchResult(
  id: string,
  content: string,
  createdAt: number,
  metadata: Partial<MemoryMetadata> = {},
): MemorySearchResult {
  return {
    id,
    content,
    score: 1,
    metadata: {
      ...metadata,
      namespace: metadata.namespace ?? 'default',
      source: metadata.source ?? 'manual',
    },
    createdAt,
  };
}

function matchesNamespace(entry: MemorySearchResult, namespace?: string): boolean {
  return namespace === undefined || entry.metadata.namespace === namespace;
}

function createStubMemory(
  initialEntries: MemorySearchResult[],
  similarityMatrix: Record<string, Record<string, number>>,
): Memory & {
  remembered: Array<{ content: string; metadata: Partial<MemoryMetadata> | undefined }>;
  forgotten: string[];
} {
  let entries = [...initialEntries];
  let rememberedEntryCount = 0;
  const remembered: Array<{ content: string; metadata: Partial<MemoryMetadata> | undefined }> = [];
  const forgotten: string[] = [];

  return {
    remembered,
    forgotten,
    async remember(content: string, metadata?: Partial<MemoryMetadata>) {
      remembered.push({ content, metadata });
      const now = FAKE_MEMORY_ORIGIN + rememberedEntryCount;
      const entry = {
        id: `remembered-${rememberedEntryCount++}`,
        content,
        vector: [],
        metadata: {
          ...metadata,
          namespace: metadata?.namespace ?? 'default',
          source: metadata?.source ?? 'manual',
        },
        createdAt: now,
        updatedAt: now,
      };
      entries = [
        createSearchResult(entry.id, content, now, entry.metadata),
        ...entries.filter((existing) => existing.id !== entry.id),
      ];
      return entry;
    },
    async rememberOnce(content: string, metadata: Partial<MemoryMetadata> & { dedupeKey: string }) {
      return this.remember(content, metadata);
    },
    async recall(query: string, options) {
      const limit = options?.limit ?? entries.length;
      const threshold = options?.threshold ?? 0;
      return entries
        .filter((entry) => matchesNamespace(entry, options?.namespace))
        .map((entry) => ({
          ...entry,
          score: similarityMatrix[query]?.[entry.content] ?? 0,
        }))
        .filter((entry) => entry.score >= threshold)
        .toSorted((left, right) => right.score - left.score)
        .slice(0, limit);
    },
    async list(options) {
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? entries.length;
      return entries
        .filter((entry) => matchesNamespace(entry, options?.namespace))
        .slice(offset, offset + limit);
    },
    async forget(id: string) {
      forgotten.push(id);
      entries = entries.filter((entry) => entry.id !== id);
    },
    async forgetAll(namespace?: string) {
      entries = entries.filter((entry) => !matchesNamespace(entry, namespace));
    },
    async count(namespace?: string) {
      return entries.filter((entry) => matchesNamespace(entry, namespace)).length;
    },
    async init() {},
    async close() {},
  };
}

describe('createConsolidationTask advanced stages', () => {
  it('boosts confidence on experiential merges and skips already-merged entries during deduplication', async () => {
    const memory = createStubMemory(
      [
        createSearchResult('entry-a', 'Alpha insight', 1, {
          source: 'experiential',
          confidence: 0.6,
        }),
        createSearchResult('entry-b', 'Beta insight', 2, {
          source: 'experiential',
          confidence: 0.8,
        }),
        createSearchResult('entry-c', 'Gamma duplicate', 3),
        createSearchResult('entry-d', 'Delta duplicate', 4),
      ],
      {
        'Alpha insight': {
          'Beta insight': 0.8,
          'Gamma duplicate': 0.1,
          'Delta duplicate': 0.1,
        },
        'Beta insight': {
          'Alpha insight': 0.8,
          'Gamma duplicate': 0.1,
          'Delta duplicate': 0.1,
        },
        'Gamma duplicate': {
          'Delta duplicate': 0.99,
        },
        'Delta duplicate': {
          'Gamma duplicate': 0.99,
        },
      },
    );

    const task = createConsolidationTask({
      memory,
      chunkSize: 10,
      merge: async (entryA, entryB) => `${entryA} + ${entryB}`,
    });

    const finalState = await processAllChunks(task.processChunk, task.initialState);

    expect(finalState.distilled).toBe(1);
    expect(finalState.deduplicated).toBe(1);
    expect(memory.remembered[0]!).toEqual({
      content: 'Alpha insight + Beta insight',
      metadata: { confidence: 0.9 },
    });
    expect(memory.forgotten).toContain('entry-a');
    expect(memory.forgotten).toContain('entry-b');
    expect(memory.forgotten).toContain('entry-c');
  });

  it('resolves conflicts, prunes low-importance entries, and preserves chunk stats on abort', async () => {
    const conflictMemory = createStubMemory(
      [
        createSearchResult('entry-e', 'Conflicting fact A', 1),
        createSearchResult('entry-f', 'Conflicting fact B', 2),
        createSearchResult('entry-g', 'Disposable note', 3),
      ],
      {
        'Conflicting fact A': {
          'Conflicting fact B': 0.7,
          'Disposable note': 0.1,
        },
        'Conflicting fact B': {
          'Conflicting fact A': 0.7,
          'Disposable note': 0.1,
        },
        'Disposable note': {
          'Conflicting fact A': 0.1,
          'Conflicting fact B': 0.1,
        },
      },
    );

    const conflictTask = createConsolidationTask({
      memory: conflictMemory,
      chunkSize: 10,
      merge: async (entryA, entryB) => `${entryA} + ${entryB}`,
      resolveConflict: async (entryA, entryB) => `${entryA} reconciled with ${entryB}`,
      evaluateImportance: async (content) => (content === 'Disposable note' ? 0.1 : 0.9),
      pruneThreshold: 0.2,
    });

    const conflictState = await processAllChunks(
      conflictTask.processChunk,
      conflictTask.initialState,
    );

    expect(conflictState.conflictsResolved).toBe(1);
    expect(conflictState.pruned).toBe(1);
    expect(conflictMemory.remembered).toContainEqual({
      content: 'Conflicting fact A reconciled with Conflicting fact B',
      metadata: {},
    });
    expect(conflictMemory.forgotten).toContain('entry-e');
    expect(conflictMemory.forgotten).toContain('entry-f');
    expect(conflictMemory.forgotten).toContain('entry-g');

    const abortMemory = createStubMemory(
      [
        createSearchResult('entry-h', 'Abort candidate A', 1),
        createSearchResult('entry-i', 'Abort candidate B', 2),
      ],
      {
        'Abort candidate A': {
          'Abort candidate B': 0.8,
        },
        'Abort candidate B': {
          'Abort candidate A': 0.8,
        },
      },
    );
    const controller = new AbortController();

    const abortTask = createConsolidationTask({
      memory: abortMemory,
      chunkSize: 10,
      merge: async (entryA, entryB) => {
        controller.abort();
        return `${entryA} merged with ${entryB}`;
      },
    });

    const abortResult = await abortTask.processChunk(abortTask.initialState, controller.signal);

    expect(abortResult.done).toBe(false);
    expect(abortResult.state.processedIds).toEqual([]);
    expect(abortResult.state.distilled).toBe(1);
    expect(abortMemory.remembered).toContainEqual({
      content: 'Abort candidate A merged with Abort candidate B',
      metadata: {},
    });
  });
});
