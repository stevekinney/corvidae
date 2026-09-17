import { describe, expect, it } from 'bun:test';

import { createMemory } from '../../src/create-memory';
import type { SoulDistillationState } from '../../src/identity/create-soul-distillation';
import { createSoulDistillationTask } from '../../src/identity/create-soul-distillation';
import { createStaticIdentityProvider } from '../../src/identity/create-static-provider';
import type { SoulBudget, SoulItem } from '../../src/identity/types';
import { createInMemoryMemoryRecordStorage, createMockEmbedder } from '../../src/test/index';
import type { Memory } from '../../src/types';

function createTestMemory(): Memory {
  return createMemory({
    embedder: createMockEmbedder(128),
    storage: createInMemoryMemoryRecordStorage(),
    deduplicationThreshold: 0.99,
  });
}

function makeSoulItem(id: string, content: string, overrides?: Partial<SoulItem>): SoulItem {
  return {
    id,
    content,
    source: 'seed',
    pinned: false,
    updatedAt: '2026-01-01T00:00:00Z',
    reinforcementCount: 0,
    ...overrides,
  };
}

const defaultBudget: SoulBudget = {
  maxTokens: 10000,
  estimateTokens: (text: string) => Math.ceil(text.length / 4),
  maxItemsPerTopic: 5,
};

async function processAllChunks(
  processChunk: (
    state: SoulDistillationState,
    signal: AbortSignal,
  ) => Promise<{ state: SoulDistillationState; done: boolean }>,
  initialState: SoulDistillationState,
): Promise<SoulDistillationState> {
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

describe('createSoulDistillationTask checkpoints', () => {
  it('completes when memory is empty', async () => {
    const memory = createTestMemory();
    await memory.init();

    const provider = createStaticIdentityProvider({
      soul: [makeSoulItem('1', 'Existing')],
    });

    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: defaultBudget,
      distill: async () => 'Should not be called',
    });

    const finalState = await processAllChunks(task.processChunk, task.initialState);
    expect(finalState.scanned).toBe(0);
    expect(finalState.proposalGenerated).toBe(false);

    // No pending update should be created
    expect(await provider.loadPendingSoulUpdate()).toBeUndefined();

    await memory.close();
  });

  it('returns immediately when a proposal has already been generated', async () => {
    const memory = createTestMemory();
    const provider = createStaticIdentityProvider();
    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: defaultBudget,
      distill: async () => '',
    });

    const completedState: SoulDistillationState = {
      scanned: 2,
      candidates: [],
      demotions: [],
      proposalGenerated: true,
    };

    const result = await task.processChunk(completedState, new AbortController().signal);

    expect(result).toEqual({ state: completedState, done: true });
  });

  it('returns partial scanning state when aborted mid-scan', async () => {
    const memory = createTestMemory();
    await memory.init();

    await memory.remember('Abortable candidate', {
      confidence: 0.95,
      reinforcementCount: 5,
    });

    const provider = createStaticIdentityProvider();
    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: defaultBudget,
      distill: async () => '',
    });
    const controller = new AbortController();
    controller.abort();

    const result = await task.processChunk(task.initialState, controller.signal);

    expect(result.done).toBe(false);
    expect(result.state.scanned).toBe(1);
    expect(result.state.candidates).toEqual([]);

    await memory.close();
  });

  it('returns done false while additional chunks remain to be scanned', async () => {
    const memory = createTestMemory();
    await memory.init();

    await memory.remember('Candidate one', { confidence: 0.95, reinforcementCount: 5 });
    await memory.remember('Candidate two', { confidence: 0.95, reinforcementCount: 5 });
    await memory.remember('Candidate three', { confidence: 0.95, reinforcementCount: 5 });

    const provider = createStaticIdentityProvider();
    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: defaultBudget,
      chunkSize: 2,
      distill: async (_soul, candidates) =>
        candidates.map((candidate) => candidate.content).join('\n'),
    });

    const result = await task.processChunk(task.initialState, new AbortController().signal);

    expect(result.done).toBe(false);
    expect(result.state.scanned).toBe(2);
    expect(result.state.candidates).toHaveLength(2);

    await memory.close();
  });

  it('reuses existing candidates when resuming a later chunk', async () => {
    const memory = createTestMemory();
    await memory.init();

    const firstCandidate = await memory.remember('Candidate one', {
      confidence: 0.95,
      reinforcementCount: 5,
    });
    await memory.remember('Candidate two', {
      confidence: 0.95,
      reinforcementCount: 5,
    });

    const provider = createStaticIdentityProvider();
    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: defaultBudget,
      distill: async (_soul, candidates) =>
        candidates.map((candidate) => candidate.content).join('\n'),
    });

    const resumedState: SoulDistillationState = {
      scanned: 0,
      candidates: [
        {
          content: 'Candidate one',
          confidence: 0.95,
          reinforcementCount: 5,
          entryId: firstCandidate.id,
        },
      ],
      demotions: [],
      proposalGenerated: false,
    };

    const finalState = await processAllChunks(task.processChunk, resumedState);

    expect(finalState.candidates).toHaveLength(2);
    expect(finalState.candidates.map((candidate) => candidate.entryId)).toContain(
      firstCandidate.id,
    );

    await memory.close();
  });

  it('marks the proposal complete when the safety filter removes every candidate', async () => {
    const memory = createTestMemory();
    await memory.init();

    await memory.remember('Filtered candidate', {
      confidence: 0.95,
      reinforcementCount: 5,
    });

    const provider = createStaticIdentityProvider();
    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: defaultBudget,
      distill: async (_soul, candidates) =>
        candidates.map((candidate) => candidate.content).join('\n'),
      safetyFilter: async () => false,
    });

    const finalState = await processAllChunks(task.processChunk, task.initialState);

    expect(finalState.proposalGenerated).toBe(true);
    expect(finalState.candidates).toHaveLength(1);
    expect(await provider.loadPendingSoulUpdate()).toBeUndefined();

    await memory.close();
  });

  it('demotes the oldest low-priority soul item first when reinforcement counts tie', async () => {
    const memory = createTestMemory();
    await memory.init();

    await memory.remember('Graduate this memory', {
      confidence: 0.98,
      reinforcementCount: 6,
    });

    const provider = createStaticIdentityProvider({
      soul: [
        makeSoulItem('older-item', 'Older item', {
          reinforcementCount: 1,
          updatedAt: '2025-01-01T00:00:00Z',
        }),
        makeSoulItem('newer-item', 'Newer item', {
          reinforcementCount: 1,
          updatedAt: '2026-01-01T00:00:00Z',
        }),
      ],
    });

    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: {
        maxTokens: 20,
        estimateTokens: (text) => (text.length === 0 ? 0 : text.split('\n').length * 10),
        maxItemsPerTopic: 5,
      },
      distill: async (_soul, candidates) =>
        candidates.map((candidate) => candidate.content).join('\n'),
    });

    const finalState = await processAllChunks(task.processChunk, task.initialState);

    expect(finalState.demotions[0]!).toBe('older-item');

    await memory.close();
  });
});
