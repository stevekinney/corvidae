/**
 * The identity a step keeps while its neighbours move: a key never built from an index or from
 * content, which a move carries with the step (and with every step nested in it), a removal takes
 * away, and an edit the builder did not make forgets.
 */
import { describe, expect, test } from 'bun:test';

import { StepKeys } from './workflow-step-keys.svelte.ts';

const ROOT = ['steps'] as const;

describe('the keys of a list of steps', () => {
  test('gives each step a key of its own, and the same key each time it is asked', () => {
    const keys = new StepKeys();
    const first = keys.keysOf(ROOT, 3);
    expect(new Set(first).size).toBe(3);
    expect(keys.keysOf(ROOT, 3)).toEqual(first);
    // A step added later gets a new key and leaves the others as they were.
    const grown = keys.keysOf(ROOT, 4);
    expect(grown.slice(0, 3)).toEqual(first);
    expect(first).not.toContain(grown[3]);
    // A step the text lost is dropped from the end.
    expect(keys.keysOf(ROOT, 2)).toEqual(first.slice(0, 2));
  });

  test('moves a key with its step, and every key nested in the step with it', () => {
    const keys = new StepKeys();
    const [a, b, c] = keys.keysOf(ROOT, 3) as [string, string, string];
    const inA = keys.keysOf(['steps', 0, 'cases', 'x'], 2);
    const inB = keys.keysOf(['steps', 1, 'steps'], 1);
    keys.moved(ROOT, 0, 1);
    expect(keys.keysOf(ROOT, 3)).toEqual([b, a, c]);
    // The step that was first is second now, and its case's keys are at its new path.
    expect(keys.keysOf(['steps', 1, 'cases', 'x'], 2)).toEqual(inA);
    expect(keys.keysOf(['steps', 0, 'steps'], 1)).toEqual(inB);
    keys.moved(ROOT, 1, -1);
    expect(keys.keysOf(ROOT, 3)).toEqual([a, b, c]);
    expect(keys.keysOf(['steps', 0, 'cases', 'x'], 2)).toEqual(inA);
  });

  test('drops the keys of a removed step and what it held, and shifts the steps after it up', () => {
    const keys = new StepKeys();
    const [a, b, c] = keys.keysOf(ROOT, 3) as [string, string, string];
    keys.keysOf(['steps', 0, 'steps'], 1);
    const inC = keys.keysOf(['steps', 2, 'steps'], 2);
    keys.removed(ROOT, 0);
    expect(keys.keysOf(ROOT, 2)).toEqual([b, c]);
    expect(a).not.toBe(b);
    // The step that was third is second now; the removed step's list is gone, never inherited.
    expect(keys.keysOf(['steps', 1, 'steps'], 2)).toEqual(inC);
    expect(keys.keysOf(['steps', 2, 'steps'], 1)).toHaveLength(1);
  });

  test('follows a case that is renamed, and forgets one that is removed', () => {
    const keys = new StepKeys();
    keys.keysOf(ROOT, 1);
    const inside = keys.keysOf(['steps', 0, 'cases', 'old'], 2);
    keys.slotRenamed(['steps', 0, 'cases', 'old'], 'new');
    expect(keys.keysOf(['steps', 0, 'cases', 'new'], 2)).toEqual(inside);
    keys.slotRemoved(['steps', 0, 'cases', 'new']);
    expect(keys.keysOf(['steps', 0, 'cases', 'new'], 2)).not.toEqual(inside);
  });

  test('counts every change, so a list that read the keys reads them again, and forgets all of them on a reset', () => {
    const keys = new StepKeys();
    const before = keys.keysOf(ROOT, 2);
    const version = keys.version;
    keys.moved(ROOT, 0, 1);
    expect(keys.version).toBe(version + 1);
    keys.reset();
    expect(keys.version).toBe(version + 2);
    const after = keys.keysOf(ROOT, 2);
    for (const key of after) expect(before).not.toContain(key);
  });
});
