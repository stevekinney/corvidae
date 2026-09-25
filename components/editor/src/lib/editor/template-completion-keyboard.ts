import type { EditorView } from 'prosemirror-view';

import { acceptSuggestion } from './template-completion-acceptance.js';
import {
  templateCompletionPluginKey,
  type CompletionMeta,
  type CompletionState,
} from './template-completion-state.js';

function dispatchMeta(view: EditorView, meta: CompletionMeta): void {
  view.dispatch(view.state.tr.setMeta(templateCompletionPluginKey, meta));
}

/** Whether the popup is showing rows the keyboard can act on. */
export function isCompletionPopupOpen(view: EditorView): boolean {
  const state = templateCompletionPluginKey.getState(view.state);
  return Boolean(view.editable && state?.active && state.suggestions.length > 0);
}

function hasModifier(event: KeyboardEvent): boolean {
  return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
}

/**
 * Handle a keydown before any keymap sees it.
 *
 * - ArrowDown/ArrowUp move the active option and stop at the ends.
 * - Enter accepts the active option, never during IME composition.
 * - Tab dismisses without inserting and keeps its normal editor behavior
 *   (indent a list item, move between table cells, or move focus).
 * - Escape dismisses and is consumed only while the popup is open, so a
 *   second Escape reaches enclosing handlers.
 *
 * Home, End, Left, Right and text keys are never handled here.
 */
export function handleCompletionKeyDown(
  view: EditorView,
  event: KeyboardEvent,
  holdDismissalForCurrentKey: () => void = () => {},
): boolean {
  if (!isCompletionPopupOpen(view)) return false;
  if (event.isComposing || view.composing) return false;
  const state = templateCompletionPluginKey.getState(view.state);
  if (!state) return false;
  return handleOpenPopupKey(view, event, state, holdDismissalForCurrentKey);
}

function handleOpenPopupKey(
  view: EditorView,
  event: KeyboardEvent,
  state: CompletionState,
  holdDismissalForCurrentKey: () => void,
): boolean {
  const { suggestions, activeIndex } = state;
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !hasModifier(event)) {
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const nextIndex = Math.min(Math.max(activeIndex + delta, 0), suggestions.length - 1);
    if (nextIndex !== activeIndex) dispatchMeta(view, { type: 'navigate', index: nextIndex });
    event.preventDefault();
    return true;
  }

  if (event.key === 'Enter' && !hasModifier(event)) {
    const selected = suggestions[activeIndex];
    if (!selected) return false;
    acceptSuggestion(view, selected, state);
    event.preventDefault();
    return true;
  }

  if (event.key === 'Tab') {
    // Dismiss, then let Tab do what it normally does here: indent a list item,
    // move between table cells, or move focus. The dismissal survives the
    // document change that same keypress makes.
    holdDismissalForCurrentKey();
    dispatchMeta(view, { type: 'dismiss' });
    return false;
  }

  if (event.key !== 'Escape') return false;
  dispatchMeta(view, { type: 'dismiss' });
  event.preventDefault();
  event.stopPropagation();
  return true;
}
