/**
 * Portable DTCG documents (COR-486): one per concrete context, built from the exact checked
 * snapshot. A document keeps aliases, `$extends`, descriptions, deprecation and non-Cinder
 * extensions exactly as authored. It is the context's merged source, never a flattened one.
 *
 * Faithfulness is decided per token, never by substitution: a token whose real value has no
 * DTCG form (the CSS-only defaults) is omitted and named, and no placeholder stands in for
 * it. Cinder's own metadata (CSS bindings, trusted recipes, usage categories) is not part of
 * portable DTCG, so it is stripped and counted in the portability report, not silently lost.
 */

import {
  AUTHORING_CATALOGUE,
  buildThemeSources,
  mergedContextDocument,
} from '@lostgradient/cinder/tokens/runtime';

import { THEME_CONTEXT_IDS, type JsonObject, type ThemeContextId } from './theme-draft-types.ts';
import { themeFileSlug } from './theme-envelope.ts';
import type { ExportSnapshot } from './theme-export-snapshot.ts';

const CINDER_EXTENSION = 'com.lostgradient.cinder';
const dispositionByPath = new Map(
  AUTHORING_CATALOGUE.records.map((record) => [record.path, record.disposition] as const),
);

export type OmittedToken = { path: string; reason: string };
export type RecipeNote = { path: string; reason: string };

export type PortableDocument = {
  context: ThemeContextId;
  filename: string;
  document: JsonObject;
  text: string;
};

export type PortablePlan = {
  documents: PortableDocument[];
  /** Tokens left out of every document, with the reason. A complete export has none. */
  omitted: OmittedToken[];
  /** Tokens exported with their DTCG value whose trusted CSS recipe is not part of DTCG. */
  recipesNotExported: RecipeNote[];
  /** Count of Cinder-only metadata blocks removed from exported tokens. */
  metadataStripped: number;
  /** Source tokens (no CSS binding) that are included. */
  sourceTokensIncluded: number;
};

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isTokenNode = (node: JsonObject): boolean => '$value' in node || '$ref' in node;

type Walk = {
  omitted: Map<string, string>;
  recipes: Map<string, string>;
  stripped: Set<string>;
  sourceTokens: Set<string>;
};

/** A token with no faithful DTCG form: a CSS-only default, or Cinder CSS that is not a value. */
function unfaithfulReason(path: string, node: JsonObject): string | null {
  const extensions = node['$extensions'];
  const cinder = isObject(extensions) ? extensions[CINDER_EXTENSION] : undefined;
  if (isObject(cinder) && cinder['nonRepresentableValue'] === true) {
    return 'The real CSS value has no faithful DTCG representation.';
  }
  const disposition = dispositionByPath.get(path);
  if (disposition?.dtcgExport === 'none') return disposition.reason ?? 'No faithful DTCG form.';
  return null;
}

function portableToken(path: string, node: JsonObject, walk: Walk): JsonObject | null {
  const reason = unfaithfulReason(path, node);
  if (reason !== null) {
    walk.omitted.set(path, reason);
    return null;
  }
  const { $extensions, ...rest } = node;
  if (!dispositionByPath.has(path)) walk.sourceTokens.add(path);
  if (!isObject($extensions)) return node;
  const { [CINDER_EXTENSION]: cinder, ...others } = $extensions;
  if (cinder === undefined) return node;
  walk.stripped.add(path);
  if (isObject(cinder) && typeof cinder['cssRecipe'] === 'string' && cinder['cssRecipe'] !== '') {
    walk.recipes.set(
      path,
      'The trusted CSS recipe is not part of DTCG; the DTCG value is exported.',
    );
  }
  return Object.keys(others).length === 0 ? rest : { ...rest, $extensions: others };
}

function portableGroup(group: JsonObject, prefix: string, walk: Walk): JsonObject {
  const out: JsonObject = {};
  for (const [key, child] of Object.entries(group)) {
    if (!isObject(child)) {
      out[key] = child;
      continue;
    }
    if (key === '$root' && prefix !== '') {
      const token = portableToken(prefix, child, walk);
      if (token !== null) out[key] = token;
      continue;
    }
    if (key.startsWith('$')) {
      out[key] = child;
      continue;
    }
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (isTokenNode(child)) {
      const token = portableToken(path, child, walk);
      if (token !== null) out[key] = token;
      continue;
    }
    const inner = portableGroup(child, path, walk);
    const hasContent = Object.keys(inner).some(
      (innerKey) => !innerKey.startsWith('$') || innerKey === '$root',
    );
    if (hasContent) out[key] = inner;
  }
  return out;
}

const pad = (text: string): string => `${text}\n`;

/** The six portable documents for a snapshot, plus what was omitted and what was dropped. */
export function planPortable(snapshot: ExportSnapshot): PortablePlan {
  const sources = buildThemeSources(snapshot.envelope, snapshot.revision);
  const walk: Walk = {
    omitted: new Map(),
    recipes: new Map(),
    stripped: new Set(),
    sourceTokens: new Set(),
  };
  const slug = themeFileSlug(snapshot.envelope.name);
  const documents = THEME_CONTEXT_IDS.map((context): PortableDocument => {
    const [theme, motion] = context.split('/') as [string, string];
    const merged = mergedContextDocument(sources, { theme, motion }) as JsonObject;
    const document: JsonObject = {
      $schema: 'https://www.designtokens.org/schemas/2025.10/format.json',
      ...portableGroup(merged, '', walk),
    };
    return {
      context,
      filename: `${slug}-${theme}-${motion}.tokens.json`,
      document,
      text: pad(JSON.stringify(document, null, 2)),
    };
  });
  const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : 1);
  return {
    documents,
    omitted: [...walk.omitted].map(([path, reason]) => ({ path, reason })).sort(byPath),
    recipesNotExported: [...walk.recipes].map(([path, reason]) => ({ path, reason })).sort(byPath),
    metadataStripped: walk.stripped.size,
    sourceTokensIncluded: walk.sourceTokens.size,
  };
}
