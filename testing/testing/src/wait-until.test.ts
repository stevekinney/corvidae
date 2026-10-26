import { describe, expect, jest, test } from 'bun:test';
import { waitUntil, yieldEventLoopTurn } from './wait-until.ts';

describe('waitUntil', () => {
  test('returns at once when the condition already holds', async () => {
    await waitUntil(() => true);
  });

  test('keeps checking across event-loop turns however many it takes', async () => {
    let checks = 0;
    await waitUntil(() => {
      checks += 1;
      return checks > 500;
    });
    expect(checks).toBe(501);
  });

  test('awaits an asynchronous condition', async () => {
    let ready = false;
    setTimeout(() => {
      ready = true;
    }, 5);
    await waitUntil(async () => ready);
  });

  test('hands control back through the turn it was given', async () => {
    let turns = 0;
    await waitUntil(() => turns >= 3, {
      yieldTurn: async () => {
        turns += 1;
      },
    });
    expect(turns).toBe(3);
  });

  test('yields a macrotask, so a pending timer can run between checks', async () => {
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 0);
    await yieldEventLoopTurn();
    await yieldEventLoopTurn();
    await waitUntil(() => fired);
    expect(fired).toBe(true);
  });

  test('fails naming what it waited for once the hang guard elapses', async () => {
    // hang-guard-self-test: the condition never holds, so no load can satisfy it before the guard
    const waiting = waitUntil(() => false, {
      message: 'a signal that never comes',
      hangGuardMilliseconds: 20,
    });
    await expect(waiting).rejects.toThrow(
      'waitUntil gave up after 20ms of awake time waiting for a signal that never comes',
    );
  });

  test('keeps checking under fake timers, where awake time cannot be read', async () => {
    jest.useFakeTimers();
    try {
      let checks = 0;
      await waitUntil(() => ++checks > 3, { fakeTimersActive: () => true });
      expect(checks).toBe(4);
    } finally {
      jest.useRealTimers();
    }
  });
});
