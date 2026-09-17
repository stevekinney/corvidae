import type { EditorView } from 'prosemirror-view';

import { acceptSuggestion } from './template-completion-acceptance.js';
import {
  templateCompletionPluginKey,
  type CompletionMeta,
  type CompletionState,
} from './template-completion-state.js';

function navigate(view: EditorView, index: number): void {
  view.dispatch(
    view.state.tr.setMeta(templateCompletionPluginKey, {
      type: 'navigate',
      index,
    } satisfies CompletionMeta),
  );
}

export function handleCompletionKeyDown(view: EditorView, event: KeyboardEvent): boolean {
  const pluginState = templateCompletionPluginKey.getState(view.state);
  if (!pluginState?.active) return false;
  return handleActiveKey(view, event, pluginState);
}

function handleActiveKey(view: EditorView, event: KeyboardEvent, state: CompletionState): boolean {
  const { suggestions, activeIndex, tokenFrom } = state;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (suggestions.length === 0) return false;
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    navigate(view, (activeIndex + delta + suggestions.length) % suggestions.length);
    event.preventDefault();
    return true;
  }

  if (event.key === 'Enter' || event.key === 'Tab') {
    const selected = suggestions[activeIndex];
    if (!selected) return false;
    acceptSuggestion(view, selected, tokenFrom);
    event.preventDefault();
    return true;
  }

  if (event.key !== 'Escape') return false;
  view.dispatch(
    view.state.tr.setMeta(templateCompletionPluginKey, { type: 'close' } satisfies CompletionMeta),
  );
  event.preventDefault();
  return true;
}
