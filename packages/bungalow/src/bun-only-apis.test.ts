/**
 * Bun-only APIs stay in a few modules, so a later Node or Electron host stays possible: the guard
 * does not make the package run on Node, it stops the Bun-only surface from spreading.
 *
 * - No source module imports `bun:ffi` statically. It is imported only dynamically, when the default
 *   `flock(2)` lock is first acquired, so a host with its own lock, a remote home, or another
 *   runtime can import the package without it.
 * - Outside `ALLOWED`, no source module uses the `Bun` global as a value or imports any `bun:`
 *   module. A type-only use such as the `Bun.S3Client` annotation does not count.
 * - A module in `ALLOWED` must still need to be there, so the list only shrinks.
 * - The package index reaches neither `conformance.ts` nor any `bun:test` import, so importing
 *   `@lostgradient/bungalow` loads no test runner.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, test } from 'bun:test';
import ts from 'typescript';

/** The modules that may use a Bun-only API, and why. */
const ALLOWED = [
  // `Bun.sleepSync` while it polls for a lock holder, and `bun:ffi` imported on first use.
  'lock.ts',
  // `Bun.S3Client`, which remote mode is built on.
  'remote.ts',
  // `bun:test`, for the `describe…` wrappers, behind the `./conformance` subpath.
  'conformance.ts',
] as const;

const SOURCE = dirname(new URL(import.meta.url).pathname);
const transpiler = new Bun.Transpiler({ loader: 'ts' });

type Sources = Readonly<Record<string, string>>;

type ModuleImport = { readonly path: string; readonly dynamic: boolean };

/** Every module specifier `code` imports or re-exports, apart from type-only ones. */
function importsOf(code: string): ModuleImport[] {
  return transpiler
    .scanImports(code)
    .map(({ kind, path }) => ({ path, dynamic: kind === 'dynamic-import' }));
}

/** Whether `node` names a type, where `Bun.S3Client` is not a use of the global. */
function isTypePosition(node: ts.Node): boolean {
  if (ts.isExpressionWithTypeArguments(node)) {
    const heritage = node.parent;
    return (
      ts.isHeritageClause(heritage) &&
      (heritage.token === ts.SyntaxKind.ImplementsKeyword ||
        ts.isInterfaceDeclaration(heritage.parent))
    );
  }
  return ts.isTypeNode(node);
}

/** Whether `identifier`, named `Bun`, reads the global rather than naming something else. */
function readsGlobal(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  if ('name' in parent && parent.name === identifier) {
    // `x.Bun` is a property; `globalThis.Bun` is the global.
    return (
      ts.isPropertyAccessExpression(parent) &&
      ts.isIdentifier(parent.expression) &&
      parent.expression.text === 'globalThis'
    );
  }
  return true;
}

/** Whether `code` uses the `Bun` global as a value, as `Bun.sleepSync(…)` or `new Bun.S3Client(…)`. */
function usesBunGlobal(code: string): boolean {
  const file = ts.createSourceFile('module.ts', code, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): boolean => {
    if (isTypePosition(node)) return false;
    if (ts.isIdentifier(node) && node.text === 'Bun' && readsGlobal(node)) return true;
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'globalThis' &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === 'Bun'
    ) {
      return true;
    }
    return ts.forEachChild(node, visit) === true;
  };
  return visit(file);
}

/** Whether `code` uses a Bun-only API: the `Bun` global as a value, or any `bun:` import. */
function needsBun(code: string): boolean {
  return usesBunGlobal(code) || importsOf(code).some(({ path }) => path.startsWith('bun:'));
}

/** Everything the guard objects to in `sources`, given the modules `allowed` to use Bun. */
function problemsIn(sources: Sources, allowed: readonly string[]): string[] {
  const problems: string[] = [];
  for (const [name, code] of Object.entries(sources).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const imports = importsOf(code);
    if (imports.some(({ path, dynamic }) => path === 'bun:ffi' && !dynamic)) {
      problems.push(`${name} imports bun:ffi statically.`);
    }
    if (allowed.includes(name)) continue;
    for (const { path } of imports) {
      if (path.startsWith('bun:')) problems.push(`${name} imports ${path}.`);
    }
    if (usesBunGlobal(code)) problems.push(`${name} uses the Bun global as a value.`);
  }
  for (const name of allowed) {
    const code = sources[name];
    if (code === undefined) problems.push(`${name} is on the list and does not exist.`);
    else if (!needsBun(code)) problems.push(`${name} is on the list and no longer needs to be.`);
  }
  return problems;
}

/** Every module `entry` reaches through relative imports, static or dynamic, `entry` included. */
function reachableFrom(entry: string, sources: Sources): Set<string> {
  const reached = new Set<string>();
  const pending = [entry];
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (reached.has(name)) continue;
    reached.add(name);
    for (const { path } of importsOf(sources[name] ?? '')) {
      if (path.startsWith('./')) pending.push(path.slice(2));
    }
  }
  return reached;
}

/** The package's own source modules: everything in `src` but tests and their support files. */
function sourceModules(): Record<string, string> {
  return Object.fromEntries(
    readdirSync(SOURCE)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => !name.endsWith('.test.ts') && !name.endsWith('.test-support.ts'))
      .toSorted()
      .map((name) => [name, readFileSync(join(SOURCE, name), 'utf8')]),
  );
}

