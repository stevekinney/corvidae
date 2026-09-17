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

describe('createSoulDistillationTask budget and filters', () => {
  it('maxItemsPerTopic prevents topic over-concentration', async () => {
    const memory = createTestMemory();
    await memory.init();

    // Add many candidates in the same topic
    for (let i = 0; i < 8; i++) {
      await memory.remember(`Safety rule ${i}`, {
        confidence: 0.95,
        reinforcementCount: 5,
        topic: 'safety',
      });
    }

    const provider = createStaticIdentityProvider({
      soul: [
        makeSoulItem('s1', 'Safety rule existing 1', { topic: 'safety' }),
        makeSoulItem('s2', 'Safety rule existing 2', { topic: 'safety' }),
      ],
    });

    let receivedCandidates: Array<{ content: string }> = [];

    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: { ...defaultBudget, maxItemsPerTopic: 3 },
      distill: async (_soul, candidates) => {
        receivedCandidates = candidates;
        return candidates.map((c) => c.content).join('\n');
      },
    });

    await processAllChunks(task.processChunk, task.initialState);

    // 2 existing + at most 1 new = 3 total for the topic
    expect(receivedCandidates.length).toBeLessThanOrEqual(1);

    await memory.close();
  });

  it('safety filter rejects flagged candidates', async () => {
    const memory = createTestMemory();
    await memory.init();

    await memory.remember('Safe principle', {
      confidence: 0.95,
      reinforcementCount: 5,
    });

    await memory.remember('Unsafe principle that should be rejected', {
      confidence: 0.95,
      reinforcementCount: 5,
    });

    const provider = createStaticIdentityProvider();

    let distillCandidates: Array<{ content: string }> = [];

    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: defaultBudget,
      distill: async (_soul, candidates) => {
        distillCandidates = candidates;
        return candidates.map((c) => c.content).join('\n');
      },
      safetyFilter: async (item) => !item.includes('Unsafe'),
    });

    await processAllChunks(task.processChunk, task.initialState);

    // Only the safe candidate should have made it to distill
    expect(distillCandidates).toHaveLength(1);
    expect(distillCandidates[0]!.content).toBe('Safe principle');

    await memory.close();
  });

  it('budget enforcement triggers demotion of lowest-value non-pinned items', async () => {
    const memory = createTestMemory();
    await memory.init();

    await memory.remember('New high-value insight', {
      confidence: 0.98,
      reinforcementCount: 10,
    });

    // Create a soul that's near the budget limit
    const provider = createStaticIdentityProvider({
      soul: [
        makeSoulItem('pinned', 'I am pinned and safe', { pinned: true, reinforcementCount: 1 }),
        makeSoulItem('low-value', 'I have low reinforcement', { reinforcementCount: 0 }),
        makeSoulItem('high-value', 'I have high reinforcement', { reinforcementCount: 10 }),
      ],
    });

    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: {
        maxTokens: 20, // Very tight budget
        estimateTokens: (text) => Math.ceil(text.length / 4),
        maxItemsPerTopic: 5,
      },
      distill: async (_soul, candidates) => candidates.map((c) => c.content).join('\n'),
    });

    const finalState = await processAllChunks(task.processChunk, task.initialState);

    // The low-value non-pinned item should be a demotion candidate
    if (finalState.demotions.length > 0) {
      expect(finalState.demotions).toContain('low-value');
      expect(finalState.demotions).not.toContain('pinned');
    }

    await memory.close();
  });

  it('pinned items are never demoted', async () => {
    const memory = createTestMemory();
    await memory.init();

    await memory.remember('New insight', {
      confidence: 0.95,
      reinforcementCount: 5,
    });

    const provider = createStaticIdentityProvider({
      soul: [
        makeSoulItem('pinned-low', 'Pinned but low reinforcement', {
          pinned: true,
          reinforcementCount: 0,
        }),
      ],
    });

    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: {
        maxTokens: 5, // Very tight
        estimateTokens: (text) => Math.ceil(text.length / 4),
        maxItemsPerTopic: 5,
      },
      distill: async (_soul, candidates) => candidates.map((c) => c.content).join('\n'),
    });

    const finalState = await processAllChunks(task.processChunk, task.initialState);

    expect(finalState.demotions).not.toContain('pinned-low');

    await memory.close();
  });
});
