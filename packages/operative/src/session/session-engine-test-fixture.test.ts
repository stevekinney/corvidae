import { describe, expect, it } from 'bun:test';

import { createSessionEngine } from './session-engine-test-fixture';

describe('session engine test fixture', () => {
  it('keeps recovery result callbacks lazy and preserves their returned promise', async () => {
    let resultCalls = 0;
    const result = Promise.resolve('recovered');
    const engine = createSessionEngine({
      resume: async () => ({
        id: 'lazy-recovery',
        result: () => {
          resultCalls += 1;
          return result;
        },
      }),
    });

    const handle = await engine.resume('lazy-recovery');
    expect(resultCalls).toBe(0);
    expect(await handle.result()).toBe('recovered');
    expect(resultCalls).toBe(1);
    expect(await handle.result()).toBe('recovered');
    expect(resultCalls).toBe(2);
  });

  it('runs a configured start behavior at the prepared handle’s launch, not at prepare (COR-297)', async () => {
    const started: string[] = [];
    const engine = createSessionEngine({
      start: async (_type, _input, options) => {
        started.push(options.id);
        return { id: options.id, result: () => Promise.resolve('launched') };
      },
    });

    const prepared = await engine.prepare('agentRun', {}, { id: 'prepared-run' });
    expect(prepared.id).toBe('prepared-run');
    expect(started).toEqual([]);

    const handle = await prepared.launch();
    expect(started).toEqual(['prepared-run']);
    expect(await handle.result()).toBe('launched');
    await prepared.abandon();
  });
});
