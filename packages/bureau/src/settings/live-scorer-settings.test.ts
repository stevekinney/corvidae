/**
 * COR-2202 — `scorers.sampleRate` is read as each run finishes, not fixed when the Bureau was
 * built. The default is 0, so a scorer that is registered scores nothing until the owner raises
 * the rate; a rate outside 0 to 1 is refused on save; and only a run that settles `completed` is
 * ever scored, at any rate.
 *
 * COR-2205 — `scorers.dailyBudget` takes a non-negative integer and nothing else, has no default
 * (unset means no limit), and its count lives in the Bureau's own storage, so a second Bureau on
 * that storage continues it.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent, stopWhen } from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from '../agent-catalog.ts';
import type { Bureau } from '../bureau-types/facade.ts';
import { createBureau } from '../create-bureau.ts';
import { scorerBudgetKey } from '../scorers.ts';

type Generate = () => Promise<{ content: string; toolCalls: [] }>;

async function open(generate: Generate, optionRate = 0): Promise<Bureau<AgentDefinitions>> {
  return createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({ name: 'default', generate, stopWhen: stopWhen.noToolCalls() }),
    },
    storage: new MemoryStorage(),
    durable: false,
    scorers: {
      list: [{ name: 'quality', version: '1', score: () => ({ outcome: 'pass', message: 'ok' }) }],
      sampleRate: optionRate,
      rng: () => 0,
    },
  });
}

async function change(bureau: Bureau<AgentDefinitions>, patch: Record<string, unknown>) {
  const { revision } = await bureau.settings.get();
  return bureau.settings.update(patch, { expectedRevision: revision });
}

/** The status of a task, read in one step so a wait can name it. */
async function statusOf(bureau: Bureau<AgentDefinitions>, id: string) {
  const task = await bureau.tasks.get(id);
  return task?.status;
}

/** What is stored for a setting, if anything is. */
async function storedValueOf(bureau: Bureau<AgentDefinitions>, key: string) {
  const { values } = await bureau.settings.get();
  return (values as Record<string, unknown>)[key];
}

/** What is in force for a setting that nothing has set. */
async function effectiveValueOf(bureau: Bureau<AgentDefinitions>, key: string) {
  const { effective } = await bureau.settings.get();
  return (effective as Record<string, unknown>)[key];
}

async function settle(bureau: Bureau<AgentDefinitions>, status: 'completed' | 'failed') {
  const started = await bureau.tasks.start('default', 'go', { principal: 'api-key:alice' });
  await waitUntil(async () => (await statusOf(bureau, started.id)) === status, {
    message: `the run ${status}`,
  });
  await bureau.internals.taskRegistry.flush();
  await bureau.internals.scorerSampler!.flush();
  return started.id;
}

const recorded = (bureau: Bureau<AgentDefinitions>) =>
  bureau.internals.auditTrail!.query({ type: 'scorer.recorded' });

