/**
 * The pure side of alias rebinding, detaching and recipe overrides (COR-488). Each proposal
 * is built as ordinary draft edits through the same `buildEdit` the typed editors use, so a
 * rebound alias keeps the metadata of the override it replaces, and is then run through
 * `computeImpact`: the runtime's path-addressed diagnostic rejects a cycle or a type change,
 * and nothing is committed until the author applies the revision-bound result.
 */

import type { CatalogueRow } from './theme-builder-catalogue.ts';
import type { ThemeContextId, ThemeDraft, OverrideScope } from './theme-draft-types.ts';
import { THEME_CONTEXT_IDS } from './theme-draft-types.ts';
import { computeImpact, type Impact } from './theme-impact.ts';
import type { DraftEdit } from './theme-draft.ts';
import type { ThemePreviewContext } from './theme-preview-message.ts';
import { evaluatedThemeOf, tokenEvaluationOf } from './theme-token-dependents.ts';
import { buildEdit, literalValueOf, validateCssForRow, valueToText } from './theme-token-edit.ts';

export type AliasCandidate = { path: string; type: string };

const typeIn = (
  draft: ThemeDraft,
  context: ThemeContextId,
  path: string,
): string | undefined => {
  const evaluated = evaluatedThemeOf(draft.envelope);
  return tokenEvaluationOf(evaluated, context, path)?.provenance.effectiveType.type;
};

/**
 * Tokens the row may alias: the same effective type in every context where both exist, not
 * the row itself, and not a token that already reads the row (that would be a cycle). A
 * theme that does not evaluate has no candidates.
 */
export function aliasCandidates(
  draft: ThemeDraft,
  row: Pick<CatalogueRow, 'path'>,
  query: string,
  limit = 50,
): { items: readonly AliasCandidate[]; total: number } {
  const evaluated = evaluatedThemeOf(draft.envelope);
  if (!evaluated.ok) return { items: [], total: 0 };
  const needle = query.trim().toLowerCase();
  const reading = new Set<string>([row.path]);
  for (const context of THEME_CONTEXT_IDS) {
    for (const dependent of tokenEvaluationOf(evaluated, context, row.path)?.dependents ?? []) {
      reading.add(dependent.path);
    }
  }
  const found: AliasCandidate[] = [];
  const first = evaluated.index.get(THEME_CONTEXT_IDS[0]!);
  for (const path of first?.keys() ?? []) {
    if (reading.has(path) || (needle !== '' && !path.toLowerCase().includes(needle))) continue;
    const type = typeIn(draft, THEME_CONTEXT_IDS[0]!, path);
    if (type === undefined || type === 'unknown') continue;
    const compatible = THEME_CONTEXT_IDS.every((context) => {
      const own = typeIn(draft, context, row.path);
      return own === undefined || typeIn(draft, context, path) === own;
    });
    if (!compatible) continue;
    found.push({ path, type });
  }
  return { items: found.slice(0, limit), total: found.length };
}

/** The first context in which `target` cannot stand in for the row, as a diagnostic. */
export function incompatibility(
  draft: ThemeDraft,
  row: Pick<CatalogueRow, 'path'>,
  target: string,
): string | undefined {
  const evaluated = evaluatedThemeOf(draft.envelope);
  if (!evaluated.ok) return `${row.path}: the theme is not valid, so ${target} cannot be checked.`;
  if (target === row.path) return `${row.path}: a token cannot alias itself.`;
  if (tokenEvaluationOf(evaluated, THEME_CONTEXT_IDS[0]!, target) === undefined) {
    return `${row.path}: ${target} does not exist, so it cannot be an alias target.`;
  }
  for (const context of THEME_CONTEXT_IDS) {
    const own = typeIn(draft, context, row.path);
    const other = typeIn(draft, context, target);
    if (own !== undefined && other !== own) {
      return `${row.path}: ${target} is ${other ?? 'untyped'} in ${context}, but this token is ${own}.`;
    }
    if (tokenEvaluationOf(evaluated, context, row.path)?.dependents.some((d) => d.path === target)) {
      return `${row.path}: ${target} already reads this token, so aliasing it would be a cycle.`;
    }
  }
  return undefined;
}

export type Proposal =
  | { ok: true; impact: Extract<Impact, { ok: true }> }
  | { ok: false; message: string; path: string | null };

function impactOf(draft: ThemeDraft, row: CatalogueRow, edits: readonly DraftEdit[]): Proposal {
  const impact = computeImpact(draft, row.path, edits);
  return impact.ok ? { ok: true, impact } : impact;
}

/** Rebind the row's alias in `scope` to `target`, with every consequence computed. */
export function proposeRebind(
  draft: ThemeDraft,
  row: CatalogueRow,
  context: ThemePreviewContext,
  scope: OverrideScope | null,
  target: string,
): Proposal {
  const problem = incompatibility(draft, row, target);
  if (problem !== undefined) return { ok: false, message: problem, path: row.path };
  const built = buildEdit(row, draft.envelope, context, scope, `{${target}}`);
  if (!built.ok) return { ok: false, message: `${row.path}: ${built.message}`, path: row.path };
  return impactOf(draft, row, [built.edit]);
}

/** Replace the row's alias with the literal it resolves to; the author chose this explicitly. */
export function proposeDetach(
  draft: ThemeDraft,
  row: CatalogueRow,
  context: ThemePreviewContext,
  scope: OverrideScope | null,
): Proposal {
  const literal = literalValueOf(draft.envelope, context, row.path);
  if (literal === undefined) {
    return {
      ok: false,
      message: `${row.path}: no literal value could be read, so it cannot be detached.`,
      path: row.path,
    };
  }
  const built = buildEdit(row, draft.envelope, context, scope, valueToText(literal));
  if (!built.ok) return { ok: false, message: `${row.path}: ${built.message}`, path: row.path };
  return impactOf(draft, row, [built.edit]);
}

/** A complete CSS value for the row in one context, or in all six. */
export function proposeCssOverride(
  draft: ThemeDraft,
  row: CatalogueRow,
  contexts: readonly ThemeContextId[],
  text: string,
  supports?: Parameters<typeof validateCssForRow>[2],
): Proposal {
  const checked = validateCssForRow(row, text, supports);
  if (!checked.ok) return { ok: false, message: `${row.path}: ${checked.message}`, path: row.path };
  const edits: DraftEdit[] = contexts.map((context) => ({
    kind: 'set-css-override',
    path: row.path,
    context,
    value: checked.value,
  }));
  return impactOf(draft, row, edits);
}
