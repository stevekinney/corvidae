/**
 * The theme draft model (COR-490): immutable embedded base, context-scoped override source
 * nodes, a monotonically increasing last-valid revision, and an input buffer that holds
 * partial text apart from that revision. Every function is pure and returns a new draft;
 * the base is never edited, and unknown source metadata (`$extends`, `$ref`, `$extensions`,
 * descriptions, deprecation, provenance, recipe inputs) rides along inside the nodes.
 */

import {
  checkCssOverrideLimits,
  checkDocumentLimits,
  type LimitViolation,
} from './theme-draft-limits.ts';
import {
  editableState,
  OVERRIDE_SCOPES,
  type CssOverrides,
  type EditableState,
  type InputBufferEntry,
  type JsonValue,
  type OverrideScope,
  type ThemeContextId,
  type ThemeDraft,
  type ThemeEnvelope,
  type ThemeOverrides,
} from './theme-draft-types.ts';
import { getNode, jsonEquals, removeNode, setNode } from './theme-override-tree.ts';

export function createDraft(
  envelope: ThemeEnvelope,
  savedRevision: number | null = null,
): ThemeDraft {
  return { envelope, revision: 1, savedRevision, inputBuffer: {}, unsavedInput: false };
}

/** A draft restored from storage: clean at the stored revision. */
export function restoreDraft(
  envelope: ThemeEnvelope,
  revision: number,
  inputBuffer: Record<string, InputBufferEntry> = {},
): ThemeDraft {
  return { envelope, revision, savedRevision: revision, inputBuffer, unsavedInput: false };
}

export type DraftEdit =
  | { kind: 'set-override'; scope: OverrideScope; path: string; node: JsonValue }
  | { kind: 'remove-override'; scope: OverrideScope; path: string }
  | { kind: 'set-css-override'; path: string; context: ThemeContextId; value: string }
  | { kind: 'remove-css-override'; path: string; context: ThemeContextId }
  /** Import and remediation replace the editable state in one transaction. */
  | { kind: 'replace'; state: EditableState };

export type EditResult =
  { ok: true; draft: ThemeDraft; changed: boolean } | { ok: false; violations: LimitViolation[] };

function nextState(state: EditableState, edit: DraftEdit): EditableState {
  switch (edit.kind) {
    case 'replace':
      return edit.state;
    case 'set-override':
      return {
        ...state,
        overrides: {
          ...state.overrides,
          [edit.scope]: setNode(state.overrides[edit.scope], edit.path, edit.node),
        },
      };
    case 'remove-override':
      return {
        ...state,
        overrides: {
          ...state.overrides,
          [edit.scope]: removeNode(state.overrides[edit.scope], edit.path),
        },
      };
    case 'set-css-override':
      return {
        ...state,
        cssOverrides: {
          ...state.cssOverrides,
          [edit.path]: { ...state.cssOverrides[edit.path], [edit.context]: edit.value },
        },
      };
    case 'remove-css-override':
      return { ...state, cssOverrides: withoutCss(state.cssOverrides, edit.path, [edit.context]) };
  }
}

function withoutCss(
  cssOverrides: CssOverrides,
  path: string,
  contexts: readonly ThemeContextId[],
): CssOverrides {
  const current = cssOverrides[path];
  if (current === undefined) return cssOverrides;
  const remaining = { ...current };
  for (const context of contexts) delete remaining[context];
  const next = { ...cssOverrides };
  if (Object.keys(remaining).length === 0) delete next[path];
  else next[path] = remaining;
  return next;
}

function statesEqual(left: EditableState, right: EditableState): boolean {
  return (
    jsonEquals(left.overrides, right.overrides) && jsonEquals(left.cssOverrides, right.cssOverrides)
  );
}

/** Commit a validated state as the next revision, or report that nothing changed. */
export function commitState(draft: ThemeDraft, state: EditableState): EditResult {
  const current = editableState(draft.envelope);
  if (statesEqual(current, state)) return { ok: true, draft, changed: false };
  const violations = [
    ...checkDocumentLimits({ ...state.overrides }),
    ...checkCssOverrideLimits(state.cssOverrides),
  ];
  if (violations.length > 0) return { ok: false, violations };
  return {
    ok: true,
    changed: true,
    draft: {
      ...draft,
      envelope: { ...draft.envelope, overrides: state.overrides, cssOverrides: state.cssOverrides },
      revision: draft.revision + 1,
    },
  };
}

/** Apply one edit as a new revision. A no-op edit keeps the draft and its revision. */
export function applyEdit(draft: ThemeDraft, edit: DraftEdit): EditResult {
  return commitState(draft, nextState(editableState(draft.envelope), edit));
}

export type ResetScope =
  | { kind: 'field'; path: string }
  | { kind: 'category'; prefix: string }
  | { kind: 'color-mode'; colorMode: 'light' | 'dark' }
  | { kind: 'theme' };

