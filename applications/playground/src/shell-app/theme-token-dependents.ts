/**
 * The roles that read a token, from the runtime's evaluated provenance (COR-263). Provenance
 * is the expensive part of an evaluation, so it is computed once per envelope object, on
 * demand, and kept for it: every commit makes a new envelope, so a result never outlives the
 * revision it was computed for.
 */

import { evaluateTheme } from '@lostgradient/cinder/tokens/runtime';

import type { ThemeContextId, ThemeEnvelope } from './theme-draft-types.ts';
import { buildThemeSources } from './theme-runtime-evaluator.ts';

type DependentsIndex = Map<string, Map<string, readonly string[]>> | null;

const remembered = new WeakMap<ThemeEnvelope, DependentsIndex>();

function indexFor(envelope: ThemeEnvelope): DependentsIndex {
  if (remembered.has(envelope)) return remembered.get(envelope)!;
  const result = evaluateTheme(buildThemeSources(envelope, 0));
  let index: DependentsIndex = null;
  if (result.ok) {
    index = new Map(
      Object.entries(result.provenance.tokens).map(([context, tokens]) => [
        context,
        new Map(
          tokens.map((token) => [token.path, token.dependents.map((location) => location.path)]),
        ),
      ]),
    );
  }
  remembered.set(envelope, index);
  return index;
}

export type TokenDependents =
  { ok: true; paths: readonly string[] } | { ok: false; message: string };

/** Token paths that read `path` in `context`, directly or through another alias or recipe. */
export function dependentsOf(
  envelope: ThemeEnvelope,
  context: ThemeContextId,
  path: string,
): TokenDependents {
  const index = indexFor(envelope);
  if (index === null) {
    return { ok: false, message: 'The theme is not valid, so dependents cannot be traced.' };
  }
  return { ok: true, paths: index.get(context)?.get(path) ?? [] };
}
