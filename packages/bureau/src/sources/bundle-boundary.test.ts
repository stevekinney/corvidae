/**
 * COR-1702, COR-1762 — the subpath-only definition sources (the Node directory sources and the Bun
 * S3 object sources) stay out of Bureau's main entry. The import closure of `src/index.ts`,
 * followed through every relative import, export, and dynamic import (types included), holds the
 * contract types and `SourceConflictError`, and none of the directory or object constructors or
 * the file-system and object-store code behind them. Modeled on Cinder's
 * `json-editor.bundle-boundary.test.ts`.
 */
import { dirname, extname, resolve as resolvePath } from 'node:path';

import { describe, expect, test } from 'bun:test';
import ts from 'typescript';

const SOURCES_DIRECTORY = import.meta.dir;
const ENTRY = resolvePath(SOURCES_DIRECTORY, '..', 'index.ts');

function specifiersOf(filePath: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument !== undefined && ts.isStringLiteral(argument)) specifiers.push(argument.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return specifiers;
}

/** The TypeScript file a relative specifier names, or `undefined` for a JSON or asset import. */
async function resolveLocal(fromFile: string, specifier: string): Promise<string | undefined> {
  const base = resolvePath(dirname(fromFile), specifier);
  if (extname(base) !== '' && extname(base) !== '.ts') return undefined;
  const candidates = extname(base) ? [base] : [`${base}.ts`, resolvePath(base, 'index.ts')];
  for (const candidate of candidates) {
    if (await Bun.file(candidate).exists()) return candidate;
  }
  throw new Error(`Could not resolve '${specifier}' from ${fromFile}`);
}

async function importClosure(entry: string): Promise<Set<string>> {
  const pending = [entry];
  const files = new Set<string>();
  while (pending.length > 0) {
    const filePath = pending.pop();
    if (filePath === undefined || files.has(filePath)) continue;
    files.add(filePath);
    for (const specifier of specifiersOf(filePath, await Bun.file(filePath).text())) {
      if (!specifier.startsWith('.')) continue;
      const resolved = await resolveLocal(filePath, specifier);
      if (resolved !== undefined) pending.push(resolved);
    }
  }
  return files;
}

const BROWSER_EXCLUDED_SOURCES = [
  'watched-directory.ts',
  'agent-file-operations.ts',
  'atomic-file-writer.ts',
  'directory-source.ts',
  'agent-file-directory.ts',
  'workflow-file-directory.ts',
  'safe-identifier.ts',
  'object-operations.ts',
  'polled-objects.ts',
  'object-source.ts',
  'agent-object-source.ts',
  'workflow-object-source.ts',
  'index.ts',
] as const;

describe('Bureau main entry — sources bundle boundary', () => {
  test('reaches the contract types and SourceConflictError, and no directory or object source', async () => {
    const closure = await importClosure(ENTRY);
    expect(closure).toContain(ENTRY);
    expect(closure).toContain(resolvePath(SOURCES_DIRECTORY, 'definition-source.ts'));
    for (const name of BROWSER_EXCLUDED_SOURCES) {
      expect(closure.has(resolvePath(SOURCES_DIRECTORY, name)), name).toBe(false);
    }
  });

  test('the sources subpath reaches the directory and object constructors', async () => {
    const closure = await importClosure(resolvePath(SOURCES_DIRECTORY, 'index.ts'));
    for (const name of BROWSER_EXCLUDED_SOURCES) {
      expect(closure.has(resolvePath(SOURCES_DIRECTORY, name)), name).toBe(true);
    }
  });
});