const MODE_SCOPES: Record<'light' | 'dark', readonly OverrideScope[]> = {
  light: ['light'],
  dark: ['dark'],
};

const inCategory = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}.`);

/** Remove overrides at one scope; the embedded base is never touched. */
export function resetState(state: EditableState, scope: ResetScope): EditableState {
  switch (scope.kind) {
    case 'theme':
      return { overrides: emptyScopes(), cssOverrides: {} };
    case 'color-mode': {
      const overrides: ThemeOverrides = { ...state.overrides };
      for (const name of MODE_SCOPES[scope.colorMode]) overrides[name] = {};
      const cssOverrides: CssOverrides = {};
      for (const [path, byContext] of Object.entries(state.cssOverrides)) {
        const kept = Object.fromEntries(
          Object.entries(byContext).filter(
            ([context]) => !context.startsWith(`${scope.colorMode}/`),
          ),
        );
        if (Object.keys(kept).length > 0) cssOverrides[path] = kept;
      }
      return { overrides, cssOverrides };
    }
    case 'field': {
      let overrides = state.overrides;
      for (const name of OVERRIDE_SCOPES) {
        overrides = { ...overrides, [name]: removeNode(overrides[name], scope.path) };
      }
      return { overrides, cssOverrides: withoutCss(state.cssOverrides, scope.path, ALL_CONTEXTS) };
    }
    case 'category': {
      let overrides = state.overrides;
      for (const name of OVERRIDE_SCOPES) {
        overrides = { ...overrides, [name]: removeNode(overrides[name], scope.prefix) };
      }
      let cssOverrides = state.cssOverrides;
      for (const path of Object.keys(cssOverrides)) {
        if (inCategory(path, scope.prefix))
          cssOverrides = withoutCss(cssOverrides, path, ALL_CONTEXTS);
      }
      return { overrides, cssOverrides };
    }
  }
}

const ALL_CONTEXTS: readonly ThemeContextId[] = [
  'light/default',
  'light/reduced',
  'light/forced-reduced-motion',
  'dark/default',
  'dark/reduced',
  'dark/forced-reduced-motion',
];

function emptyScopes(): ThemeOverrides {
  return { shared: {}, light: {}, dark: {}, reduced: {}, forcedReduced: {} };
}

/** Reset at a scope; resetting nothing is a no-change result with no new revision. */
export function resetDraft(draft: ThemeDraft, scope: ResetScope): EditResult {
  return commitState(draft, resetState(editableState(draft.envelope), scope));
}

/** True when the scope has an override to remove, so Reset can be offered or disabled. */
export function hasOverridesAt(draft: ThemeDraft, scope: ResetScope): boolean {
  const state = editableState(draft.envelope);
  return !statesEqual(state, resetState(state, scope));
}

export function overrideAt(
  draft: ThemeDraft,
  scope: OverrideScope,
  path: string,
): JsonValue | undefined {
  return getNode(draft.envelope.overrides[scope], path);
}

/** Restore a history state as a new revision (undo and redo never rewind the counter). */
export function restoreState(draft: ThemeDraft, state: EditableState): ThemeDraft {
  const result = commitState(draft, state);
  return result.ok ? result.draft : draft;
}

// --- invalid-input buffer -------------------------------------------------------------

/** Keep partial text. It does not create a revision; preview keeps reading the last-valid one. */
export function setInput(draft: ThemeDraft, key: string, entry: InputBufferEntry): ThemeDraft {
  const existing = draft.inputBuffer[key];
  if (existing?.text === entry.text && existing.error === entry.error) return draft;
  return { ...draft, inputBuffer: { ...draft.inputBuffer, [key]: entry }, unsavedInput: true };
}

export function clearInput(draft: ThemeDraft, key: string): ThemeDraft {
  if (!Object.hasOwn(draft.inputBuffer, key)) return draft;
  const inputBuffer = { ...draft.inputBuffer };
  delete inputBuffer[key];
  return { ...draft, inputBuffer, unsavedInput: true };
}

/** Commit an edit that completes a buffered field: one revision, and the buffer entry clears. */
export function commitInput(draft: ThemeDraft, key: string, edit: DraftEdit): EditResult {
  const result = applyEdit(draft, edit);
  if (!result.ok) return result;
  return { ...result, draft: clearInput(result.draft, key) };
}

// --- rename and save bookkeeping -----------------------------------------------------

export function renameDraft(draft: ThemeDraft, name: string): ThemeDraft {
  if (draft.envelope.name === name) return draft;
  return { ...draft, envelope: { ...draft.envelope, name }, revision: draft.revision + 1 };
}

/**
 * Mark a successful save of `saved`. Edits made while the write was in flight stay dirty:
 * the revision comparison catches content, buffer identity catches partial input.
 */
export function markSaved(draft: ThemeDraft, saved: ThemeDraft): ThemeDraft {
  return {
    ...draft,
    savedRevision: saved.revision,
    unsavedInput: draft.inputBuffer === saved.inputBuffer ? false : draft.unsavedInput,
  };
}
