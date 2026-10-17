/**
 * Materializes DERIVED color tokens into the source documents.
 *
 * A derived token is a color whose `cssRecipe` computes it from another token
 * (`color-mix(in oklch, var(--cinder-border-ink), transparent 80%)`,
 * `oklch(from var(--cinder-accent-solid) calc(l - 0.08) c h)`). DTCG has no
 * operation for that, so every document still has to carry a literal `$value`
 * -- and before this step an author computed those literals by hand and copied
 * them into the base set and each theme document, three places per token plus
 * the recipe itself. They drifted, and a one-number retune meant six edits.
 *
 * Now the recipe on the BASE token is the single authoring site:
 *
 * - The base token's `$value` is the recipe evaluated in the default (light)
 *   context.
 * - Each theme document gets an entry for the token whenever the token
 *   depends, directly or through another derived token, on something that
 *   theme overrides. The entry's `$value` is the recipe evaluated in that
 *   theme, and it carries the recipe so the theme's CSS block re-derives from
 *   whatever the block declares instead of pinning a literal.
 * - A base recipe written as `light-dark(a, b)` contributes `a` to the light
 *   theme and `b` to the dark theme.
 * - A theme entry's `cssRecipe` is always written from the base. A per-theme
 *   difference is expressed as `light-dark()` in the base recipe, never as a
 *   hand-edited copy in a theme document.
 *
 * `tokens:generate` writes the result back; `tokens:check` fails when the
 * committed documents differ from it. Every document remains plain DTCG: the
 * values are literals, and the recipe stays in the vendor extension.
 */

import { converter } from 'culori';

import { documentsForResolutionOrder } from '../../src/tokens/runtime/context-order.ts';
import { cinderExtensions, isPlainObject } from '../../src/tokens/runtime/corpus.ts';
import { resolveDocuments } from '../../src/tokens/runtime/resolve.ts';
import type { ResolverDocument, TokenDocument } from '../../src/tokens/runtime/types.ts';
import {
  evaluateRecipe,
  lightDarkArms,
  recipeInputs,
  toDtcgColor,
  type Oklch,
} from './recipe-evaluator.ts';

export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export type DerivedToken = {
  /** Keys from the document root, including a trailing `$root` where present. */
  keys: string[];
  /** Dotted path as resolution reports it (`$root` segments dropped). */
  path: string;
  documentPath: string;
  cssProperty: string;
  recipe: string;
};

const toOklch = converter('oklch');

function isColorValue(
  value: unknown,
): value is { colorSpace: string; components: number[]; alpha?: number } {
  return isPlainObject(value) && typeof value['colorSpace'] === 'string';
}

/** A DTCG color `$value` as OKLCH, or `undefined` for anything that is not a color object. */
export function dtcgColorToOklch(value: unknown): Oklch | undefined {
  if (!isColorValue(value)) return undefined;
  const alpha = typeof value.alpha === 'number' ? value.alpha : 1;
  const [first = 0, second = 0, third = 0] = value.components;
  if (value.colorSpace === 'oklch') return { l: first, c: second, h: third, alpha };
  if (value.colorSpace === 'srgb') {
    const converted = toOklch({ mode: 'rgb', r: first, g: second, b: third, alpha });
    return {
      l: converted.l,
      c: converted.c,
      h: converted.h,
      alpha: converted.alpha ?? 1,
    };
  }
  return undefined;
}

/** Reads custom properties as resolved in one theme's default-motion context. */
export function themeLookup(
  resolver: ResolverDocument,
  documents: Map<string, TokenDocument>,
  pathByProperty: ReadonlyMap<string, string>,
  theme: Theme,
): (property: string) => Oklch | undefined {
  // `resolveDocuments` resolves aliases in place, so it gets a copy.
  const resolved = resolveDocuments(
    structuredClone(documentsForResolutionOrder(resolver, documents, { theme, motion: 'default' })),
  );
  return (property) => {
    const path = pathByProperty.get(property);
    return path === undefined ? undefined : dtcgColorToOklch(resolved[path]?.$value);
  };
}

function themeDocumentPath(resolver: ResolverDocument, theme: Theme): string {
  const source = resolver.modifiers['theme']?.contexts[theme]?.[0];
  const reference = isPlainObject(source) ? source['$ref'] : undefined;
  if (typeof reference !== 'string') {
    throw new Error(`Resolver theme context "${theme}" has no single $ref document.`);
  }
  return reference;
}

