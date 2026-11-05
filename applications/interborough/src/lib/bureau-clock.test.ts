/**
 * The Bureau's clock as the page reads it (COR-2014): the offset the latest stamped event says,
 * applied to the page's own clock, and the page's clock alone until an event has said.
 */
import { describe, expect, test } from 'bun:test';

import { BureauClock } from './bureau-clock.ts';

const PAGE = Date.parse('2026-11-05T15:00:00.000Z');
const BUREAU = Date.parse('2026-11-02T16:45:00.000Z');

describe('BureauClock', () => {
  test('agrees with the page until an event says otherwise', () => {
    const clock = new BureauClock(() => PAGE);
    expect(clock.now()).toBe(PAGE);
  });

  test('reads the Bureau’s time off an event’s timestamp and keeps counting with the page', () => {
    let page = PAGE;
    const clock = new BureauClock(() => page);
    clock.observe({ type: 'RUN_STARTED', timestamp: BUREAU });
    expect(clock.nowISO()).toBe('2026-11-02T16:45:00.000Z');
    page += 1_200;
    expect(clock.now()).toBe(BUREAU + 1_200);
  });

  test('keeps the last reading through an event with no timestamp, or one that is not a number', () => {
    const clock = new BureauClock(() => PAGE);
    clock.observe({ type: 'RUN_STARTED', timestamp: BUREAU });
    clock.observe({ type: 'TEXT_MESSAGE_CONTENT' });
    clock.observe({ type: 'TEXT_MESSAGE_CONTENT', timestamp: 'later' });
    clock.observe({ type: 'TEXT_MESSAGE_CONTENT', timestamp: Number.NaN });
    clock.observe(null);
    clock.observe('RUN_STARTED');
    expect(clock.now()).toBe(BUREAU);
  });
});
