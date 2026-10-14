/**
 * Unsafe-input rejection for imports (COR-486). Everything here runs on a parsed value before
 * classification: nothing is evaluated, fetched or read from disk, and no finding depends on
 * what the input claims to be. A finding means the input is refused as a whole.
 */

import { AUTHORING_CATALOGUE } from '@lostgradient/cinder/tokens/runtime';

import type { JsonObject, JsonValue } from './theme-draft-types.ts';
import { THEME_CONTEXT_IDS } from './theme-draft-types.ts';
import type { ImportFinding } from './theme-import-types.ts';
import { themePreviewValueProblem } from './theme-preview-message.ts';

const MAX_SCAN_DEPTH = 64;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CINDER_EXTENSION = 'com.lostgradient.cinder';

const registry = new Map(AUTHORING_CATALOGUE.records.map((record) => [record.path, record]));
export const isRegistryPath = (path: string): boolean => registry.has(path);

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Walk a parsed value without recursion: reject nesting past the scan depth and any
 * prototype-pollution key at any level. JSON.parse makes `__proto__` an own key, so it is
 * visible here and never reaches an object's prototype.
 */
export function scanStructure(value: unknown): ImportFinding[] {
  const findings: ImportFinding[] = [];
  const stack: Array<{ node: unknown; path: string; depth: number }> = [
    { node: value, path: '$', depth: 0 },
  ];
  while (stack.length > 0) {
    const { node, path, depth } = stack.pop()!;
    if (typeof node !== 'object' || node === null) continue;
    if (depth > MAX_SCAN_DEPTH) {
      findings.push({
        code: 'nesting-too-deep',
        path,
        message: `Nesting is deeper than ${MAX_SCAN_DEPTH} levels.`,
      });
      return findings;
    }
    if (Array.isArray(node)) {
      node.forEach((child, index) =>
        stack.push({ node: child, path: `${path}[${index}]`, depth: depth + 1 }),
      );
      continue;
    }
    for (const [key, child] of Object.entries(node)) {
      const here = path === '$' ? key : `${path}.${key}`;
      if (FORBIDDEN_KEYS.has(key)) {
        findings.push({
          code: 'prototype-key',
          path: here,
          message: `The key "${key}" is not accepted anywhere in a theme file.`,
        });
      }
      stack.push({ node: child, path: here, depth: depth + 1 });
    }
  }
  return findings;
}

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) < 32) return true;
  }
  return false;
}

/** A relative, normalized document path, or `null` when the path could leave the bundle. */
export function normalizeDocumentPath(raw: string): string | null {
  if (raw === '' || raw.includes('\\') || hasControlCharacter(raw)) return null;
  if (/%2e|%2f|%5c/i.test(raw)) return null;
  if (raw.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  const segments: string[] = [];
  for (const segment of raw.normalize('NFC').split('/')) {
    if (segment === '..') return null;
    if (segment === '' || segment === '.') continue;
    segments.push(segment);
  }
  return segments.length === 0 ? null : segments.join('/');
}

/** Path traversal and duplicate normalized paths in a bundle's document map. */
export function checkDocumentPaths(paths: readonly string[]): ImportFinding[] {
  const findings: ImportFinding[] = [];
  const seen = new Map<string, string>();
  for (const raw of paths) {
    const normalized = normalizeDocumentPath(raw);
    if (normalized === null) {
      findings.push({
        code: 'path-traversal',
        path: raw,
        message: 'Document paths must be relative paths inside the bundle.',
      });
      continue;
    }
    const key = normalized.toLowerCase();
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      findings.push({
        code: 'duplicate-path',
        path: raw,
        message: `"${raw}" and "${earlier}" are the same document after normalization.`,
      });
    } else {
      seen.set(key, raw);
    }
  }
  return findings;
}

/** Every `$ref` string in a resolver must be internal (`#/...`) or a safe relative path. */
export function checkResolverReferences(resolver: unknown): ImportFinding[] {
  const findings: ImportFinding[] = [];
  const stack: unknown[] = [resolver];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) stack.push(...node);
    else if (isObject(node)) {
      const ref = node['$ref'];
      if (typeof ref === 'string' && !ref.startsWith('#/') && normalizeDocumentPath(ref) === null) {
        findings.push({
          code: 'path-traversal',
          path: ref,
          message: 'The resolver references a document outside the bundle. Nothing is fetched.',
        });
      }
      stack.push(...Object.values(node));
    }
  }
  return findings;
}

