import { describe, expect, it } from 'bun:test';

import { HookRegistry, type OperativeHookMap } from '@lostgradient/operative';

import { createMemory } from '../src/create-memory';
import { createRunCaptureHook } from '../src/experiential';
import { createMemoryHooks } from '../src/hooks/create-memory-hooks';
import { createReflectionHook } from '../src/reflection';
import { createInMemoryMemoryRecordStorage, createMockEmbedder } from '../src/test/index';

/**
 * Memory's hooks are typed against structural stand-ins for operative's
 * contexts so the package needs no runtime dependency on operative. This
 * file compiles them against the real `OperativeHookMap`, so a stand-in that
 * drifts from operative (for example an optional field that rejects the
 * explicit `undefined` operative passes under `exactOptionalPropertyTypes`)
 * fails `typecheck` instead of failing in a consumer.
 */
describe('memory hooks register on an operative HookRegistry', () => {
  it('accepts the recall, capture, run-capture, and reflection hooks', () => {
    const memory = createMemory({
      embedder: createMockEmbedder(64),
      storage: createInMemoryMemoryRecordStorage(),
    });
    const memoryHooks = createMemoryHooks({ memory });
    const captureHook = createRunCaptureHook({ memory });
    const reflectionHook = createReflectionHook({
      memory,
      reflect: async (summary) => summary,
    });

    const hooks = new HookRegistry<OperativeHookMap>({ source: 'direct' });
    hooks.on('prepareStep', memoryHooks.prepareStep, { id: 'memory:recall', replay: 'safe' });
    hooks.on('afterToolExecution', memoryHooks.afterToolExecution, {
      id: 'memory:capture',
      replay: 'effectful',
    });
    hooks.on('onStep', captureHook.onStep, { id: 'memory:run-capture', replay: 'effectful' });
    hooks.on('onStep', reflectionHook.onStep, { id: 'memory:reflection', replay: 'effectful' });

    expect(hooks.describePlan().entries.map((entry) => entry.id)).toEqual([
      'memory:recall',
      'memory:capture',
      'memory:run-capture',
      'memory:reflection',
    ]);
  });
});
