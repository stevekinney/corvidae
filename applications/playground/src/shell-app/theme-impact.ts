/**
 * The impact of one proposed reference or recipe change (COR-488): every public value that
 * would change in the six concrete contexts, computed before anything is committed. The
 * proposal is applied to a copy of the draft and evaluated; the draft, its history and the
 * preview are not touched. The result is bound to the draft revision it was computed for, so
 * a superseded revision is detected and Apply is refused.
 *
 * Values are compared after `var()` substitution, because rebinding an alias changes what
 * every token that reads it resolves to without changing the text of those tokens' own CSS.
 * A changed value is never hidden: tokens that read the target and did not change are only
 * counted; everything that changed is listed once per path and context.
 */

import {
  AUTHORING_CATALOGUE,
  evaluateThemeProperties,
  type ThemeDiagnostic,
} from '@lostgradient/cinder/tokens/runtime';

import {
  editableState,
  THEME_CONTEXT_IDS,
  type EditableState,
  type JsonValue,
  type ThemeContextId,
  type ThemeDraft,
  type ThemeEnvelope,
} from './theme-draft-types.ts';
import { applyEdit, type DraftEdit } from './theme-draft.ts';
import type { ThemePreviewContext } from './theme-preview-message.ts';
import { trustedThemeSources } from './theme-recipe-trust.ts';
import { applyCssOverrides } from './theme-runtime-evaluator.ts';
import { evaluatedThemeOf, tokenEvaluationOf } from './theme-token-dependents.ts';
import { authoredValueOf, resolvedValueOf } from './theme-token-edit.ts';

export type ImpactRow = {
  path: string;
  context: ThemeContextId;
  before: string;
  after: string;
  role: 'target' | 'dependent' | 'other';
  /** True for a token with no CSS property: its value is the authored source value. */
  sourceOnly: boolean;
  /** The target's authored `$value` before and after, which can change while its value does not. */
  authored?: { before: string; after: string };
};

export type Impact =
  | {
      ok: true;
      /** The draft revision this was computed for. */
      revision: number;
      envelopeId: string;
      target: string;
      changed: readonly ImpactRow[];
      /** Dependents that read the target and kept their value, counted once per context. */
      unchanged: number;
      /** The exact state Apply commits, so what was shown is what lands. */
      state: EditableState;
    }
  | { ok: false; message: string; path: string | null };

const pathByProperty = new Map(
  AUTHORING_CATALOGUE.records.map((record) => [record.cssProperty, record.path] as const),
);
const propertyByPath = new Map(
  AUTHORING_CATALOGUE.records.map((record) => [record.path, record.cssProperty] as const),
);

const VARIABLE = /var\((--[\w-]+)\s*(?:,[^()]*)?\)/g;

/** Substitute `var()` references from a property map until none remain (or a cycle repeats). */
export function expandVariables(map: Readonly<Record<string, string>>, value: string): string {
  let current = value;
  for (let depth = 0; depth < 12; depth += 1) {
    const next = current.replace(VARIABLE, (whole, name: string) => map[name] ?? whole);
    if (next === current) return current;
    current = next;
  }
  return current;
}

const sourceText = (value: JsonValue | undefined): string =>
  value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);

type ContextValues = Record<ThemeContextId, Readonly<Record<string, string>>>;

function propertiesOf(envelope: ThemeEnvelope, contexts: ContextValues): ContextValues {
  return Object.fromEntries(
    THEME_CONTEXT_IDS.map((context) => [
      context,
      applyCssOverrides(contexts[context] ?? {}, envelope, context),
    ]),
  ) as ContextValues;
}

function diagnosticMessage(diagnostics: readonly ThemeDiagnostic[]): {
  message: string;
  path: string | null;
} {
  const first = diagnostics[0];
  if (first === undefined) return { message: 'The theme is invalid.', path: null };
  return { message: `${first.path}: ${first.reason}`, path: first.path };
}

