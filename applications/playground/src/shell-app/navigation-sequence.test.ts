import { describe, expect, test } from 'bun:test';

import {
  assertCurrent,
  createHistoryGeneration,
  createNavigationSequencer,
  fallbackNavigationMethod,
  SupersededNavigationError,
} from './navigation-sequence.ts';

describe('createNavigationSequencer', () => {
  test('keeps only the newest navigation current and aborts the older one', () => {
    const sequencer = createNavigationSequencer();
    const first = sequencer.begin();
    expect(first.isCurrent()).toBe(true);
    const second = sequencer.begin();
    expect(first.isCurrent()).toBe(false);
    expect(first.signal.aborted).toBe(true);
    expect(second.isCurrent()).toBe(true);
    expect(second.signal.aborted).toBe(false);
  });

  test('a superseded navigation never commits when its response arrives late', async () => {
    const sequencer = createNavigationSequencer();
    const committed: string[] = [];
    const respondLater: Array<() => void> = [];

    async function navigate(name: string): Promise<void> {
      const ticket = sequencer.begin();
      try {
        await new Promise<void>((resolve) => respondLater.push(resolve));
        assertCurrent(ticket);
        committed.push(name);
      } catch (error) {
        if (!(error instanceof SupersededNavigationError)) throw error;
      }
    }

    const staleNavigation = navigate('B');
    const latestNavigation = navigate('C');
    // The older response lands after the newer navigation began, and after it as well.
    respondLater[1]?.();
    respondLater[0]?.();
    await Promise.all([staleNavigation, latestNavigation]);

    expect(committed).toEqual(['C']);
  });

  test('assertCurrent throws only for a superseded ticket', () => {
    const sequencer = createNavigationSequencer();
    const stale = sequencer.begin();
    const latest = sequencer.begin();
    expect(() => assertCurrent(latest)).not.toThrow();
    expect(() => assertCurrent(stale)).toThrow(SupersededNavigationError);
  });
});

describe('createHistoryGeneration', () => {
  test('a visit sees that the reader stepped through history after it started', () => {
    const generation = createHistoryGeneration();
    const atStart = generation.read();
    expect(generation.read()).toBe(atStart);
    generation.advance();
    expect(generation.read()).not.toBe(atStart);
  });
});

describe('fallbackNavigationMethod', () => {
  test('replaces the entry once history was written and assigns before that', () => {
    expect(fallbackNavigationMethod(false)).toBe('assign');
    expect(fallbackNavigationMethod(true)).toBe('replace');
  });
});
