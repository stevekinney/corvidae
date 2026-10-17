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
 * - A theme entry that carries its OWN `cssRecipe` keeps it; only its
 *   `$value` is recomputed.
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

const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

type DerivedToken = {
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

function collectDerivedTokens(
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

function recipeFor(
  token: DerivedToken,
  theme: Theme,
  themeEntry: Record<string, unknown> | undefined,
): string {
  const own = themeEntry ? cinderExtensions(themeEntry)?.['cssRecipe'] : undefined;
  if (typeof own === 'string') return own;
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
      const recipe = recipeFor(token, theme, undefined);
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
  for (const theme of THEMES) {
    const themePath = themeDocumentPath(resolver, theme);
    const themeDocument = documents.get(themePath)!;
    const needed = tokensNeedingThemeEntries(derived, themeDocument, pathByProperty, theme);
    themeEntries.set(theme, needed);
    for (const token of derived) {
      if (!needed.has(token.path) || tokenAt(themeDocument, token.keys)) continue;
      // A bare `var()` arm is an alias, which the CSS projection already
      // re-resolves per theme; it needs no materialized literal.
      if (isBareVariable(recipeFor(token, theme, undefined))) continue;
      setThemeEntry(
        themeDocument,
        token.keys,
        recipeFor(token, theme, undefined),
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
      // `resolveDocuments` resolves aliases in place, so it gets a copy.
      const resolved = resolveDocuments(
        structuredClone(
          documentsForResolutionOrder(resolver, documents, { theme, motion: 'default' }),
        ),
      );
      const lookup = (property: string): Oklch | undefined => {
        const path = pathByProperty.get(property);
        return path === undefined ? undefined : dtcgColorToOklch(resolved[path]?.$value);
      };
      for (const token of derived) {
        const themeEntry = tokenAt(themeDocument, token.keys);
        const targets: Array<{ entry: Record<string, unknown>; documentPath: string }> = [];
        // A theme entry written as an alias is already a single source.
        if (
          themeEntry &&
          isColorValue(themeEntry['$value']) &&
          themeEntries.get(theme)!.has(token.path)
        ) {
          targets.push({ entry: themeEntry, documentPath: themePath });
        }
        if (theme === 'light') {
          targets.push({
            entry: tokenAt(documents.get(token.documentPath), token.keys)!,
            documentPath: token.documentPath,
          });
        }
        for (const target of targets) {
          const evaluated = evaluateRecipe(recipeFor(token, theme, themeEntry), lookup);
          if (!evaluated) continue;
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
  for (const { keys, token } of tokens(materialized)) {
    if (sameValue(tokenAt(original, keys), token)) continue;
    let node = target;
    const protectedKeys = keys.map((key) => (/^\d+$/.test(key) ? `#int#${key}` : key));
    for (const key of protectedKeys.slice(0, -1)) {
      if (!isPlainObject(node[key])) node[key] = {};
      node = node[key] as Record<string, unknown>;
    }
    node[protectedKeys.at(-1)!] = structuredClone(token);
  }
  return restoreIntegerKeys(JSON.stringify(target, null, 2));
}
