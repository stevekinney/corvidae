import type { PlaceholderCandidate } from '@lostgradient/markdown';
import type { EditorState } from 'prosemirror-state';

import { textOffsetToBlockDocumentPosition } from './template-position-utilities.js';

export const MAXIMUM_VISIBLE_SUGGESTIONS = 8;
const VALID_QUERY_PATTERN = /^[a-zA-Z0-9_.]*$/;

export function detectTokenQuery(
  state: EditorState,
): { query: string; tokenFrom: number; cursorPos: number } | null {
  const { $from } = state.selection;
  const cursorPos = state.selection.from;
  if (state.selection.from !== state.selection.to || !$from.parent.isTextblock) return null;

  const blockContentStart = $from.start();
  const blockContentEnd = $from.end();
  const textBeforeCursor = state.doc.textBetween(blockContentStart, cursorPos);
  const fullText = state.doc.textBetween(blockContentStart, blockContentEnd);
  const openIndex = textBeforeCursor.lastIndexOf('{{');
  if (openIndex === -1) return null;

  const textBetween = textBeforeCursor.slice(openIndex + 2);
  if (textBetween.includes('}}')) return null;
  const closingIndex = fullText.slice(openIndex + 2).indexOf('}}');
  if (closingIndex !== -1 && closingIndex < textBeforeCursor.length - openIndex - 2) return null;

  const query = textBeforeCursor.slice(openIndex + 2).trim();
  if (!VALID_QUERY_PATTERN.test(query)) return null;

  return {
    query,
    tokenFrom: textOffsetToBlockDocumentPosition($from.parent, blockContentStart, openIndex),
    cursorPos,
  };
}

export function filterAndSortCandidates(
  candidates: PlaceholderCandidate[],
  query: string,
): PlaceholderCandidate[] {
  const lowerQuery = query.toLowerCase();
  return candidates
    .filter((candidate) => candidate.path.toLowerCase().startsWith(lowerQuery))
    .toSorted((a, b) => a.path.localeCompare(b.path))
    .slice(0, MAXIMUM_VISIBLE_SUGGESTIONS);
}

export function mergeCandidates(
  staticCandidates: PlaceholderCandidate[],
  asyncCandidates: PlaceholderCandidate[],
): PlaceholderCandidate[] {
  const seen = new Set(staticCandidates.map((candidate) => candidate.path));
  const merged = [...staticCandidates];
  for (const candidate of asyncCandidates) {
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    merged.push(candidate);
  }
  return merged;
}
