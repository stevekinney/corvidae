import { describe, expect, test } from 'bun:test';

import { createPendingCommandKey } from './pending-command-key.ts';

describe('the key of a pending command', () => {
  test('is reused by every retry of the same command', () => {
    const keys = createPendingCommandKey();
    expect(keys.keyFor('wait-1', 'staging')).toBe(keys.keyFor('wait-1', 'staging'));
  });

  test('is new for a changed answer, and for another wait', () => {
    const keys = createPendingCommandKey();
    const first = keys.keyFor('wait-1', 'staging');
    expect(keys.keyFor('wait-1', 'production')).not.toBe(first);
    expect(keys.keyFor('wait-2', 'production')).not.toBe(keys.keyFor('wait-1', 'production'));
  });

  test('is new for the next command once one is confirmed', () => {
    const keys = createPendingCommandKey();
    const first = keys.keyFor('wait-1', 'staging');
    keys.confirmed();
    expect(keys.keyFor('wait-1', 'staging')).not.toBe(first);
  });
});
