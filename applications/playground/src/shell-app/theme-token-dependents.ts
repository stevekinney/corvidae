/**
 * The roles that read a token, from the runtime's evaluated provenance (COR-263, COR-488).
 * Provenance is the expensive part of an evaluation, so it is computed once per envelope
 * object, on demand, and kept for it: every commit makes a new envelope, so a result never
 * outlives the revision it was computed for. The Source and dependencies disclosure, the
 * alias picker and the dependents list all read this one memo; the edit loop never does.
 */

import {
  evaluateTheme,
  type EvaluatedProvenance,
  type PropertyMap,
  type ThemeDiagnostic,
  type TokenEvaluation,
} from '@lostgradient/cinder/tokens/runtime';
import { trustedThemeSources } from './theme-recipe-trust.ts';

import type { ThemeContextId, ThemeEnvelope } from './theme-draft-types.ts';

export type EvaluatedTheme =
  | {
      ok: true;
      provenance: EvaluatedProvenance;
      properties: Readonly<Record<string, PropertyMap>>;
      /** Per context, the evaluation of each token by path. */
      index: ReadonlyMap<string, ReadonlyMap<string, TokenEvaluation>>;
    }
  | { ok: false; diagnostics: readonly ThemeDiagnostic[] };

const remembered = new WeakMap<ThemeEnvelope, EvaluatedTheme>();

/** The full evaluation, with provenance, of one envelope; computed once per envelope. */
export function evaluatedThemeOf(envelope: ThemeEnvelope): EvaluatedTheme {
  const known = remembered.get(envelope);
  if (known !== undefined) return known;
  const result = evaluateTheme(trustedThemeSources(envelope, 0));
  const evaluated: EvaluatedTheme = result.ok
    ? {
        ok: true,
        provenance: result.provenance,
        properties: result.properties,
        index: new Map(
          Object.entries(result.provenance.tokens).map(([context, tokens]) => [
            context,
            new Map(tokens.map((token) => [token.path, token])),
          ]),
        ),
      }
    : { ok: false, diagnostics: result.diagnostics };
  remembered.set(envelope, evaluated);
  return evaluated;
}

/** One token's evaluation in one concrete context, or `undefined`. */
export function tokenEvaluationOf(
  evaluated: EvaluatedTheme,
  context: ThemeContextId,
  path: string,
): TokenEvaluation | undefined {
  return evaluated.ok ? evaluated.index.get(context)?.get(path) : undefined;
}

export type TokenDependents =
  { ok: true; paths: readonly string[] } | { ok: false; message: string };

/** Token paths that read `path` in `context`, directly or through another alias or recipe. */
export function dependentsOf(
  envelope: ThemeEnvelope,
  context: ThemeContextId,
  path: string,
): TokenDependents {
  const evaluated = evaluatedThemeOf(envelope);
  if (!evaluated.ok) {
    return { ok: false, message: 'The theme is not valid, so dependents cannot be traced.' };
  }
  const token = evaluated.index.get(context)?.get(path);
  return { ok: true, paths: token?.dependents.map((location) => location.path) ?? [] };
}
