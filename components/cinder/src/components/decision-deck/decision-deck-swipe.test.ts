import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_SWIPE_THRESHOLD,
  isVerticalGesture,
  resolveSwipeOutcome,
  resolveSwipeThreshold,
  swipeStampOpacity,
  swipeTransform,
} from './decision-deck-swipe.ts';

describe('swipe threshold', () => {
  test('defaults to 110 pixels', () => {
    expect(DEFAULT_SWIPE_THRESHOLD).toBe(110);
    expect(resolveSwipeThreshold(undefined)).toBe(110);
  });

  test('uses a positive finite threshold and falls back for anything else', () => {
    expect(resolveSwipeThreshold(60)).toBe(60);
    expect(resolveSwipeThreshold(0)).toBe(110);
    expect(resolveSwipeThreshold(-40)).toBe(110);
    expect(resolveSwipeThreshold(Number.NaN)).toBe(110);
    expect(resolveSwipeThreshold(Number.POSITIVE_INFINITY)).toBe(110);
  });
});

describe('swipe outcome', () => {
  test('a release short of the threshold decides nothing', () => {
    expect(resolveSwipeOutcome(0, 110)).toBeNull();
    expect(resolveSwipeOutcome(109, 110)).toBeNull();
    expect(resolveSwipeOutcome(-109, 110)).toBeNull();
  });

  test('a release at or past the threshold accepts to the right and rejects to the left', () => {
    expect(resolveSwipeOutcome(110, 110)).toBe('accept');
    expect(resolveSwipeOutcome(240, 110)).toBe('accept');
    expect(resolveSwipeOutcome(-110, 110)).toBe('reject');
    expect(resolveSwipeOutcome(-240, 110)).toBe('reject');
  });
});

describe('swipe stamp', () => {
  test('only the stamp for the dragged direction shows', () => {
    expect(swipeStampOpacity(55, 110, 'accept')).toBe(0.5);
    expect(swipeStampOpacity(55, 110, 'reject')).toBe(0);
    expect(swipeStampOpacity(-55, 110, 'reject')).toBe(0.5);
    expect(swipeStampOpacity(-55, 110, 'accept')).toBe(0);
  });

  test('the stamp is fully visible at the threshold and never brighter', () => {
    expect(swipeStampOpacity(110, 110, 'accept')).toBe(1);
    expect(swipeStampOpacity(400, 110, 'accept')).toBe(1);
    expect(swipeStampOpacity(0, 110, 'accept')).toBe(0);
  });
});

describe('swipe gesture helpers', () => {
  test('a mostly vertical move is a scroll, not a swipe', () => {
    expect(isVerticalGesture(4, 30)).toBe(true);
    expect(isVerticalGesture(30, 4)).toBe(false);
    expect(isVerticalGesture(10, 10)).toBe(false);
  });

  test('the card slides with the drag and tilts toward it', () => {
    expect(swipeTransform(40)).toBe('translateX(40px) rotate(2deg)');
    expect(swipeTransform(-40)).toBe('translateX(-40px) rotate(-2deg)');
  });
});