const isTokenNode = (node: JsonObject): boolean =>
  Object.hasOwn(node, '$value') || Object.hasOwn(node, '$ref');

/** Every token in a source tree, with its public token path (a group `$root` is the group). */
export function forEachToken(
  tree: JsonObject,
  visit: (path: string, node: JsonObject) => void,
  prefix = '',
): void {
  for (const [key, child] of Object.entries(tree)) {
    if (!isObject(child)) continue;
    if (key === '$root' && prefix !== '') {
      visit(prefix, child);
      continue;
    }
    if (key.startsWith('$')) continue;
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (isTokenNode(child)) visit(path, child);
    else forEachToken(child, visit, path);
  }
}

/**
 * CSS bindings an imported source tree carries. A token may only restate the binding the
 * registry already gives its path; a Source token (a path the registry does not know) may
 * carry none, and a recipe must be a plain value that fetches nothing.
 */
export function checkTreeBindings(tree: JsonObject, label: string): ImportFinding[] {
  const findings: ImportFinding[] = [];
  forEachToken(tree, (path, node) => {
    const extensions = node['$extensions'];
    const cinder = isObject(extensions) ? extensions[CINDER_EXTENSION] : undefined;
    if (!isObject(cinder)) return;
    const known = registry.get(path);
    const where = `${label}:${path}`;
    const property = cinder['cssProperty'];
    if (property !== undefined && (known === undefined || property !== known.cssProperty)) {
      findings.push({
        code: 'foreign-css-binding',
        path: where,
        message: `${path} binds ${JSON.stringify(property)}, which is not a public Cinder property for this token.`,
      });
    }
    if (known === undefined && Object.keys(cinder).some((key) => key !== 'palette')) {
      findings.push({
        code: 'foreign-css-binding',
        path: where,
        message: `${path} is not a public Cinder token, so it cannot carry Cinder CSS metadata.`,
      });
    }
    const recipe = cinder['cssRecipe'];
    if (recipe !== undefined) {
      const problem = themePreviewValueProblem(recipe);
      if (problem !== null) {
        findings.push({
          code: 'resource-bearing-css',
          path: where,
          message: `The CSS recipe for ${path} is refused: ${problem}.`,
        });
      }
    }
  });
  return findings;
}

/** CSS-only edits must name a public token and a concrete context, with a plain value. */
export function checkCssOverrideEntries(cssOverrides: Record<string, JsonValue>): ImportFinding[] {
  const findings: ImportFinding[] = [];
  for (const [path, byContext] of Object.entries(cssOverrides)) {
    if (!registry.has(path)) {
      findings.push({
        code: 'foreign-css-binding',
        path: `cssOverrides.${path}`,
        message: `${path} is not a public Cinder token, so it has no CSS binding to override.`,
      });
      continue;
    }
    if (!isObject(byContext)) continue;
    for (const [context, value] of Object.entries(byContext)) {
      const where = `cssOverrides.${path}.${context}`;
      if (!(THEME_CONTEXT_IDS as readonly string[]).includes(context)) {
        findings.push({
          code: 'unknown-context',
          path: where,
          message: `${context} is not a Cinder context.`,
        });
        continue;
      }
      const problem = themePreviewValueProblem(value);
      if (problem !== null) {
        findings.push({
          code: 'resource-bearing-css',
          path: where,
          message: `The CSS value is refused: ${problem}.`,
        });
      }
    }
  }
  return findings;
}

/** An imported value whose explicit `$type` contradicts the type the public token has. */
export function checkPublicTargetTypes(tree: JsonObject, label: string): ImportFinding[] {
  const findings: ImportFinding[] = [];
  forEachToken(tree, (path, node) => {
    const record = registry.get(path);
    if (record === undefined) return;
    const where = `${label}:${path}`;
    if (record.disposition.edit === 'css-only') {
      findings.push({
        code: 'css-only-target',
        path: where,
        message: `${path} has no DTCG value. Its CSS value is edited in the builder, not imported as DTCG.`,
      });
      return;
    }
    const declared = node['$type'];
    const effective = record.variants[0]?.provenance.effectiveType.type;
    if (typeof declared === 'string' && typeof effective === 'string' && declared !== effective) {
      findings.push({
        code: 'public-type-change',
        path: where,
        message: `${path} is a ${effective} token; the file declares ${declared}.`,
      });
    }
  });
  return findings;
}
