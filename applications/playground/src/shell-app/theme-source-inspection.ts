/**
 * The model behind the Source and dependencies disclosure (COR-488): for one token, from the
 * runtime's evaluated provenance, its authored and resolved values, effective type and where
 * that type is declared, the winning source and the layers it overrides, what it reads
 * directly, what reads it (grouped by concrete context), the CSS properties it feeds, and its
 * source, CSS and portable dispositions. It is computed lazily, when the disclosure opens,
 * from the per-envelope memo, so the edit path never pays for it.
 *
 * Source-only tokens have no CSS property, and the model never invents one. Extension data
 * the runtime does not own is listed as inert, unverified metadata; a recipe that will not run
 * is listed with the reason.
 */

import {
  AUTHORING_CATALOGUE,
  type ContributingLayer,
  type TokenDisposition,
  type TokenLocation,
} from '@lostgradient/cinder/tokens/runtime';

import type { CatalogueRow } from './theme-builder-catalogue.ts';
import {
  THEME_CONTEXT_IDS,
  type JsonObject,
  type JsonValue,
  type ThemeContextId,
  type ThemeEnvelope,
} from './theme-draft-types.ts';
import { expandVariables } from './theme-impact.ts';
import { getNode } from './theme-override-tree.ts';
import type { ThemePreviewContext } from './theme-preview-message.ts';
import { trustedThemeSources, untrustedRecipes, type RecipeSite } from './theme-recipe-trust.ts';
import { applyCssOverrides } from './theme-runtime-evaluator.ts';
import { evaluatedThemeOf, tokenEvaluationOf } from './theme-token-dependents.ts';
import { authoredValueOf, resolvedValueOf, sourcePathOf, valueToText } from './theme-token-edit.ts';

export type ContextInspection = {
  context: ThemeContextId;
  /** The `$value` the winning layer declares, as written. */
  authored: string;
  /** What it resolves to: the CSS value, or the literal for a Source-only token. */
  resolved: string;
  effectiveType: string;
  /** `local` or `inherited`, with the node that declares the type. */
  typeOrigin: string;
  typeDeclaredAt: string;
  winner: TokenLocation;
  /** Layers that also supply the token and lose to the winner, lowest precedence first. */
  overridden: readonly ContributingLayer[];
  /** Tokens read directly through `{alias}`, `$ref`, `$extends`. */
  references: readonly string[];
  /** Public tokens a trusted recipe reads. */
  recipeInputs: readonly string[];
  /** Tokens that read this one, directly or through others. */
  dependents: readonly string[];
};

export type InertMetadata = { namespace: string; value: string };

export type Inspection = {
  path: string;
  sourceOnly: boolean;
  cssProperty: string | null;
  cssUsage: readonly string[];
  /** Primitive, semantic or component role, where Cinder metadata supplies one. */
  role: string | null;
  disposition: TokenDisposition | null;
  contexts: readonly ContextInspection[];
  inert: readonly InertMetadata[];
  untrustedRecipes: readonly RecipeSite[];
};

export type InspectionResult =
  | { ok: true; inspection: Inspection }
  | { ok: false; diagnostics: ReadonlyArray<{ path: string; reason: string }> };

const recordByPath = new Map(AUTHORING_CATALOGUE.records.map((record) => [record.path, record]));

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const contextOf = (id: ThemeContextId): ThemePreviewContext => {
  const [colorMode, motion] = id.split('/') as [ThemePreviewContext['colorMode'], string];
  return { colorMode, motion } as ThemePreviewContext;
};

const describe = (location: TokenLocation | 'unknown'): string =>
  location === 'unknown' ? 'unknown' : `${location.path} in ${location.document}`;

function inertMetadata(
  envelope: ThemeEnvelope,
  winner: TokenLocation | undefined,
  path: string,
): InertMetadata[] {
  if (winner === undefined) return [];
  const document = trustedThemeSources(envelope, 0).documents[winner.document];
  if (!isObject(document as JsonValue)) return [];
  const node = getNode(document as JsonObject, sourcePathOf(envelope, path));
  const extensions = isObject(node) ? node['$extensions'] : undefined;
  if (!isObject(extensions)) return [];
  return Object.entries(extensions)
    .filter(([namespace]) => namespace !== 'com.lostgradient.cinder')
    .map(([namespace, value]) => ({ namespace, value: JSON.stringify(value) }));
}

/** Inspect one token across the six contexts of a draft's current envelope. */
export function inspectToken(
  envelope: ThemeEnvelope,
  row: Pick<CatalogueRow, 'path' | 'cssProperty' | 'component' | 'group'>,
): InspectionResult {
  const evaluated = evaluatedThemeOf(envelope);
  if (!evaluated.ok) {
    return {
      ok: false,
      diagnostics: evaluated.diagnostics.map(({ path, reason }) => ({ path, reason })),
    };
  }
  const sourceOnly = row.cssProperty === '';
  const record = recordByPath.get(row.path);
  const contexts: ContextInspection[] = [];
  let firstWinner: TokenLocation | undefined;
  for (const context of THEME_CONTEXT_IDS) {
    const token = tokenEvaluationOf(evaluated, context, row.path);
    if (token === undefined) continue;
    const { provenance } = token;
    firstWinner ??= provenance.winner;
    const authored = authoredValueOf(envelope, contextOf(context), row.path);
    const map = applyCssOverrides(evaluated.properties[context] ?? {}, envelope, context);
    const literal = resolvedValueOf(envelope, contextOf(context), row.path);
    const css = sourceOnly ? undefined : map[row.cssProperty];
    const type = provenance.effectiveType;
    contexts.push({
      context,
      authored: authored === undefined ? '(recipe or no value)' : valueToText(authored),
      resolved:
        css !== undefined
          ? expandVariables(map, css)
          : literal === undefined
            ? ''
            : valueToText(literal),
      effectiveType: type.type,
      typeOrigin: type.origin,
      typeDeclaredAt: describe(type.declaredAt),
      winner: provenance.winner,
      overridden: provenance.layers.slice(0, -1),
      references: [
        ...provenance.inputs.aliases,
        ...provenance.inputs.refs,
        ...provenance.inputs.extends.map(
          (entry) => `${entry.target} ($extends from ${entry.group})`,
        ),
      ],
      recipeInputs: provenance.inputs.recipes.map((input) => input.path),
      dependents: token.dependents.map((dependent) => dependent.path),
    });
  }
  const untrusted = untrustedRecipes(envelope).filter(
    (site) => site.path === row.path || site.path === sourcePathOf(envelope, row.path),
  );
  return {
    ok: true,
    inspection: {
      path: row.path,
      sourceOnly,
      cssProperty: sourceOnly ? null : row.cssProperty,
      cssUsage: sourceOnly ? [] : (recordProfileUsage(row.path) ?? []),
      role: roleOf(row),
      disposition: record?.disposition ?? null,
      contexts,
      inert: inertMetadata(envelope, firstWinner, row.path),
      untrustedRecipes: untrusted,
    },
  };
}

function recordProfileUsage(path: string): readonly string[] | undefined {
  const record = recordByPath.get(path);
  return record === undefined ? undefined : AUTHORING_CATALOGUE.profiles[record.profile]?.cssUsage;
}

function roleOf(row: Pick<CatalogueRow, 'component' | 'group' | 'path'>): string | null {
  if (row.component !== null) return `Component token (${row.component})`;
  const category = recordByPath.get(row.path)?.category;
  if (category === undefined) return null;
  return row.group === 'semantic'
    ? `Semantic token (${category})`
    : `Foundation token (${category})`;
}