function tokenAt(document: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  let node: unknown = document;
  for (const key of keys) {
    if (!isPlainObject(node)) return undefined;
    node = node[key];
  }
  return isPlainObject(node) && '$value' in node ? node : undefined;
}

/** Walks a document for tokens, yielding each token's key path. */
function* tokens(
  node: Record<string, unknown>,
  keys: string[] = [],
): Generator<{ keys: string[]; token: Record<string, unknown> }> {
  if ('$value' in node) {
    yield { keys, token: node };
    return;
  }
  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith('$') && key !== '$root') continue;
    if (isPlainObject(child)) yield* tokens(child, [...keys, key]);
  }
}

const isBareVariable = (recipe: string): boolean => /^var\(\s*--[\w-]+\s*\)$/.test(recipe.trim());

const dottedPath = (keys: readonly string[]): string =>
  keys.filter((key) => key !== '$root').join('.');

export function collectDerivedTokens(
  resolver: ResolverDocument,
  documentsByPath: Map<string, TokenDocument>,
): { derived: DerivedToken[]; pathByProperty: Map<string, string> } {
  const themePaths = new Set(THEMES.map((theme) => themeDocumentPath(resolver, theme)));
  const derived: DerivedToken[] = [];
  const pathByProperty = new Map<string, string>();
  for (const [documentPath, document] of documentsByPath) {
    if (!documentPath.startsWith('sets/') || themePaths.has(documentPath)) continue;
    for (const { keys, token } of tokens(document)) {
      const extensions = cinderExtensions(token);
      const cssProperty = extensions?.['cssProperty'];
      if (typeof cssProperty !== 'string') continue;
      pathByProperty.set(cssProperty, dottedPath(keys));
      const recipe = extensions?.['cssRecipe'];
      if (typeof recipe !== 'string' || !isColorValue(token['$value'])) continue;
      if (recipeInputs(recipe).length === 0) continue;
      derived.push({ keys, path: dottedPath(keys), documentPath, cssProperty, recipe });
    }
  }
  return { derived, pathByProperty };
}

/** The recipe a theme uses: the matching `light-dark()` arm, or the whole base recipe. */
export function recipeFor(token: DerivedToken, theme: Theme): string {
  return lightDarkArms(token.recipe)?.[theme] ?? token.recipe;
}

/**
 * Which derived tokens a theme must carry: those it already lists, plus those
 * whose inputs (transitively) include a token the theme overrides.
 */
function tokensNeedingThemeEntries(
  derived: readonly DerivedToken[],
  themeDocument: TokenDocument,
  pathByProperty: ReadonlyMap<string, string>,
  theme: Theme,
): Set<string> {
  const overridden = new Set<string>();
  for (const { keys } of tokens(themeDocument)) {
    overridden.add(dottedPath(keys));
  }
  const needed = new Set<string>();
  for (const token of derived) {
    if (tokenAt(themeDocument, token.keys)) needed.add(token.path);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const token of derived) {
      if (needed.has(token.path)) continue;
      const recipe = recipeFor(token, theme);
      const dependsOnTheme =
        recipe !== token.recipe ||
        recipeInputs(recipe).some((property) => {
          const path = pathByProperty.get(property);
          return path !== undefined && (overridden.has(path) || needed.has(path));
        });
      if (dependsOnTheme) {
        needed.add(token.path);
        changed = true;
      }
    }
  }
  return needed;
}

function setThemeEntry(
  themeDocument: Record<string, unknown>,
  keys: readonly string[],
  recipe: string,
  baseValue: unknown,
): Record<string, unknown> {
  let node = themeDocument;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(node[key])) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  const last = keys.at(-1)!;
  const entry: Record<string, unknown> = {
    // Seeded with the base value so the entry is a valid token before the
    // evaluation pass replaces it.
    $value: structuredClone(baseValue),
    $extensions: { 'com.lostgradient.cinder': { cssRecipe: recipe } },
  };
  node[last] = entry;
  return entry;
}