describe('scorers.sampleRate', () => {
  it('defaults to 0: a registered scorer scores nothing, and the sampler exists to take a rate', async () => {
    const bureau = await open(async () => ({ content: 'ok', toolCalls: [] }));
    try {
      expect(await effectiveValueOf(bureau, 'scorers.sampleRate')).toBe(0);
      expect(bureau.internals.scorerSampler).toBeDefined();

      await settle(bureau, 'completed');

      expect(await recorded(bureau)).toEqual([]);
      expect(bureau.internals.scorerSampler!.sampledCount()).toBe(0);
    } finally {
      await bureau.dispose();
    }
  });

  it('at 1, a run that settles completed records scorer.recorded (AC2)', async () => {
    const bureau = await open(async () => ({ content: 'ok', toolCalls: [] }));
    try {
      expect(await change(bureau, { 'scorers.sampleRate': 1 })).toMatchObject({
        outcome: 'applied',
      });

      const runId = await settle(bureau, 'completed');

      const records = await recorded(bureau);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        runId,
        detail: { judgeName: 'quality', outcome: 'pass', sampleRate: 1, definitionId: 'default' },
      });
    } finally {
      await bureau.dispose();
    }
  });

  it('applies to the next run to finish, up or down, with no restart', async () => {
    const bureau = await open(async () => ({ content: 'ok', toolCalls: [] }));
    try {
      await change(bureau, { 'scorers.sampleRate': 1 });
      await settle(bureau, 'completed');
      await change(bureau, { 'scorers.sampleRate': 0 });
      await settle(bureau, 'completed');

      expect(await recorded(bureau)).toHaveLength(1);
    } finally {
      await bureau.dispose();
    }
  });

  it('starts from the code option when nothing is stored', async () => {
    const bureau = await open(async () => ({ content: 'ok', toolCalls: [] }), 1);
    try {
      await settle(bureau, 'completed');
      expect(await recorded(bureau)).toHaveLength(1);
    } finally {
      await bureau.dispose();
    }
  });

  it('at 1, a run that settles failed is not sampled (AC3)', async () => {
    const bureau = await open(async () => {
      throw new Error('boom');
    });
    try {
      await change(bureau, { 'scorers.sampleRate': 1 });

      await settle(bureau, 'failed');

      expect(bureau.internals.scorerSampler!.observedCount()).toBe(0);
      expect(bureau.internals.scorerSampler!.sampledCount()).toBe(0);
      expect(await recorded(bureau)).toEqual([]);
    } finally {
      await bureau.dispose();
    }
  });

  it('at 1, a run that is canceled is not sampled (AC3)', async () => {
    const bureau = await open(() => new Promise<never>(() => {}));
    try {
      await change(bureau, { 'scorers.sampleRate': 1 });
      const started = await bureau.tasks.start('default', 'go', { principal: 'api-key:alice' });
      await waitUntil(async () => (await statusOf(bureau, started.id)) === 'working', {
        message: 'the run started',
      });

      await bureau.tasks.cancel(started.id);
      await waitUntil(async () => (await statusOf(bureau, started.id)) === 'canceled', {
        message: 'the run was canceled',
      });
      await bureau.internals.taskRegistry.flush();
      await bureau.internals.scorerSampler!.flush();

      expect(bureau.internals.scorerSampler!.sampledCount()).toBe(0);
      expect(await recorded(bureau)).toEqual([]);
    } finally {
      await bureau.dispose();
    }
  });

  it.each([
    ['below 0', -0.1],
    ['above 1', 1.1],
    ['not finite', Number.POSITIVE_INFINITY],
    ['not a number', 'half'],
  ])('refuses a rate that is %s on save (AC4)', async (_name, value) => {
    const bureau = await open(async () => ({ content: 'ok', toolCalls: [] }));
    try {
      expect(await change(bureau, { 'scorers.sampleRate': value })).toMatchObject({
        outcome: 'rejected',
        reason: 'invalid-value',
        keys: ['scorers.sampleRate'],
      });
      expect(await effectiveValueOf(bureau, 'scorers.sampleRate')).toBe(0);
    } finally {
      await bureau.dispose();
    }
  });

  it.each([0, 0.25, 1])('accepts a rate of %p on save', async (value) => {
    const bureau = await open(async () => ({ content: 'ok', toolCalls: [] }));
    try {
      expect(await change(bureau, { 'scorers.sampleRate': value })).toMatchObject({
        outcome: 'applied',
      });
    } finally {
      await bureau.dispose();
    }
  });
});

describe('the scorer sampler’s filters on a real Bureau (COR-2203)', () => {
  async function openFiltered(filters: {
    agents?: string[];
    kinds?: ('chat' | 'goal' | 'workflow')[];
  }): Promise<Bureau<AgentDefinitions>> {
    return createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          name: 'default',
          generate: async () => ({ content: 'ok', toolCalls: [] }),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: new MemoryStorage(),
      durable: false,
      scorers: {
        list: [
          { name: 'quality', version: '1', score: () => ({ outcome: 'pass', message: 'ok' }) },
        ],
        sampleRate: 1,
        rng: () => 0,
        ...filters,
      },
    });
  }

  it.each([
    ['a chat’s run is of kind chat', { kinds: ['chat'] as const }, 1],
    ['and is not of kind goal or workflow', { kinds: ['goal', 'workflow'] as const }, 0],
    ['and is of the agent that ran it', { agents: ['default'] }, 1],
    ['and is not of another agent', { agents: ['other'] }, 0],
  ] as const)('%s', async (_name, filters, scored) => {
    const bureau = await openFiltered({ ...filters } as never);
    try {
      await settle(bureau, 'completed');
      expect(await recorded(bureau)).toHaveLength(scored);
    } finally {
      await bureau.dispose();
    }
  });
});

