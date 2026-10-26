import { describe, expect, jest, test } from 'bun:test';
import { throwingRejectionOf } from './helpers/promise-outcome.ts';
import { awakeTurns, waitUntil, yieldEventLoopTurn } from './wait-until.ts';

describe('waitUntil', () => {
  test('returns at once when the condition already holds', async () => {
    await waitUntil(() => true);
  });

  test('keeps checking across event-loop turns however many it takes', async () => {
    let checks = 0;
    await waitUntil(() => {
      checks += 1;
      return checks > 300;
    });
    expect(checks).toBe(301);
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
    expect(await throwingRejectionOf(waiting)).toThrow(
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

describe('awakeTurns', () => {
  test('runs the loop body at once and again after each turn until the body breaks', async () => {
    const seen: number[] = [];
    for await (const turn of awakeTurns()) {
      seen.push(turn);
      if (turn === 3) break;
    }
    expect(seen).toEqual([0, 1, 2, 3]);
  });

  test('is not capped by a count of turns', async () => {
    let last = 0;
    for await (const turn of awakeTurns()) {
      last = turn;
      if (turn >= 250) break;
    }
    expect(last).toBe(250);
  });

  test('ends the loop once the hang guard elapses, leaving the code after it to fail', async () => {
    let turns = 0;
    // hang-guard-self-test: the loop body never breaks, so no load can end the loop early
    for await (const _turn of awakeTurns({ hangGuardMilliseconds: 20 })) {
      turns += 1;
    }
    expect(turns).toBeGreaterThan(0);
  });

  test('hands control back through the turn it was given', async () => {
    let handedBack = 0;
    for await (const turn of awakeTurns({
      yieldTurn: async () => {
        handedBack += 1;
      },
    })) {
      if (turn === 2) break;
    }
    expect(handedBack).toBe(2);
  });
});