/** Deletes the token at `keys`, and any group that leaves empty. */
function removeEntry(document: Record<string, unknown>, keys: readonly string[]): void {
  const parents: Array<Record<string, unknown>> = [document];
  for (const key of keys.slice(0, -1))
    parents.push(parents.at(-1)![key] as Record<string, unknown>);
  delete parents.at(-1)![keys.at(-1)!];
  for (let depth = keys.length - 1; depth > 0; depth -= 1) {
    const group = parents[depth]!;
    if (Object.keys(group).some((key) => !key.startsWith('$'))) break;
    delete parents[depth - 1]![keys[depth - 1]!];
  }
}

/** The token a bare `var(--x)` arm aliases. */
function aliasTarget(
  token: DerivedToken,
  recipe: string,
  pathByProperty: ReadonlyMap<string, string>,
): string {
  const property = recipeInputs(recipe)[0]!;
  const target = pathByProperty.get(property);
  if (target === undefined) {
    throw new Error(`"${token.path}" aliases ${property}, which no token declares.`);
  }
  return target;
}

/** Writes an alias entry at `keys`, replacing whatever was there. */
function setAliasEntry(document: Record<string, unknown>, keys: readonly string[], alias: string) {
  let node = document;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(node[key])) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[keys.at(-1)!] = { $value: alias };
}

