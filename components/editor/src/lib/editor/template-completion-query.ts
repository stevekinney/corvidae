import { parsePlaceholderTokens, type PlaceholderCandidate } from '@lostgradient/markdown';
import type { Mark } from 'prosemirror-model';
import type { EditorState } from 'prosemirror-state';

import { findRunBeforeCaret } from './template-placeholder-runs.js';

/** Rows visible at once; further matches stay reachable by scrolling. */
export const MAXIMUM_VISIBLE_SUGGESTIONS = 8;
const VALID_QUERY_PATTERN = /^[a-zA-Z0-9_.]*$/;
const PATH_CHARACTERS = /^[a-zA-Z0-9_.]*/;

/** The in-progress token around a collapsed caret. */
export interface DetectedTokenQuery {
  /** Text typed between the opening delimiter and the caret, without leading whitespace. */
  query: string;
  /** Document position of the opening `{{`. */
  tokenFrom: number;
  /** Document position where the in-progress token ends. */
  tokenTo: number;
  /** Document position of the caret. */
  cursorPos: number;
  /** Marks shared by the token's run; an accepted replacement keeps them. */
  marks: readonly Mark[];
}

/**
 * Find the placeholder token being typed at the caret.
 *
 * The token must lie in one eligible same-mark run (see
 * `template-placeholder-runs.ts`), the selection must be collapsed, and the
 * caret must sit after the opening delimiter and before any closing one. The
 * token ends at its closing delimiter when everything between the caret and
 * that delimiter is path characters (ignoring spaces and tabs). Otherwise, and
 * for an unclosed token, it ends after the path characters that follow the
 * caret, so prose after it is never replaced.
 */
export function detectTokenQuery(state: EditorState): DetectedTokenQuery | null {
  const found = findRunBeforeCaret(state);
  if (!found) return null;
  const { run, offset } = found;
  const token = parsePlaceholderTokens(run.text).find((candidate) => {
    const bodyStart = candidate.startOffset + 2;
    const bodyEnd =
      candidate.kind === 'placeholder' ? candidate.endOffset - 2 : candidate.endOffset;
    return bodyStart <= offset && offset <= bodyEnd;
  });
  if (!token) return null;

  const query = run.text.slice(token.startOffset + 2, offset).trim();
  if (!VALID_QUERY_PATTERN.test(query)) return null;

  const closedPathBody =
    token.kind === 'placeholder' &&
    VALID_QUERY_PATTERN.test(trimHorizontalWhitespace(run.text.slice(offset, token.endOffset - 2)));
  const endOffset = closedPathBody
    ? token.endOffset
    : offset + (PATH_CHARACTERS.exec(run.text.slice(offset))?.[0].length ?? 0);
  return {
    query,
    tokenFrom: run.from + token.startOffset,
    tokenTo: run.from + endOffset,
    cursorPos: state.selection.from,
    marks: run.marks,
  };
}

function trimHorizontalWhitespace(text: string): string {
  return text.replace(/^[ \t]+|[ \t]+$/g, '');
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Every candidate whose path starts with `query`, ignoring case, sorted by
 * canonical path in code-unit order. Insertion and resolution stay
 * case-sensitive; only the filter ignores case.
 */
export function filterAndSortCandidates(
  candidates: readonly PlaceholderCandidate[],
  query: string,
): PlaceholderCandidate[] {
  const lowerQuery = query.toLowerCase();
  return candidates
    .filter((candidate) => candidate.path.toLowerCase().startsWith(lowerQuery))
    .toSorted((a, b) => compareCodeUnits(a.path, b.path));
}

export function mergeCandidates(
  staticCandidates: readonly PlaceholderCandidate[],
  asyncCandidates: readonly PlaceholderCandidate[],
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
