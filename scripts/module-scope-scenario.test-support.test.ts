import { describe, expect, it } from 'bun:test';

import { outcomeOf, rethrow } from './module-scope-scenario.test-support.ts';

describe('outcomeOf', () => {
  it('records nothing when the scenario finishes', async () => {
    expect(() => rethrow(undefined)).not.toThrow();
    expect(await outcomeOf(() => undefined)).toBeUndefined();
  });

  it('records a failed assertion with its original message', async () => {
    const outcome = await outcomeOf(async () => {
      expect(2).toBe(3);
    });
    expect(() => rethrow(outcome)).toThrow('Expected: 3');
  });

  it('records a synchronous throw', async () => {
    const outcome = await outcomeOf(() => {
      throw new Error('synchronous failure');
    });
    expect(() => rethrow(outcome)).toThrow('synchronous failure');
  });

  it('substitutes an error when the scenario rejects with undefined', async () => {
    const outcome = await outcomeOf(() => Promise.reject(undefined));
    expect(() => rethrow(outcome)).toThrow('scenario failed');
  });

  it('reports a scenario that never settles as hung once the guard elapses', async () => {
    const outcome = await outcomeOf(() => new Promise<void>(() => {}), 5);
    expect(() => rethrow(outcome)).toThrow('scenario did not settle within 5 ms; it is hung');
  });
});
