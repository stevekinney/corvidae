import { stopWhen } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { spyOn } from 'bun:test';

import { createRuntimeComposition } from '../runtime-composition';
import { MemoryStorage } from '@lostgradient/storage';

type Prune = (
  workflowId: string,
  options: { keepLast: number; signal?: AbortSignal },
) => Promise<unknown>;

/** Spies on the durable engine's prune, which every bureau's engine shares through its prototype. */
export async function spyOnPrune() {
  const probe = await createRuntimeComposition({
    generate: () => Promise.resolve({ content: 'x', toolCalls: [] }),
    toolbox: createToolbox([]),
    storage: new MemoryStorage(),
    durable: true,
    stopWhen: stopWhen.noToolCalls(),
  });
  const prototype = Object.getPrototypeOf(probe.durable!.engine) as {
    pruneCheckpoints: Prune;
  };
  probe.durable!.engine[Symbol.dispose]?.();
  const original = prototype.pruneCheckpoints;
  return {
    spy: spyOn(prototype, 'pruneCheckpoints'),
    original,
    prunedIds: (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.map((call) => call[0] as string),
  };
}
