/** Browser and hydration coverage predicates for component tooling. */

import { existsSync, readFileSync } from 'node:fs';

import { parse as parseSvelte } from 'svelte/compiler';
import { Node, Project, type SourceFile } from 'ts-morph';

import { collectActiveTestCalls } from './component-conventions-tests.ts';
import { isObjectRecord } from './validation-utilities.ts';

// Check 3 — hydration/SSR coverage
// ---------------------------------------------------------------------------

/** Read a property as a nested record, or `undefined` if it isn't one. */
function recordProperty(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return isObjectRecord(value) ? value : undefined;
}

/**
 * Returns `true` when the Svelte component at `sveltePath` contains a browser
 * guard: either a `{#if browser}` / `{#if hydrated}` template block, or imports
 * `BROWSER` from `esm-env`.
 *
 * Uses svelte/compiler for structural detection — no substring matching.
 */
export function hasBrowserGuard(sveltePath: string): boolean {
  if (!existsSync(sveltePath)) return false;
  const source = readFileSync(sveltePath, 'utf8');
  return hasBrowserGuardInSource(source);
}

function hasBrowserGuardInSource(source: string): boolean {
  const ast: unknown = parseSvelte(source, { modern: true });
  if (!isObjectRecord(ast)) return false;

  // Check 1: a <script> block imports BROWSER from esm-env (structural — walk
  // the module and instance script ASTs, not a substring/regex on raw source).
  if (
    scriptImportsBrowserFromEsmEnv(ast['module']) ||
    scriptImportsBrowserFromEsmEnv(ast['instance'])
  ) {
    return true;
  }

  // Check 2: template contains {#if browser} or {#if hydrated}
  return templateHasBrowserIfBlock(ast['fragment']);
}

/**
 * Returns `true` when the given Svelte `<script>` node (module or instance)
 * contains an `import { BROWSER } from 'esm-env'` declaration. Walks the ESTree
 * body the Svelte compiler attaches at `script.content.body` — no substring match.
 */
function scriptImportsBrowserFromEsmEnv(scriptNode: unknown): boolean {
  if (!isObjectRecord(scriptNode)) return false;
  const content = recordProperty(scriptNode, 'content');
  if (!content) return false;
  const body = content['body'];
  if (!Array.isArray(body)) return false;

  return body.some(isBrowserImportDeclaration);
}

function isBrowserImportDeclaration(statement: unknown): boolean {
  if (!isObjectRecord(statement) || statement['type'] !== 'ImportDeclaration') return false;
  const sourceNode = recordProperty(statement, 'source');
  if (sourceNode?.['value'] !== 'esm-env') return false;
  const specifiers = statement['specifiers'];
  return Array.isArray(specifiers) && specifiers.some(isBrowserImportSpecifier);
}

function isBrowserImportSpecifier(specifier: unknown): boolean {
  if (!isObjectRecord(specifier)) return false;
  const imported = recordProperty(specifier, 'imported');
  return imported?.['name'] === 'BROWSER';
}

/**
 * Recursively walks the Svelte template AST fragment to find an IfBlock
 * whose test expression is the identifier `browser` or `hydrated`, or a
 * member expression ending in `.hydrated`.
 */
function templateHasBrowserIfBlock(node: unknown): boolean {
  if (!isObjectRecord(node)) return false;
  const record = node;

  if (isGuardIfBlock(record)) return true;

  // Recurse into all array/object children.
  return Object.values(record).some(hasBrowserGuardChild);
}

function isGuardIfBlock(record: Record<string, unknown>): boolean {
  return record['type'] === 'IfBlock' && isBrowserGuardExpression(recordProperty(record, 'test'));
}

function hasBrowserGuardChild(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((child) => templateHasBrowserIfBlock(child));
  return value !== null && typeof value === 'object' && templateHasBrowserIfBlock(value);
}

function isBrowserGuardExpression(test: Record<string, unknown> | undefined): boolean {
  if (!test) return false;
  if (test['type'] === 'Identifier') {
    const name = test['name'];
    return name === 'browser' || name === 'hydrated';
  }
  if (test['type'] === 'MemberExpression') {
    const property = recordProperty(test, 'property');
    return property?.['type'] === 'Identifier' && property['name'] === 'hydrated';
  }
  return false;
}

/**
 * Returns `true` when the test file contains a `render` call from
 * `svelte/server` OR a `renderThenHydrate` call.
 * A test merely named "hydrates" does not satisfy this.
 */
export function hasHydrationTest(testFilePath: string): boolean {
  if (!existsSync(testFilePath)) return false;

  const project = new Project({ skipAddingFilesFromTsConfig: true });
  const sourceFile = project.addSourceFileAtPath(testFilePath);

  const renderIsFromSvelteServer = isImportedFromSvelteServer(sourceFile, 'render');

  // Scope the search to ACTIVE test(...)/it(...) blocks only — a render or
  // renderThenHydrate call inside test.skip / test.todo would never run, so it
  // must not satisfy the hydration gate (mirrors the substantive-test check).
  for (const testCall of collectActiveTestCalls(sourceFile)) {
    let found = false;
    testCall.forEachDescendant((node) => {
      if (found || !Node.isCallExpression(node)) return;
      const expression = node.getExpression();
      if (!Node.isIdentifier(expression)) return;
      const name = expression.getText();
      if (name === 'renderThenHydrate') {
        found = true;
      } else if (name === 'render' && renderIsFromSvelteServer) {
        found = true;
      }
    });
    if (found) return true;
  }
  return false;
}

/** Returns `true` when `name` is imported from `svelte/server` in the given file. */
function isImportedFromSvelteServer(sourceFile: SourceFile, name: string): boolean {
  for (const declaration of sourceFile.getImportDeclarations()) {
    if (declaration.getModuleSpecifierValue() !== 'svelte/server') continue;
    for (const specifier of declaration.getNamedImports()) {
      if (specifier.getName() === name) return true;
    }
    const defaultImport = declaration.getDefaultImport();
    if (defaultImport?.getText() === name) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
