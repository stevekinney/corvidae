/**
 * Which CSS recipes may run (COR-488). The token runtime emits any `cssRecipe` it finds in a
 * source document verbatim, so a theme that arrived from outside could carry one that writes
 * arbitrary CSS into the preview. A recipe is trusted only when the embedded base's source
 * digest is the one this build of Cinder ships AND the recipe text is one the shipped corpus
 * declares for that same token. An imported flag, a claimed digest on its own, or a recipe
 * on a token the shipped corpus gives no such recipe cannot earn trust.
 *
 * An untrusted recipe is not deleted from the draft. The envelope keeps it, and the sources
 * handed to the runtime omit it, so it is inert: the token falls back to its typed `$value`,
 * and the disclosure lists the recipe as unverified metadata. Unchanged documents keep their
 * object identity, which the runtime's validation memo depends on.
 */

import { CINDER_BASE } from '@lostgradient/cinder/tokens/runtime';

import type { JsonObject, JsonValue, ThemeBase, ThemeEnvelope } from './theme-draft-types.ts';

const NAMESPACE = 'com.lostgradient.cinder';

export type RecipeSite = { document: string; path: string; recipe: string };

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const recipeOf = (node: JsonObject): string | undefined => {
  const extensions = node['$extensions'];
  const cinder = isObject(extensions) ? extensions[NAMESPACE] : undefined;
  const recipe = isObject(cinder) ? cinder['cssRecipe'] : undefined;
  return typeof recipe === 'string' ? recipe : undefined;
};

/** Walk a document, calling `visit` for every token node with its dotted path. */
function walkTokens(
  node: JsonObject,
  path: string[],
  visit: (path: string, token: JsonObject) => void,
): void {
  if ('$value' in node || '$ref' in node) visit(path.join('.'), node);
  for (const [key, child] of Object.entries(node)) {
    if (!isObject(child)) continue;
    if (key === '$root') walkTokens(child, path, visit);
    else if (!key.startsWith('$')) walkTokens(child, [...path, key], visit);
  }
}

let shipped: Map<string, Set<string>> | undefined;

/** Every recipe the shipped corpus declares, by token path. */
function shippedRecipes(): Map<string, Set<string>> {
  if (shipped !== undefined) return shipped;
  const index = new Map<string, Set<string>>();
  for (const document of Object.values(CINDER_BASE.documents)) {
    walkTokens(document as JsonObject, [], (path, token) => {
      const recipe = recipeOf(token);
      if (recipe === undefined) return;
      const known = index.get(path) ?? new Set<string>();
      known.add(recipe);
      index.set(path, known);
    });
  }
  shipped = index;
  return index;
}

/** True when the base is the shipped one and the shipped corpus declares this recipe here. */
export function isTrustedRecipe(base: ThemeBase, path: string, recipe: string): boolean {
  return (
    base.sourceDigest === CINDER_BASE.sourceDigest &&
    shippedRecipes().get(path)?.has(recipe) === true
  );
}

type Cleaned = { document: JsonObject; untrusted: RecipeSite[] };

function strip(token: JsonObject): JsonObject {
  const extensions = token['$extensions'] as JsonObject;
  const { cssRecipe: _removed, ...cinder } = extensions[NAMESPACE] as JsonObject;
  return { ...token, $extensions: { ...extensions, [NAMESPACE]: cinder } };
}

function clean(
  node: JsonObject,
  path: string[],
  name: string,
  base: ThemeBase,
  untrusted: RecipeSite[],
): JsonObject {
  let next = node;
  if ('$value' in node || '$ref' in node) {
    const recipe = recipeOf(node);
    if (recipe !== undefined && !isTrustedRecipe(base, path.join('.'), recipe)) {
      untrusted.push({ document: name, path: path.join('.'), recipe });
      next = strip(node);
    }
  }
  for (const [key, child] of Object.entries(node)) {
    if (!isObject(child) || (key.startsWith('$') && key !== '$root')) continue;
    const childPath = key === '$root' ? path : [...path, key];
    const cleaned = clean(child, childPath, name, base, untrusted);
    if (cleaned !== child) next = { ...(next === node ? { ...node } : next), [key]: cleaned };
  }
  return next;
}

const cache = new WeakMap<JsonObject, Map<string, Cleaned>>();

/** One document with untrusted recipes removed; the same object back when none were. */
export function cleanedDocument(name: string, document: JsonObject, base: ThemeBase): Cleaned {
  if (document === (CINDER_BASE.documents as Record<string, JsonObject>)[name]) {
    return { document, untrusted: [] };
  }
  const trusted = base.sourceDigest === CINDER_BASE.sourceDigest ? 'shipped' : 'foreign';
  const remembered = cache.get(document)?.get(trusted);
  if (remembered !== undefined) return remembered;
  const untrusted: RecipeSite[] = [];
  const cleaned: Cleaned = { document: clean(document, [], name, base, untrusted), untrusted };
  const byTrust = cache.get(document) ?? new Map<string, Cleaned>();
  byTrust.set(trusted, cleaned);
  cache.set(document, byTrust);
  return cleaned;
}

/** The documents a runtime evaluation may see: every untrusted recipe left out. */
export function trustedDocuments(
  documents: Record<string, JsonValue>,
  base: ThemeBase,
): Record<string, JsonValue> {
  let changed = false;
  const out: Record<string, JsonValue> = {};
  for (const [name, document] of Object.entries(documents)) {
    if (!isObject(document)) {
      out[name] = document;
      continue;
    }
    const cleaned = cleanedDocument(name, document, base);
    if (cleaned.document !== document) changed = true;
    out[name] = cleaned.document;
  }
  return changed ? out : documents;
}

const report = new WeakMap<ThemeEnvelope, RecipeSite[]>();

/** Every recipe in the envelope's documents that will not run, base documents and overrides. */
export function untrustedRecipes(envelope: ThemeEnvelope): readonly RecipeSite[] {
  const remembered = report.get(envelope);
  if (remembered !== undefined) return remembered;
  const documents: Record<string, JsonValue> = {
    ...envelope.base.documents,
    ...Object.fromEntries(
      Object.entries(envelope.overrides).map(([scope, tree]) => [`overrides/${scope}`, tree]),
    ),
  };
  const found = Object.entries(documents).flatMap(([name, document]) =>
    isObject(document) ? cleanedDocument(name, document, envelope.base).untrusted : [],
  );
  report.set(envelope, found);
  return found;
}
