/**
 * COR-2009 — a Bureau given a runtime (`BureauOptions.runtime`) runs its durable engine on that
 * runtime's clock, so what the engine stores, such as a schedule's next fire, is reckoned at the
 * Bureau's time, never at the process's. The showcase runs its sample world on an offset clock
 * this way.
 */
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent, stopWhen } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog.ts';
import { createBureau } from './create-bureau.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** Noon UTC on Wed, Oct 28, 2026: far from today, so a record on the process's clock cannot pass. */
const BUREAU_NOW = Date.parse('2026-10-28T12:00:00.000Z');

describe('a Bureau on an injected clock', () => {
  it('computes a schedule’s next fire on that clock', async () => {
    const real = createDefaultRuntimeServices();
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: async () => ({ content: 'Summarized.', toolCalls: [] }),
          toolbox: createToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: new MemoryStorage(),
      durable: true,
      maintenance: 'manual',
      runtime: {
        ...real,
        clock: { now: () => BUREAU_NOW, nowISO: () => new Date(BUREAU_NOW).toISOString() },
      },
    });
    cleanups.push(() => bureau.dispose());

    const summary = await bureau.schedules.create({
      agentName: 'default',
      input: 'Summarize yesterday.',
      spec: '0 9 * * *',
      timeZone: 'UTC',
    });
    expect(summary?.nextFireAt).toBe(Date.parse('2026-10-29T09:00:00.000Z'));
  });
});
