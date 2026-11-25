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

  test('restores a deleted step in its moved and renamed list without changing the surviving keys', () => {
    const keys = new StepKeys();
    keys.keysOf(ROOT, 2);
    const original = ['steps', 0, 'cases', 'old'] as const;
    const [before, deleted, after] = keys.keysOf(original, 3);
    const nested = keys.keysOf([...original, 2, 'steps'], 1);
    const undo = keys.undoPosition(original, 1);
    keys.removed(original, 1);
    keys.slotRenamed(original, 'new');
    keys.moved(ROOT, 0, 1);

    const current = ['steps', 1, 'cases', 'new'] as const;
    const target = undo?.();
    expect(target).toMatchObject({ list: current, index: 1, key: deleted });
    if (target === undefined) throw new Error('Expected a restore position.');
    keys.inserted(target);
    expect(keys.keysOf(current, 3)).toEqual([before, deleted, after]);
    expect(keys.keysOf([...current, 2, 'steps'], 1)).toEqual(nested);
  });

  test.each([
    ['C', 'B'],
    ['B', 'C'],
  ])('restores adjacent deletions in order when Undo uses %s then %s', (first, second) => {
    const keys = new StepKeys();
    const original = keys.keysOf(ROOT, 4);
    const undoC = keys.undoPosition(ROOT, 2);
    keys.removed(ROOT, 2);
    const undoB = keys.undoPosition(ROOT, 1);
    keys.removed(ROOT, 1);
    for (const name of [first, second]) {
      const target = (name === 'C' ? undoC : undoB)?.();
      if (target === undefined) throw new Error('Expected a restore position.');
      keys.inserted(target);
    }
    expect(keys.keysOf(ROOT, 4)).toEqual(original);
  });

  test('restores a child after Undo restores its deleted parent', () => {
    const keys = new StepKeys();
    keys.keysOf(ROOT, 1);
    const list = ['steps', 0, 'steps'] as const;
    const children = keys.keysOf(list, 2);
    const undoChild = keys.undoPosition(list, 0);
    keys.removed(list, 0);
    const undoParent = keys.undoPosition(ROOT, 0);
    keys.removed(ROOT, 0);
    const parent = undoParent?.();
    if (parent === undefined) throw new Error('Expected the parent’s restore position.');
    keys.inserted(parent);
    const child = undoChild?.();
    if (child === undefined) throw new Error('Expected the child’s restore position.');
    keys.inserted(child);
    expect(keys.keysOf(list, 2)).toEqual(children);
  });

  test('never restores into a replacement list at the same path', () => {
    const keys = new StepKeys();
    const slot = ['steps', 0, 'cases', 'x'] as const;
    keys.keysOf(slot, 1);
    const undo = keys.undoPosition(slot, 0);
    keys.removed(slot, 0);
    keys.slotRemoved(slot);
    keys.keysOf(slot, 1);
    expect(undo?.()).toBeUndefined();
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
