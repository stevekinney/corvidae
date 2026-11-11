import { describe, expect, test } from 'bun:test';
import {
  clampDragHeight,
  cycleDetent,
  detentHeight,
  DRAWER_DETENT_ORDER,
  nearestDetent,
  normalizeDetents,
  PEEK_DETENT_HEIGHT,
  resolveDetent,
  stepDetent,
} from './drawer-detents.ts';

const VIEWPORT = 800;

describe('normalizeDetents', () => {
  test('orders detents smallest first and drops duplicates', () => {
    expect(normalizeDetents(['large', 'peek', 'large', 'medium'])).toEqual([
      ...DRAWER_DETENT_ORDER,
    ]);
  });

  test('no list is no detents', () => {
    expect(normalizeDetents(undefined)).toEqual([]);
    expect(normalizeDetents([])).toEqual([]);
  });
});

describe('resolveDetent', () => {
  test('keeps a requested detent that is listed', () => {
    expect(resolveDetent(['peek', 'large'], 'large')).toBe('large');
  });

  test('falls back to the smallest listed detent', () => {
    expect(resolveDetent(['medium', 'large'], 'peek')).toBe('medium');
    expect(resolveDetent(['medium', 'large'], undefined)).toBe('medium');
  });

  test('no detents resolve to nothing', () => {
    expect(resolveDetent([], 'medium')).toBeUndefined();
  });
});

describe('detentHeight', () => {
  test('is a bar for peek, half the viewport for medium and 90% for large', () => {
    expect(detentHeight('peek', VIEWPORT)).toBe(PEEK_DETENT_HEIGHT);
    expect(detentHeight('medium', VIEWPORT)).toBe(400);
    expect(detentHeight('large', VIEWPORT)).toBe(720);
  });
});

describe('nearestDetent', () => {
  const all = [...DRAWER_DETENT_ORDER];

  test('snaps a height to the closest detent', () => {
    expect(nearestDetent(all, 90, VIEWPORT)).toBe('peek');
    expect(nearestDetent(all, 380, VIEWPORT)).toBe('medium');
    expect(nearestDetent(all, 700, VIEWPORT)).toBe('large');
  });

  test('only considers the listed detents', () => {
    expect(nearestDetent(['peek', 'large'], 400, VIEWPORT)).toBe('large');
  });
});

describe('stepDetent', () => {
  const all = [...DRAWER_DETENT_ORDER];

  test('moves one detent and stops at both ends', () => {
    expect(stepDetent(all, 'medium', 1)).toBe('large');
    expect(stepDetent(all, 'large', 1)).toBe('large');
    expect(stepDetent(all, 'medium', -1)).toBe('peek');
    expect(stepDetent(all, 'peek', -1)).toBe('peek');
  });
});

describe('cycleDetent', () => {
  test('steps up and wraps from the largest to the smallest', () => {
    const all = [...DRAWER_DETENT_ORDER];
    expect(cycleDetent(all, 'peek')).toBe('medium');
    expect(cycleDetent(all, 'large')).toBe('peek');
  });
});

describe('clampDragHeight', () => {
  test('holds a dragged height between the smallest and largest detents', () => {
    const all = [...DRAWER_DETENT_ORDER];
    expect(clampDragHeight(all, 10, VIEWPORT)).toBe(PEEK_DETENT_HEIGHT);
    expect(clampDragHeight(all, 500, VIEWPORT)).toBe(500);
    expect(clampDragHeight(all, 5000, VIEWPORT)).toBe(720);
  });

  test('uses the listed detents as the bounds', () => {
    expect(clampDragHeight(['medium', 'large'], 10, VIEWPORT)).toBe(400);
  });
});
