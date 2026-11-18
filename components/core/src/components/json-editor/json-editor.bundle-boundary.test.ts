import { dirname, extname, resolve as resolvePath } from 'node:path';

import { describe, expect, test } from 'bun:test';
import { parse } from 'svelte/compiler';
import ts from 'typescript';

const EDITOR_DEPENDENCY_PATTERN = /(?:^|\/)(?:@codemirror|@lezer|codemirror|monaco-editor)(?:\/|$)/;

/** A module specifier and whether it is a static import edge or a dynamic `import()`. */
type ModuleEdge = { specifier: string; dynamic: boolean };

function collectEstreeEdges(node: unknown, edges: ModuleEdge[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectEstreeEdges(child, edges);
    return;
  }
  if (node === null || typeof node !== 'object') return;

  const record = node as Record<string, unknown>;
  const type = record['type'];
  const isTypeOnly = record['importKind'] === 'type' || record['exportKind'] === 'type';
  if (
    type === 'ImportDeclaration' ||
    type === 'ExportNamedDeclaration' ||
    type === 'ExportAllDeclaration' ||
    type === 'ImportExpression'
  ) {
    const source = record['source'];
    if (source !== null && typeof source === 'object' && !isTypeOnly) {
      const value = (source as Record<string, unknown>)['value'];
      if (typeof value === 'string') {
        edges.push({ specifier: value, dynamic: type === 'ImportExpression' });
      }
    }
  }

  for (const child of Object.values(record)) collectEstreeEdges(child, edges);
}

function typescriptEdges(filePath: string, source: string): ModuleEdge[] {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const edges: ModuleEdge[] = [];

  function visit(node: ts.Node): void {
    // A type-only import or export is erased at compile time, so it is not a runtime edge.
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !node.importClause?.isTypeOnly
    ) {
      edges.push({ specifier: node.moduleSpecifier.text, dynamic: false });
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !node.isTypeOnly
    ) {
      edges.push({ specifier: node.moduleSpecifier.text, dynamic: false });
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument !== undefined && ts.isStringLiteral(argument)) {
        edges.push({ specifier: argument.text, dynamic: true });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return edges;
}

function moduleEdges(filePath: string, source: string): ModuleEdge[] {
  if (filePath.endsWith('.svelte')) {
    const ast = parse(source, { filename: filePath, modern: true });
    const edges: ModuleEdge[] = [];
    for (const program of [ast.instance?.content, ast.module?.content]) {
      collectEstreeEdges(program, edges);
    }
    return edges;
  }
  if (filePath.endsWith('.css')) {
    return [...source.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/g)].map((match) => ({
      specifier: match[1] as string,
      dynamic: false,
    }));
  }
  return typescriptEdges(filePath, source);
}

async function resolveLocalSpecifier(fromFile: string, specifier: string): Promise<string> {
  const base = resolvePath(dirname(fromFile), specifier);
  const candidates = extname(base)
    ? [base]
    : [base, `${base}.ts`, `${base}.svelte`, `${base}.css`, resolvePath(base, 'index.ts')];
  for (const candidate of candidates) {
    if (await Bun.file(candidate).exists()) return candidate;
  }
  throw new Error(`Could not resolve '${specifier}' from ${fromFile}`);
}

/**
 * Walk the files an entry reaches through static edges only. A dynamic `import()` starts a separate
 * chunk, so it is recorded in `dynamicEdges` and not followed.
 */
async function staticImportClosure(entryPath: string): Promise<{
  files: string[];
  editorEdges: string[];
  dynamicEdges: string[];
}> {
  const pending = [entryPath];
  const files = new Set<string>();
  const editorEdges: string[] = [];
  const dynamicEdges: string[] = [];

  while (pending.length > 0) {
    const filePath = pending.pop();
    if (filePath === undefined || files.has(filePath)) continue;
    files.add(filePath);

    const source = await Bun.file(filePath).text();
    for (const { specifier, dynamic } of moduleEdges(filePath, source)) {
      if (dynamic) {
        dynamicEdges.push(`${filePath}: ${specifier}`);
        continue;
      }
      if (EDITOR_DEPENDENCY_PATTERN.test(specifier)) {
        editorEdges.push(`${filePath}: ${specifier}`);
      }
      if (specifier.startsWith('.')) {
        pending.push(await resolveLocalSpecifier(filePath, specifier));
      }
    }
  }

  return { files: [...files], editorEdges, dynamicEdges };
}

describe('JsonEditor — bundle boundary', () => {
  const entryPath = resolvePath(import.meta.dir, 'index.ts');
  const componentPath = resolvePath(import.meta.dir, 'json-editor.svelte');
  const runtimePath = resolvePath(import.meta.dir, 'json-editor-enhancement.ts');

  test('the public entry reaches no code-editor module through a static import', async () => {
    const closure = await staticImportClosure(entryPath);

    expect(closure.files).toContain(entryPath);
    expect(closure.files).toContain(componentPath);
    expect(closure.files).not.toContain(runtimePath);
    expect(closure.editorEdges).toEqual([]);
  });

  test('the editor runtime is reached only through a dynamic import when a JsonEditor mounts', async () => {
    const closure = await staticImportClosure(entryPath);
    const source = await Bun.file(componentPath).text();

    expect(closure.dynamicEdges).toEqual([`${componentPath}: ./json-editor-enhancement.ts`]);
    // The import sits inside an effect, which runs on mount and never during server rendering.
    expect(source).toMatch(
      /\$effect\(\(\) => \{[\s\S]*?import\(\s*['"]\.\/json-editor-enhancement\.ts['"]\s*\)/,
    );
  });

  test('the editor runtime is the chunk that holds the code-editor dependencies', async () => {
    const closure = await staticImportClosure(runtimePath);
    const packages = new Set(
      closure.editorEdges.map((edge) => edge.split(': ')[1]?.split('/').slice(0, 2).join('/')),
    );

    expect(packages).toContain('@codemirror/view');
    expect(packages).toContain('@codemirror/state');
    expect(packages).toContain('@codemirror/lang-json');
    // The chunk is plain TypeScript: it must not pull the component, or the entry, back into it.
    expect(closure.files).not.toContain(componentPath);
    expect(closure.files).not.toContain(entryPath);
  });

  test('the guard fails a static import of the editor runtime', async () => {
    const edges = moduleEdges(
      componentPath,
      '<script lang="ts">import { createJsonEditor } from "./json-editor-enhancement.ts";</script>',
    );
    expect(edges).toEqual([{ specifier: './json-editor-enhancement.ts', dynamic: false }]);
    expect(
      moduleEdges(
        componentPath,
        '<script lang="ts">import type { A } from "@codemirror/view";</script>',
      ),
    ).toEqual([]);
    expect(
      moduleEdges(componentPath, '<script lang="ts">void import("@codemirror/view");</script>'),
    ).toEqual([{ specifier: '@codemirror/view', dynamic: true }]);
  });

  test('keeps a native textarea as the form control and fallback', async () => {
    expect(await Bun.file(componentPath).text()).toContain('<textarea');
  });
});
