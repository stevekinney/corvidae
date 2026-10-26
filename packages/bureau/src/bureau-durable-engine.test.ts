/**
 * `Bureau.durableEngine` hands out the engine that owns the bureau's runs, so a host serves Weft's
 * API over those runs through it instead of building a second engine over the same storage.
 */
import { stopWhen, createAgent } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import type { Bureau } from './types';
import type { AgentDefinitions } from './agent-catalog';

const bureaus: Bureau[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.shutdown();
});

async function bureauWith(options: { readonly durable: boolean }): Promise<Bureau> {
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate: async () => ({ content: 'done', toolCalls: [] }),
        toolbox: createToolbox([]),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    storage: { type: 'memory' },
    durable: options.durable,
  });
  bureaus.push(bureau);
  return bureau;
}

describe('Bureau.durableEngine', () => {
  it('is the engine that holds the bureau’s runs', async () => {
    const bureau = await bureauWith({ durable: true });
    const run = await bureau.createRun({ agentName: 'default', message: 'go' });
    await bureau.waitForDurableRun(run.id);

    const engine = bureau.durableEngine();

    expect(engine).toBeDefined();
    expect(await engine?.get(run.id)).toMatchObject({ id: run.id, status: 'completed' });
  });

  it('is the same engine on every call', async () => {
    const bureau = await bureauWith({ durable: true });

    expect(bureau.durableEngine()).toBe(bureau.durableEngine());
  });

  it('is undefined when the bureau composed no durable engine', async () => {
    const bureau = await bureauWith({ durable: false });

    expect(bureau.durableEngine()).toBeUndefined();
  });
});
