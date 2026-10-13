import { describe, expect, it } from 'bun:test';

import { richNode } from './theme-draft-test-support.ts';
import { emptyOverrides, type EditableState } from './theme-draft-types.ts';
import {
  beginGesture,
  canRedo,
  canUndo,
  commitTransaction,
  createHistory,
  currentState,
  dismissLimitNotice,
  endGesture,
  redo,
  redoLabel,
  shouldDeferUndoToNative,
  undo,
  undoLabel,
} from './theme-history.ts';

const state = (n: number): EditableState => ({
  overrides: { ...emptyOverrides(), light: { token: { $value: n } } },
  cssOverrides: {},
});

describe('transactions', () => {
  it('commits one undoable transaction per edit, reset, import and remediation', () => {
    let history = createHistory(state(0));
    history = commitTransaction(history, 'edit', 'Edit accent', state(1));
    history = commitTransaction(history, 'reset', 'Reset field', state(2));
    history = commitTransaction(history, 'import', 'Import theme', state(3));
    history = commitTransaction(history, 'remediation', 'Fix contrast', state(4));
    expect(history.entries.map((entry) => entry.kind)).toEqual([
      'edit',
      'reset',
      'import',
      'remediation',
    ]);
    expect(currentState(history)).toEqual(state(4));
    expect(undoLabel(history)).toBe('Fix contrast');
  });

  it('undoes and redoes one transaction at a time, restoring metadata exactly', () => {
    const rich: EditableState = {
      overrides: { ...emptyOverrides(), shared: { a: richNode } },
      cssOverrides: { a: { 'dark/default': 'red' } },
    };
    let history = createHistory(state(0));
    history = commitTransaction(history, 'edit', 'Rich', rich);
    history = undo(history);
    expect(currentState(history)).toEqual(state(0));
    expect(canUndo(history)).toBe(false);
    expect(redoLabel(history)).toBe('Rich');
    history = redo(history);
    expect(currentState(history)).toEqual(rich);
    expect(canRedo(history)).toBe(false);
  });

  it('drops the redo branch on a new edit', () => {
    let history = createHistory(state(0));
    history = commitTransaction(history, 'edit', 'a', state(1));
    history = commitTransaction(history, 'edit', 'b', state(2));
    history = undo(history);
    history = commitTransaction(history, 'edit', 'c', state(3));
    expect(canRedo(history)).toBe(false);
    expect(history.entries.map((entry) => entry.label)).toEqual(['a', 'c']);
  });

  it('records nothing for a commit that changes nothing', () => {
    const history = createHistory(state(0));
    expect(commitTransaction(history, 'edit', 'noop', state(0))).toBe(history);
  });
});

describe('continuous gestures', () => {
  it('coalesces a slider drag into one transaction', () => {
    let history = createHistory(state(0));
    history = beginGesture(history, 'edit', 'Adjust radius');
    for (let n = 1; n <= 25; n += 1)
      history = commitTransaction(history, 'edit', 'ignored', state(n));
    history = endGesture(history);
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]?.label).toBe('Adjust radius');
    expect(currentState(history)).toEqual(state(25));
    expect(currentState(undo(history))).toEqual(state(0));
  });

  it('starts a new transaction after the gesture ends', () => {
    let history = beginGesture(createHistory(state(0)), 'edit', 'Drag');
    history = commitTransaction(history, 'edit', 'x', state(1));
    history = endGesture(history);
    history = commitTransaction(history, 'edit', 'Next', state(2));
    expect(history.entries).toHaveLength(2);
  });

  it('closes an open gesture when undo runs', () => {
    let history = beginGesture(createHistory(state(0)), 'edit', 'Drag');
    history = commitTransaction(history, 'edit', 'x', state(1));
    history = undo(history);
    expect(history.gesture).toBeNull();
    expect(currentState(history)).toEqual(state(0));
  });
});

describe('the 200 transaction cap', () => {
  function filled(count: number) {
    let history = createHistory(state(0));
    for (let n = 1; n <= count; n += 1)
      history = commitTransaction(history, 'edit', `e${n}`, state(n));
    return history;
  }

  it('keeps exactly 200 without a notice', () => {
    const history = filled(200);
    expect(history.entries).toHaveLength(200);
    expect(history.limitNotice).toBe(false);
  });

  it('drops only the oldest entry at 201 and raises the notice', () => {
    const history = filled(201);
    expect(history.entries).toHaveLength(200);
    expect(history.entries[0]?.label).toBe('e2');
    expect(history.limitNotice).toBe(true);
    expect(currentState(history)).toEqual(state(201));
    expect(history.baseline).toEqual(state(1));
  });

  it('never loses current state, even when undoing to the oldest retained entry', () => {
    let history = filled(250);
    expect(currentState(history)).toEqual(state(250));
    for (let n = 0; n < 200; n += 1) history = undo(history);
    expect(canUndo(history)).toBe(false);
    expect(currentState(history)).toEqual(state(50));
    expect(dismissLimitNotice(history).limitNotice).toBe(false);
  });
});

describe('native text undo priority', () => {
  it('defers to the browser while a text control is focused', () => {
    expect(shouldDeferUndoToNative({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(shouldDeferUndoToNative({ tagName: 'INPUT' })).toBe(true);
    expect(shouldDeferUndoToNative({ tagName: 'INPUT', type: 'number' })).toBe(true);
    expect(shouldDeferUndoToNative({ tagName: 'TEXTAREA' })).toBe(true);
    expect(shouldDeferUndoToNative({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('runs builder history when focus is not in an editable text control', () => {
    expect(shouldDeferUndoToNative(null)).toBe(false);
    expect(shouldDeferUndoToNative({ tagName: 'BUTTON' })).toBe(false);
    expect(shouldDeferUndoToNative({ tagName: 'INPUT', type: 'range' })).toBe(false);
    expect(shouldDeferUndoToNative({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(shouldDeferUndoToNative({ tagName: 'INPUT', type: 'text', readOnly: true })).toBe(false);
    expect(shouldDeferUndoToNative({ tagName: 'INPUT', type: 'text', disabled: true })).toBe(false);
  });
});
