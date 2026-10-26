import { describe, expect, it } from 'bun:test';

import { waitForCondition } from './wait';

describe('waitForCondition', () => {
  it('outlasts its attempt count when the awaited event needs real time', async () => {
    let ready = false;
    setTimeout(() => {
      ready = true;
    }, 100);

    // Each yield is one message-channel turn, so five attempts pass long before the timer fires.
    await waitForCondition(() => ready, 'never ready', 5);

    expect(ready).toBe(true);
  });

  it('resolves at once when the condition already holds', async () => {
    await waitForCondition(() => true, 'unreachable', 1);
  });
});
