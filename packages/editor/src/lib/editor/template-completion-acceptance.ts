import type { PlaceholderCandidate } from '@repo/markdown';
import { TextSelection, type EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

import { templateCompletionPluginKey, type CompletionMeta } from './template-completion-state.js';
import { textOffsetToBlockDocumentPosition } from './template-position-utilities.js';

export function findTokenEnd(state: EditorState, tokenFrom: number): number | null {
  const $tokenFrom = state.doc.resolve(tokenFrom);
  const blockContentStart = $tokenFrom.start();
  const contentStart = tokenFrom + 2;
  if (contentStart >= $tokenFrom.end()) return null;

  const textFromContentStart = state.doc.textBetween(contentStart, $tokenFrom.end());
  const closingIndex = textFromContentStart.indexOf('}}');
  if (closingIndex === -1) return null;

  const textUpToContentStart = state.doc.textBetween(blockContentStart, contentStart);
  const closingDocPos = textOffsetToBlockDocumentPosition(
    $tokenFrom.parent,
    blockContentStart,
    textUpToContentStart.length + closingIndex,
  );
  return closingDocPos + 2;
}

export function acceptSuggestion(
  view: EditorView,
  suggestion: PlaceholderCandidate,
  tokenFrom: number,
): void {
  const replacementText = `{{${suggestion.path}}}`;
  const { state } = view;
  const tokenTo = findTokenEnd(state, tokenFrom) ?? state.selection.from;
  const transaction = state.tr
    .replaceWith(tokenFrom, tokenTo, state.schema.text(replacementText))
    .setMeta(templateCompletionPluginKey, { type: 'close' } satisfies CompletionMeta);
  transaction.setSelection(
    TextSelection.create(transaction.doc, tokenFrom + replacementText.length),
  );
  view.dispatch(transaction);
}
