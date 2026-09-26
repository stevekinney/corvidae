import type {
  PlaceholderCandidate,
  PlaceholderCompletionConfiguration,
  PlaceholderValueKind,
} from '@lostgradient/markdown';
import type { EditorState, Transaction } from 'prosemirror-state';
import { PluginKey } from 'prosemirror-state';

import {
  detectTokenQuery,
  filterAndSortCandidates,
  mergeCandidates,
} from './template-completion-query.js';

const DEFAULT_MINIMUM_QUERY_LENGTH = 1;

export interface CompletionState {
  active: boolean;
  query: string;
  suggestions: PlaceholderCandidate[];
  activeIndex: number;
  tokenFrom: number;
  cursorPos: number;
}

export const INACTIVE_STATE: CompletionState = {
  active: false,
  query: '',
  suggestions: [],
  activeIndex: 0,
  tokenFrom: 0,
  cursorPos: 0,
};

export type CompletionMeta =
  | { type: 'close' }
  | { type: 'navigate'; index: number }
  | { type: 'asyncResults'; candidates: PlaceholderCandidate[] };

export const templateCompletionPluginKey = new PluginKey<CompletionState>('template-completion');

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCompletionMeta(value: unknown): value is CompletionMeta {
  if (!isRecord(value)) return false;
  if (value['type'] === 'close') return true;
  if (value['type'] === 'navigate') {
    return (
      typeof value['index'] === 'number' &&
      Number.isSafeInteger(value['index']) &&
      value['index'] >= 0
    );
  }
  return value['type'] === 'asyncResults' && isCandidateArray(value['candidates']);
}

function isValueKind(value: unknown): value is PlaceholderValueKind {
  return (
    value === 'string' ||
    value === 'number' ||
    value === 'boolean' ||
    value === 'array' ||
    value === 'object' ||
    value === 'unknown'
  );
}

function isCandidate(value: unknown): value is PlaceholderCandidate {
  if (!isRecord(value) || typeof value['path'] !== 'string' || !isValueKind(value['valueKind'])) {
    return false;
  }
  return value['description'] === undefined || typeof value['description'] === 'string';
}

function isCandidateArray(value: unknown): value is PlaceholderCandidate[] {
  return Array.isArray(value) && value.every(isCandidate);
}

function applyMeta(
  meta: CompletionMeta,
  previousState: CompletionState,
  configuration: PlaceholderCompletionConfiguration,
): CompletionState | undefined {
  if (meta.type === 'close') return INACTIVE_STATE;
  if (meta.type === 'navigate') {
    return meta.index < previousState.suggestions.length
      ? { ...previousState, activeIndex: meta.index }
      : undefined;
  }

  const suggestions = filterAndSortCandidates(
    mergeCandidates(configuration.candidates, meta.candidates),
    previousState.query,
  );
  if (suggestions.length === 0) return INACTIVE_STATE;

  return {
    ...previousState,
    suggestions,
    activeIndex: Math.min(previousState.activeIndex, suggestions.length - 1),
  };
}

function buildDetectedState(
  previousState: CompletionState,
  configuration: PlaceholderCompletionConfiguration,
  detected: NonNullable<ReturnType<typeof detectTokenQuery>>,
): CompletionState {
  const { query, tokenFrom, cursorPos } = detected;
  const minimumQueryLength = configuration.minimumQueryLength ?? DEFAULT_MINIMUM_QUERY_LENGTH;
  if (query.length < minimumQueryLength) return INACTIVE_STATE;

  const suggestions = filterAndSortCandidates(configuration.candidates, query);
  if (suggestions.length === 0) {
    return configuration.lookupCandidates
      ? { active: true, query, suggestions: [], activeIndex: 0, tokenFrom, cursorPos }
      : INACTIVE_STATE;
  }

  const activeIndex =
    previousState.active && previousState.query === query
      ? Math.min(previousState.activeIndex, suggestions.length - 1)
      : 0;
  return { active: true, query, suggestions, activeIndex, tokenFrom, cursorPos };
}

export function computeCompletionState(
  previousState: CompletionState,
  transaction: Transaction,
  editorState: EditorState,
  configuration: PlaceholderCompletionConfiguration | undefined,
): CompletionState {
  if (!configuration) return INACTIVE_STATE;

  const rawMeta: unknown = transaction.getMeta(templateCompletionPluginKey);
  const meta = isCompletionMeta(rawMeta) ? rawMeta : undefined;
  if (meta) {
    const metaState = applyMeta(meta, previousState, configuration);
    if (metaState) return metaState;
  }

  const detected = detectTokenQuery(editorState);
  return detected ? buildDetectedState(previousState, configuration, detected) : INACTIVE_STATE;
}
