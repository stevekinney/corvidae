import { createManualRuntimeServices } from '@corvidae/lifecycle';
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

describe('createSoulDistillationTask', () => {
  it('creates a valid chunked task options structure', () => {
    const memory = createTestMemory();
    const provider = createStaticIdentityProvider();

    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: defaultBudget,
      distill: async () => '',
    });

    expect(task.name).toBe('soul-distillation');
    expect(task.priority).toBe('background');
    expect(task.initialState.scanned).toBe(0);
    expect(task.initialState.candidates).toEqual([]);
    expect(task.initialState.demotions).toEqual([]);
    expect(task.initialState.proposalGenerated).toBe(false);
  });

  it('completes without errors when there are no graduation candidates', async () => {
    const memory = createTestMemory();
    await memory.init();

    const provider = createStaticIdentityProvider();

    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: defaultBudget,
      distill: async () => '',
    });

    const finalState = await processAllChunks(task.processChunk, task.initialState);
    expect(finalState.candidates).toEqual([]);

    await memory.close();
  });

  it('entries below graduationConfidence are not considered', async () => {
    const memory = createTestMemory();
    await memory.init();

    // Add entries with low confidence
    await memory.remember('Low confidence insight', {
      confidence: 0.5,
      reinforcementCount: 10,
    });

    const provider = createStaticIdentityProvider();

    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: defaultBudget,
      graduationConfidence: 0.9,
      distill: async () => '',
    });

    const finalState = await processAllChunks(task.processChunk, task.initialState);
    expect(finalState.candidates).toHaveLength(0);

    await memory.close();
  });

  it('entries below graduationReinforcement are not considered', async () => {
    const memory = createTestMemory();
    await memory.init();

    // Add entries with high confidence but low reinforcement
    await memory.remember('High confidence but not reinforced', {
      confidence: 0.95,
      reinforcementCount: 1,
    });

    const provider = createStaticIdentityProvider();

    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: defaultBudget,
      graduationReinforcement: 3,
      distill: async () => '',
    });

    const finalState = await processAllChunks(task.processChunk, task.initialState);
    expect(finalState.candidates).toHaveLength(0);

    await memory.close();
  });

  it('identifies candidates that meet both confidence and reinforcement thresholds', async () => {
    const memory = createTestMemory();
    await memory.init();

    await memory.remember('Prefer TypeScript for new projects', {
      confidence: 0.95,
      reinforcementCount: 5,
    });

    await memory.remember('Always run tests before committing', {
      confidence: 0.92,
      reinforcementCount: 4,
    });

    const provider = createStaticIdentityProvider();
    let distillCalled = false;

    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: defaultBudget,
      distill: async (_currentSoul, candidates) => {
        distillCalled = true;
        return candidates.map((c) => c.content).join('\n');
      },
    });

    const finalState = await processAllChunks(task.processChunk, task.initialState);
    expect(finalState.candidates).toHaveLength(2);
    expect(distillCalled).toBe(true);

    await memory.close();
  });

  it('the proposal is stored as pending, not applied directly', async () => {
    const memory = createTestMemory();
    await memory.init();

    await memory.remember('Important principle', {
      confidence: 0.95,
      reinforcementCount: 5,
    });

    const provider = createStaticIdentityProvider({
      soul: [makeSoulItem('existing', 'Existing soul item')],
    });

    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: defaultBudget,
      distill: async (_soul, candidates) => candidates.map((c) => c.content).join('\n'),
    });

    await processAllChunks(task.processChunk, task.initialState);

    // The pending update should exist
    const pending = await provider.loadPendingSoulUpdate();
    expect(pending).toBeDefined();
    expect(pending!.length).toBeGreaterThan(0);

    // The current soul should still be the original
    const soul = await provider.loadSoul();
    expect(soul[0]!.content).toBe('Existing soul item');

    await memory.close();
  });

  it('derives graduated item id and updatedAt from an injected manual runtime rather than the real clock', async () => {
    const memory = createTestMemory();
    await memory.init();

    await memory.remember('Important principle', {
      confidence: 0.95,
      reinforcementCount: 5,
    });

    const provider = createStaticIdentityProvider();
    const runtime = createManualRuntimeServices({ origin: '2026-08-01T00:00:00.000Z' });

    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: defaultBudget,
      distill: async (_soul, candidates) => candidates.map((c) => c.content).join('\n'),
      runtime,
    });

    await processAllChunks(task.processChunk, task.initialState);

    const pending = await provider.loadPendingSoulUpdate();
    expect(pending).toBeDefined();
    const graduated = pending!.find((item) => item.source === 'graduated');
    expect(graduated).toBeDefined();
    expect(graduated!.id).toBe(`graduated-${runtime.clock.now()}-0`);
    expect(graduated!.updatedAt).toBe('2026-08-01T00:00:00.000Z');

    await memory.close();
  });

  it('distill function receives the current soul text and formatted candidates', async () => {
    const memory = createTestMemory();
    await memory.init();

    await memory.remember('Always validate inputs', {
      confidence: 0.95,
      reinforcementCount: 5,
      topic: 'safety',
    });

    const provider = createStaticIdentityProvider({
      soul: [makeSoulItem('1', 'Be helpful.')],
    });

    let receivedSoul = '';
    let receivedCandidates: Array<{ content: string; confidence: number; topic?: string }> = [];

    const task = createSoulDistillationTask({
      memory,
      provider,
      budget: defaultBudget,
      distill: async (currentSoul, candidates) => {
        receivedSoul = currentSoul;
        receivedCandidates = candidates;
        return candidates.map((c) => c.content).join('\n');
      },
    });

    await processAllChunks(task.processChunk, task.initialState);

    expect(receivedSoul).toBe('Be helpful.');
    expect(receivedCandidates).toHaveLength(1);
    expect(receivedCandidates[0]!.content).toBe('Always validate inputs');
    expect(receivedCandidates[0]!.confidence).toBe(0.95);
    expect(receivedCandidates[0]!.topic).toBe('safety');

    await memory.close();
  });
});