describe('scorers.dailyBudget', () => {
  it.each([0, 1, 40, Number.MAX_SAFE_INTEGER])(
    'accepts a non-negative integer, %p, on save (AC1)',
    async (value) => {
      const bureau = await open(async () => ({ content: 'ok', toolCalls: [] }));
      try {
        expect(await change(bureau, { 'scorers.dailyBudget': value })).toMatchObject({
          outcome: 'applied',
        });
        expect(await storedValueOf(bureau, 'scorers.dailyBudget')).toBe(value);
      } finally {
        await bureau.dispose();
      }
    },
  );

  it.each([
    ['negative', -1],
    ['not whole', 1.5],
    ['text', '3'],
    ['not finite', Number.POSITIVE_INFINITY],
    ['not a number', Number.NaN],
    ['past the safe integers', 2 ** 53],
  ])('refuses a budget that is %s on save (AC1)', async (_name, value) => {
    const bureau = await open(async () => ({ content: 'ok', toolCalls: [] }));
    try {
      expect(await change(bureau, { 'scorers.dailyBudget': value })).toMatchObject({
        outcome: 'rejected',
        reason: 'invalid-value',
        keys: ['scorers.dailyBudget'],
      });
      expect(await storedValueOf(bureau, 'scorers.dailyBudget')).toBeUndefined();
    } finally {
      await bureau.dispose();
    }
  });

  it('has no default: unset means no limit', async () => {
    const bureau = await open(async () => ({ content: 'ok', toolCalls: [] }));
    try {
      const { effective, values } = await bureau.settings.get();
      expect(values['scorers.dailyBudget']).toBeUndefined();
      expect(Object.hasOwn(effective, 'scorers.dailyBudget')).toBe(false);
    } finally {
      await bureau.dispose();
    }
  });

  /** A Bureau on `storage` whose wall clock is `2026-11-16`, with one scorer at rate 1. */
  async function openOn(storage: MemoryStorage, id: string): Promise<Bureau<AgentDefinitions>> {
    return createBureau<AgentDefinitions>({
      id,
      agents: {
        default: createAgent({
          name: 'default',
          generate: async () => ({ content: 'ok', toolCalls: [] }),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      runtime: createManualRuntimeServices({ origin: '2026-11-16T12:00:00.000Z' }),
      storage,
      durable: false,
      scorers: {
        list: [
          { name: 'quality', version: '1', score: () => ({ outcome: 'pass', message: 'ok' }) },
        ],
        sampleRate: 1,
        rng: () => 0,
      },
    });
  }

  it('keeps the day’s count in the Bureau’s storage, so a restart and a second Bureau continue it (AC4)', async () => {
    const storage = new MemoryStorage();
    const first = await openOn(storage, 'budget-first');
    try {
      await change(first, { 'scorers.dailyBudget': 3 });
      await settle(first, 'completed');
      await settle(first, 'completed');
      expect(await recorded(first)).toHaveLength(2);
    } finally {
      await first.dispose();
    }
    // The count is in the Bureau's own storage, under the day's key, in decimal text.
    expect(
      await textValueStore(storage, { disposeUnderlyingStorage: false }).get(
        scorerBudgetKey('2026-11-16'),
      ),
    ).toBe('2');

    // A Bureau started later on that storage (a restart, or a second instance) sees the count, and
    // so the setting too, and takes the one unit that is left.
    const second = await openOn(storage, 'budget-second');
    try {
      await settle(second, 'completed');
      await settle(second, 'completed');
      expect(await recorded(second)).toHaveLength(3);
    } finally {
      await second.dispose();
    }
    expect(
      await textValueStore(storage, { disposeUnderlyingStorage: false }).get(
        scorerBudgetKey('2026-11-16'),
      ),
    ).toBe('3');
  });
});
