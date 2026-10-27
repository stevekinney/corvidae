import { describe, expect, it } from 'bun:test';

import { waitForCondition } from './wait';

describe('waitForCondition', () => {
  it('keeps waiting as long as the awaited event needs real time', async () => {
    let ready = false;
    setTimeout(() => {
      ready = true;
    }, 100);

    // Each yield is one message-channel turn, so a count of turns would run out long before the
    // timer fires; the wait ends on the condition, or on the hang guard.
    await waitForCondition(() => ready, 'never ready');

    expect(ready).toBe(true);
  });

  it('resolves at once when the condition already holds', async () => {
    await waitForCondition(() => true, 'unreachable');
  });
});