function attachRecipe(entry: Record<string, unknown>, recipe: string): void {
  const extensions = isPlainObject(entry['$extensions']) ? entry['$extensions'] : {};
  const own = isPlainObject(extensions['com.lostgradient.cinder'])
    ? extensions['com.lostgradient.cinder']
    : {};
  entry['$extensions'] = {
    ...extensions,
    'com.lostgradient.cinder': { ...own, cssRecipe: recipe },
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Returns the documents with every derived value recomputed. Documents that
 * did not change are returned as the same object, so callers can tell which
 * files to write.
 */
export function materializeDerivedValues(
  resolver: ResolverDocument,
  documentsByPath: Map<string, TokenDocument>,
): Map<string, TokenDocument> {
  const documents = new Map(
    [...documentsByPath].map(([path, document]) => [path, structuredClone(document)]),
  );
  const changed = new Set<string>();
  const { derived, pathByProperty } = collectDerivedTokens(resolver, documents);

  const themeEntries = new Map<Theme, Set<string>>();
  const derivedPaths = new Set(derived.map((token) => token.path));
  for (const theme of THEMES) {
    const themePath = themeDocumentPath(resolver, theme);
    const themeDocument = documents.get(themePath)!;
    // A theme entry that carries a recipe is one this step wrote (theme recipes are never
    // authored by hand). When its base token stops being derived -- its recipe removed or made
    // constant -- the entry would otherwise linger and silently override the new base value.
    // Collected first: removing entries while the walk is still visiting the document would skip
    // siblings of a removed entry.
    const themeTokens = Array.from(tokens(themeDocument as Record<string, unknown>));
    for (const { keys, token } of themeTokens) {
      if (typeof cinderExtensions(token)?.['cssRecipe'] !== 'string') continue;
      if (derivedPaths.has(dottedPath(keys))) continue;
      removeEntry(themeDocument, keys);
      changed.add(themePath);
    }
    const needed = tokensNeedingThemeEntries(derived, themeDocument, pathByProperty, theme);
    themeEntries.set(theme, needed);
    for (const token of derived) {
      if (!needed.has(token.path)) continue;
      // A bare `var()` arm is an alias: the theme entry is written as that alias, every time, so
      // a change to the base arm reaches the theme document instead of an old alias outliving it.
      const recipe = recipeFor(token, theme);
      if (isBareVariable(recipe)) {
        const alias = `{${aliasTarget(token, recipe, pathByProperty)}}`;
        const existing = tokenAt(themeDocument, token.keys);
        if (existing?.['$value'] === alias && existing['$extensions'] === undefined) continue;
        setAliasEntry(themeDocument, token.keys, alias);
        changed.add(themePath);
        continue;
      }
      if (tokenAt(themeDocument, token.keys)) continue;
      setThemeEntry(
        themeDocument,
        token.keys,
        recipeFor(token, theme),
        tokenAt(documents.get(token.documentPath), token.keys)!['$value'],
      );
      changed.add(themePath);
    }
  }

  // Derived tokens can read other derived tokens, so evaluate to a fixed point.
  // The longest chain in the corpus is two links; the bound only guards a cycle.
  for (let pass = 0; pass < 8; pass += 1) {
    let passChanged = false;
    for (const theme of THEMES) {
      const themePath = themeDocumentPath(resolver, theme);
      const themeDocument = documents.get(themePath)!;
      const lookup = themeLookup(resolver, documents, pathByProperty, theme);
      for (const token of derived) {
        const themeEntry = tokenAt(themeDocument, token.keys);
        const targets: Array<{ entry: Record<string, unknown>; documentPath: string }> = [];
        // A theme entry written as an alias is already a single source.
        if (
          themeEntry &&
          isColorValue(themeEntry['$value']) &&
          themeEntries.get(theme)!.has(token.path)
        ) {
          // The theme entry's recipe is always the base arm. Without one the
          // theme block would pin a literal, and an override of the token's
          // input inside that scope would derive nothing; a hand-kept copy
          // would drift the moment the base recipe changed.
          const recipe = recipeFor(token, theme);
          if (cinderExtensions(themeEntry)?.['cssRecipe'] !== recipe && !isBareVariable(recipe)) {
            attachRecipe(themeEntry, recipe);
            changed.add(themePath);
          }
          targets.push({ entry: themeEntry, documentPath: themePath });
        }
        if (theme === 'light') {
          targets.push({
            entry: tokenAt(documents.get(token.documentPath), token.keys)!,
            documentPath: token.documentPath,
          });
        }
        for (const target of targets) {
          const evaluated = evaluateRecipe(recipeFor(token, theme), lookup);
          // A recipe this step cannot evaluate would leave the last committed literal standing
          // beside a recipe that no longer produces it; every artifact built from `$value` would
          // then be wrong while `tokens:check` stayed green. That is a corpus error, not a skip.
          if (!evaluated) {
            throw new Error(
              `Cannot evaluate the derived recipe of "${token.path}" (${theme}): ` +
                `${recipeFor(token, theme)}. Use the supported grammar in recipe-evaluator.ts ` +
                `or extend it.`,
            );
          }
          const value = toDtcgColor(evaluated);
          if (sameValue(target.entry['$value'], value)) continue;
          target.entry['$value'] = value;
          changed.add(target.documentPath);
          passChanged = true;
        }
      }
    }
    if (!passChanged) {
      return new Map(
        [...documents].map(([path, document]) => [
          path,
          changed.has(path) ? document : documentsByPath.get(path)!,
        ]),
      );
    }
  }
  throw new Error('Derived token values did not converge; a recipe likely reads itself.');
}

/**
 * JSON.parse moves integer-like keys (`chart.series.1`) ahead of every other
 * key, so a parse/stringify round trip reorders the document. Protecting those
 * keys keeps a rewritten source document byte-identical apart from its values.
 */
export function protectIntegerKeys(text: string): string {
  return text.replace(/"(\d+)"(\s*):/g, '"#int#$1"$2:');
}

export function restoreIntegerKeys(text: string): string {
  return text.replace(/"#int#(\d+)"(\s*):/g, '"$1"$2:');
}

/**
 * Applies every token that differs between `original` and `materialized` onto
 * the original source text, preserving its key order, and returns the new
 * unformatted JSON text.
 */
export function rewriteSourceText(
  originalText: string,
  original: TokenDocument,
  materialized: TokenDocument,
): string {
  const target = JSON.parse(protectIntegerKeys(originalText)) as Record<string, unknown>;
  const protect = (keys: readonly string[]) =>
    keys.map((key) => (/^\d+$/.test(key) ? `#int#${key}` : key));
  for (const { keys } of tokens(original)) {
    if (tokenAt(materialized, keys) === undefined) removeEntry(target, protect(keys));
  }
  for (const { keys, token } of tokens(materialized)) {
    if (sameValue(tokenAt(original, keys), token)) continue;
    let node = target;
    const protectedKeys = protect(keys);
    for (const key of protectedKeys.slice(0, -1)) {
      if (!isPlainObject(node[key])) node[key] = {};
      node = node[key] as Record<string, unknown>;
    }
    node[protectedKeys.at(-1)!] = structuredClone(token);
  }
  return restoreIntegerKeys(JSON.stringify(target, null, 2));
}