/**
 * Compute the impact of `edits` on `draft`. `target` is the token the proposal is about.
 * A proposal the runtime rejects (a type mismatch, a cycle, a missing target, a CSS limit)
 * returns the runtime's path-addressed diagnostic and changes nothing.
 */
export function computeImpact(
  draft: ThemeDraft,
  target: string,
  edits: readonly DraftEdit[],
): Impact {
  let candidate = draft;
  for (const edit of edits) {
    const applied = applyEdit(candidate, edit);
    if (!applied.ok) {
      return {
        ok: false,
        message: `The proposal exceeds the ${applied.violations[0]?.code ?? 'data'} limit.`,
        path: target,
      };
    }
    candidate = applied.draft;
  }
  const before = evaluatedThemeOf(draft.envelope);
  if (!before.ok) return { ok: false, ...diagnosticMessage(before.diagnostics) };
  const after = evaluateThemeProperties(trustedThemeSources(candidate.envelope, 0));
  if (!after.ok) return { ok: false, ...diagnosticMessage(after.diagnostics) };

  const beforeMaps = propertiesOf(draft.envelope, before.properties as ContextValues);
  const afterMaps = propertiesOf(candidate.envelope, after.properties as ContextValues);
  const changed = new Map<string, ImpactRow>();
  const dependents = new Set<string>();
  let unchanged = 0;

  for (const context of THEME_CONTEXT_IDS) {
    const reads = new Set(
      (tokenEvaluationOf(before, context, target)?.dependents ?? []).map((item) => item.path),
    );
    for (const path of reads) dependents.add(`${path}@${context}`);
    const paths = new Set<string>([target, ...reads]);
    for (const [property, path] of pathByProperty) {
      const old = expandVariables(beforeMaps[context] ?? {}, beforeMaps[context]?.[property] ?? '');
      const next = expandVariables(afterMaps[context] ?? {}, afterMaps[context]?.[property] ?? '');
      if (old !== next) paths.add(path);
    }
    for (const path of paths) {
      const property = propertyByPath.get(path);
      const sourceOnly = property === undefined;
      const oldValue = sourceOnly
        ? sourceText(resolvedValueOf(draft.envelope, contextOf(context), path))
        : expandVariables(beforeMaps[context] ?? {}, beforeMaps[context]?.[property] ?? '');
      const newValue = sourceOnly
        ? sourceText(resolvedValueOf(candidate.envelope, contextOf(context), path))
        : expandVariables(afterMaps[context] ?? {}, afterMaps[context]?.[property] ?? '');
      const role = path === target ? 'target' : reads.has(path) ? 'dependent' : 'other';
      const authoredBefore = sourceText(authoredValueOf(draft.envelope, contextOf(context), path));
      const authoredAfter = sourceText(
        authoredValueOf(candidate.envelope, contextOf(context), path),
      );
      const representation = role === 'target' && authoredBefore !== authoredAfter;
      if (oldValue === newValue && !representation) {
        if (role === 'dependent') unchanged += 1;
        continue;
      }
      changed.set(`${path}@${context}`, {
        path,
        context,
        before: oldValue,
        after: newValue,
        role,
        sourceOnly,
        ...(role === 'target'
          ? { authored: { before: authoredBefore, after: authoredAfter } }
          : {}),
      });
    }
  }
  return {
    ok: true,
    revision: draft.revision,
    envelopeId: draft.envelope.id,
    target,
    changed: [...changed.values()],
    unchanged,
    state: editableState(candidate.envelope),
  };
}

function contextOf(context: ThemeContextId): ThemePreviewContext {
  const [colorMode, motion] = context.split('/') as [ThemePreviewContext['colorMode'], string];
  return { colorMode, motion } as ThemePreviewContext;
}

/** True while the draft is still at the revision the impact was computed for. */
export function impactIsCurrent(impact: Impact, draft: ThemeDraft | null): boolean {
  return (
    impact.ok &&
    draft !== null &&
    impact.revision === draft.revision &&
    impact.envelopeId === draft.envelope.id
  );
}
