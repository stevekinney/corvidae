/**
 * The workflow types `createRunEngine` registers are the types a host that schedules by type
 * reserves, and the module that lists them is safe for a browser to read.
 */
import { Engine, MemoryStorage, workflow } from '@lostgradient/weft';
import { describe, expect, it, spyOn } from 'bun:test';

import { createRunEngine } from './create-run-engine';
import { RUN_ENGINE_WORKFLOW_TYPE, RUN_ENGINE_WORKFLOW_TYPES } from './run-engine-workflow-types';

const named = (name: string) =>
  workflow({ name }).execute(async function* (ctx) {
    return yield* ctx.run(() => Promise.resolve('idle'));
  });

/** The types `createRunEngine` handed to `Engine.create`, which is the engine's whole registry. */
async function registeredTypes(withGoal: boolean): Promise<string[]> {
  const create = spyOn(Engine, 'create');
  try {
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: named('agentRun'),
      ...(withGoal ? { goalWorkflow: named('goalRun') } : {}),
      recover: false,
    });
    engine[Symbol.dispose]();
    const registry = create.mock.calls[0]?.[0]?.workflows;
    return Object.keys(registry ?? {}).toSorted();
  } finally {
    create.mockRestore();
  }
}

describe('the types a Bureau’s run engine registers', () => {
  it('are the agent run, the heartbeat tick, and the goal', () => {
    expect([...RUN_ENGINE_WORKFLOW_TYPES].toSorted()).toEqual([
      'agentRun',
      'durableHeartbeatTick',
      'goalRun',
    ]);
    expect(RUN_ENGINE_WORKFLOW_TYPE.agentRun).toBe('agentRun');
  });

  it('are exactly the types the engine registers when it runs durable goals', async () => {
    expect(await registeredTypes(true)).toEqual([...RUN_ENGINE_WORKFLOW_TYPES].toSorted());
  });

  it('leave out the goal only when the host runs none', async () => {
    expect(await registeredTypes(false)).toEqual(['agentRun', 'durableHeartbeatTick']);
  });

  it('are listed by a module that imports nothing, so a browser can read them alone', async () => {
    const source = await Bun.file(
      new URL('./run-engine-workflow-types.ts', import.meta.url),
    ).text();
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(/);
  });
});