describe('the scan', () => {
  test('sees a static import and a re-export, and tells a dynamic import apart', () => {
    expect(importsOf("import { dlopen } from 'bun:ffi';")).toEqual([
      { path: 'bun:ffi', dynamic: false },
    ]);
    expect(importsOf("export { dlopen } from 'bun:ffi';")).toEqual([
      { path: 'bun:ffi', dynamic: false },
    ]);
    expect(importsOf("const ffi = await import('bun:ffi');")).toEqual([
      { path: 'bun:ffi', dynamic: true },
    ]);
  });

  test('sees the Bun global as a value and not as a type', () => {
    expect(usesBunGlobal('Bun.sleepSync(10);')).toBe(true);
    expect(usesBunGlobal('const client = new Bun.S3Client({});')).toBe(true);
    expect(usesBunGlobal('const { sleepSync } = Bun;')).toBe(true);
    expect(usesBunGlobal('const bun = typeof Bun;')).toBe(true);
    expect(usesBunGlobal('const bun = globalThis.Bun;')).toBe(true);
    expect(usesBunGlobal("const bun = globalThis['Bun'];")).toBe(true);
    expect(usesBunGlobal('export type Client = { s3(): Bun.S3Client | undefined };')).toBe(false);
    expect(usesBunGlobal('function f(client: Bun.S3Client): void {}')).toBe(false);
    expect(usesBunGlobal('let version: typeof Bun.version;')).toBe(false);
    expect(usesBunGlobal('interface Wrapper extends Bun.Shape {}')).toBe(false);
    expect(usesBunGlobal("// Bun.sleepSync(10)\nconst text = 'Bun.sleepSync';")).toBe(false);
    expect(usesBunGlobal('const named = { Bun: 1 }; named.Bun;')).toBe(false);
  });
});

describe('the guard', () => {
  test('passes on the package source', () => {
    expect(problemsIn(sourceModules(), ALLOWED)).toEqual([]);
  });

  test('keeps the modules it names, so the list only shrinks', () => {
    const modules = sourceModules();
    for (const name of ALLOWED) expect(Object.keys(modules)).toContain(name);
    expect(Object.keys(modules)).toContain('index.ts');
  });

  test('fails an unlisted module that uses the Bun global as a value', () => {
    expect(
      problemsIn({ 'offender.ts': 'export const now = () => Bun.nanoseconds();' }, []),
    ).toEqual(['offender.ts uses the Bun global as a value.']);
  });

  test('fails an unlisted module that imports any bun: module', () => {
    expect(
      problemsIn(
        {
          'offender.ts':
            "import { Database } from 'bun:sqlite';\nexport const open = () => Database;",
        },
        [],
      ),
    ).toEqual(['offender.ts imports bun:sqlite.']);
    expect(
      problemsIn({ 'offender.ts': "export const load = () => import('bun:test');" }, []),
    ).toEqual(['offender.ts imports bun:test.']);
  });

  test('fails a static import of bun:ffi even in a listed module, and allows a dynamic one', () => {
    const statically = "import { dlopen } from 'bun:ffi';\nexport const open = () => dlopen;";
    const dynamically = "export const open = async () => (await import('bun:ffi')).dlopen;";
    expect(problemsIn({ 'lock.ts': statically }, ['lock.ts'])).toEqual([
      'lock.ts imports bun:ffi statically.',
    ]);
    expect(problemsIn({ 'lock.ts': dynamically }, ['lock.ts'])).toEqual([]);
  });

  test('does not count a type-only annotation', () => {
    expect(
      problemsIn(
        { 'typed.ts': 'export type Handle = { client(): Bun.S3Client | undefined };' },
        [],
      ),
    ).toEqual([]);
  });

  test('fails a listed module that no longer needs to be listed, or no longer exists', () => {
    expect(
      problemsIn({ 'clean.ts': 'export type Handle = { client(): Bun.S3Client | undefined };' }, [
        'clean.ts',
        'missing.ts',
      ]),
    ).toEqual([
      'clean.ts is on the list and no longer needs to be.',
      'missing.ts is on the list and does not exist.',
    ]);
  });
});

describe('importing the package', () => {
  test('loads no static bun:ffi: the lock imports it only dynamically', () => {
    const modules = sourceModules();
    const reached = reachableFrom('index.ts', modules);
    expect(reached.has('lock.ts')).toBe(true);
    expect(importsOf(modules['lock.ts'] ?? '').filter(({ path }) => path === 'bun:ffi')).toEqual([
      { path: 'bun:ffi', dynamic: true },
    ]);
  });

  test('loads no test runner: the index reaches neither conformance.ts nor a bun:test import', () => {
    const modules = sourceModules();
    const reached = reachableFrom('index.ts', modules);
    expect(reached.has('conformance.ts')).toBe(false);
    for (const name of reached) {
      expect(
        importsOf(modules[name] ?? '').map(({ path }) => path),
        name,
      ).not.toContain('bun:test');
    }
  });

  test('the reachability walk follows a chain to conformance.ts', () => {
    const sources = {
      'index.ts': "export { run } from './wrapper.ts';",
      'wrapper.ts': "export const run = async () => import('./conformance.ts');",
      'conformance.ts': "import { test } from 'bun:test';\nexport { test };",
    };
    const reached = reachableFrom('index.ts', sources);
    expect(reached.has('conformance.ts')).toBe(true);
  });
});
