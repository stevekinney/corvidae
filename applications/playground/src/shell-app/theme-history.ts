/**
 * Undo/redo transactions for one theme (COR-490). Each entry holds the editable state a
 * transaction produced; `baseline` is the state before the oldest retained entry. Eviction
 * drops only the oldest entries (folding their result into `baseline`), so the current
 * state is never lost. A continuous gesture, such as a slider drag, is one transaction.
 */

import { THEME_DATA_LIMITS } from './theme-draft-limits.ts';
import type { EditableState } from './theme-draft-types.ts';
import { jsonEquals } from './theme-override-tree.ts';

export type TransactionKind = 'edit' | 'reset' | 'import' | 'remediation';

export type HistoryEntry = { kind: TransactionKind; label: string; state: EditableState };

export type ThemeHistory = {
  baseline: EditableState;
  entries: readonly HistoryEntry[];
  /** How many entries are applied; the rest are redoable. */
  cursor: number;
  /** True once the cap evicted an entry; the UI shows the notice until dismissed. */
  limitNotice: boolean;
  /** Set between `beginGesture` and `endGesture`; `pushed` once its one entry exists. */
  gesture: { kind: TransactionKind; label: string; pushed: boolean } | null;
};

export function createHistory(initial: EditableState): ThemeHistory {
  return { baseline: initial, entries: [], cursor: 0, limitNotice: false, gesture: null };
}

export function currentState(history: ThemeHistory): EditableState {
  return history.cursor === 0
    ? history.baseline
    : (history.entries[history.cursor - 1]?.state ?? history.baseline);
}

const same = (left: EditableState, right: EditableState): boolean =>
  jsonEquals(left.overrides, right.overrides) && jsonEquals(left.cssOverrides, right.cssOverrides);

function capped(history: ThemeHistory): ThemeHistory {
  const excess = history.entries.length - THEME_DATA_LIMITS.historyTransactions;
  if (excess <= 0) return history;
  const evicted = history.entries.slice(0, excess);
  return {
    ...history,
    baseline: evicted[evicted.length - 1]?.state ?? history.baseline,
    entries: history.entries.slice(excess),
    cursor: Math.max(0, history.cursor - excess),
    limitNotice: true,
  };
}

/** Commit one transaction. Committing the current state again records nothing. */
export function commitTransaction(
  history: ThemeHistory,
  kind: TransactionKind,
  label: string,
  state: EditableState,
): ThemeHistory {
  const applied = history.entries.slice(0, history.cursor);
  const gesture = history.gesture;
  if (gesture?.pushed === true && applied.length > 0) {
    // Later samples of the same gesture replace the one entry it already owns.
    const last = applied[applied.length - 1];
    if (last !== undefined) {
      const entries = [...applied.slice(0, -1), { ...last, state }];
      return { ...history, entries, cursor: entries.length };
    }
  }
  if (same(currentState(history), state)) return history;
  const entries = [
    ...applied,
    { kind: gesture?.kind ?? kind, label: gesture?.label ?? label, state },
  ];
  const next: ThemeHistory = {
    ...history,
    entries,
    cursor: entries.length,
    gesture: gesture === null ? null : { ...gesture, pushed: true },
  };
  return capped(next);
}

/** Start a continuous gesture; every `commitTransaction` until `endGesture` is one entry. */
export function beginGesture(
  history: ThemeHistory,
  kind: TransactionKind,
  label: string,
): ThemeHistory {
  return { ...history, gesture: { kind, label, pushed: false } };
}

export function endGesture(history: ThemeHistory): ThemeHistory {
  return history.gesture === null ? history : { ...history, gesture: null };
}

export const canUndo = (history: ThemeHistory): boolean => history.cursor > 0;
export const canRedo = (history: ThemeHistory): boolean => history.cursor < history.entries.length;

/** The label an announcement or tooltip names for the next undo, or `null`. */
export function undoLabel(history: ThemeHistory): string | null {
  return history.entries[history.cursor - 1]?.label ?? null;
}

export function redoLabel(history: ThemeHistory): string | null {
  return history.entries[history.cursor]?.label ?? null;
}

export function undo(history: ThemeHistory): ThemeHistory {
  const settled = endGesture(history);
  return canUndo(settled) ? { ...settled, cursor: settled.cursor - 1 } : settled;
}

export function redo(history: ThemeHistory): ThemeHistory {
  const settled = endGesture(history);
  return canRedo(settled) ? { ...settled, cursor: settled.cursor + 1 } : settled;
}

export function dismissLimitNotice(history: ThemeHistory): ThemeHistory {
  return history.limitNotice ? { ...history, limitNotice: false } : history;
}

/** The persisted form: a gesture never outlives the session that began it. */
export function settledHistory(history: ThemeHistory): ThemeHistory {
  return endGesture(history);
}

// --- native text undo priority --------------------------------------------------------

/** The slice of an element the shortcut decision reads; a real `Element` satisfies it. */
export type FocusedElementLike = {
  tagName: string;
  type?: string;
  isContentEditable?: boolean;
  readOnly?: boolean;
  disabled?: boolean;
};

const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/**
 * True when Mod+Z should be left to the browser's native text undo: a focused, editable
 * text control or contenteditable region. Builder history runs only when this is false.
 */
export function shouldDeferUndoToNative(active: FocusedElementLike | null): boolean {
  if (active === null) return false;
  if (active.isContentEditable === true) return true;
  if (active.readOnly === true || active.disabled === true) return false;
  const tag = active.tagName.toLowerCase();
  if (tag === 'textarea') return true;
  if (tag !== 'input') return false;
  return !NON_TEXT_INPUT_TYPES.has((active.type ?? 'text').toLowerCase());
}
