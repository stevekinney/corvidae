/**
 * Guard against starting a child process inside a test body or hook in the default test gate.
 *
 * Bun gives every test, and every `beforeAll`/`beforeEach`/`afterAll`/`afterEach` hook, a
 * five-second clock. A test that spawns a process pays that process's boot and module load on
 * the clock, so on a host running several agents at once it times out, and it passes alone
 * (COR-1392, COR-1396, COR-1459). The fix is never a longer timeout. A test whose child only
 * runs repository logic calls that logic in process; a test whose child *is* the behavior —
 * real `git`, `tsc`, a SIGKILLed crash child, a fresh runtime — runs it at module scope with
 * top-level await, where no per-test timeout applies, and asserts on the recorded result.
 *
 * Definitions, all syntactic:
 *
 *   - A spawn is a call to `Bun.spawn` or `Bun.spawnSync`, a template tagged `Bun.$` or `$`
 *     imported from `bun`, or a call to `spawn`, `spawnSync`, `exec`, `execSync`, `execFile`,
 *     `execFileSync` or `fork` imported from `node:child_process` (named or as a namespace).
 *   - A spawning function is a function declaration, or a `const` bound to a function
 *     expression, declared anywhere in the file, whose body contains a spawn or calls a spawning
 *     function. A spawning class is one with a method or constructor that does; `new` on it, or
 *     a call to any of its static members, counts as a call.
 *   - Spawning functions are found across files: a named, default or namespace import from a
 *     relative path, or from a `@lostgradient/*` workspace package through its `exports` map, is
 *     followed into that module, through `export … from` re-exports, and analyzed the same way.
 *
 * The guard reports a spawn, or a call to a spawning function, lexically inside a function
 * passed to `it`, `test` (with any modifier: `.only`, `.skip`, `.each(…)`, `.skipIf(…)` and
 * the rest) or a hook, under its own name, an alias imported from `bun:test`, or a `bun:test`
 * namespace, and a spawning function passed to one of them by name. A `describe`
 * callback runs at registration, outside any clock, and is not a test body.
 *
 * A spawning function that takes its spawner as a dependency is still reported when a test calls
 * it with a stub, because the guard cannot see which path runs. Such a test carries a
 * `// spawn-free: <reason>` comment directly above its `it(`/`test(` call, naming what stands in
 * for the process; the reason must be at least 20 characters. That is the only exemption, and it
 * covers only those inferred calls: a process API written in the test body is always reported.
 *
 * Moving a process to module scope takes it off the per-test clock, so nothing bounds it there:
 * a child that never exits would hold the whole run. A test file therefore never calls a process
 * API directly, wherever the call runs; it starts every process through `spawnWithHangGuard` or
 * `runWithHangGuard` (`@lostgradient/testing/hang-guard`, or its checked copies at
 * `scripts/hang-guard.ts` and `packages/weft/scripts/lib/hang-guard.ts`). They kill a child after
 * the owner-approved 120-second hang guard of awake time. Bun's own `timeout` option, which this
 * guard used to require, counts time the host spent asleep and killed children on wake
 * (COR-1541); a synchronous spawn blocks the thread, so no awake-time guard can run beside it.
 *
 * Blind spots, documented rather than claimed as covered:
 *
 *   - a spawning function reached through a value rather than a name: a method on an object
 *     literal, a function stored in a variable after declaration, a parameter, or a callback
 *     handed to a helper;
 *   - a module reached through a bare specifier other than a workspace package, or through a
 *     path the resolver below does not try (`tsconfig` path aliases);
 *   - a process started by a dependency, such as Playwright's `chromium.launch()`.
 *
 * `*.bench.ts` files and `.test.ts` files under a package's `scripts/benchmarks/` are outside
 * the default gate and outside the scan, as they are for `check-wall-clock-assertions.ts`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const root = join(import.meta.dir, '..');
const SCANNED_DIRECTORIES = ['applications', 'components', 'packages', 'internal', 'scripts'];
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'build',
  'dist',
  'artifacts',
  'coverage',
  'playwright-report',
  'test-results',
  'test-output',
]);

const CHILD_PROCESS_FUNCTIONS = new Set([
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
]);
const TEST_FUNCTIONS = new Set(['it', 'test']);
const HOOK_FUNCTIONS = new Set(['beforeAll', 'beforeEach', 'afterAll', 'afterEach']);
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.svelte.ts'];

export type TestProcessSpawnViolation = { line: number; text: string };

type ModuleAnalysis = {
  /** Local names (functions and classes) that spawn. */
  spawning: Set<string>;
  /** Exported names, mapped to whether they spawn. */
  exports: Map<string, boolean>;
};

type ImportedNames = {
  /** Local names bound to a spawning import, named or default. */
  spawning: Set<string>;
  /** Namespace bindings of analyzed modules, so `tools.run()` resolves to `run`'s export. */
  moduleNamespaces: Map<string, ModuleAnalysis>;
  /** Local names bound to `node:child_process` functions, and namespace bindings of it. */
  childProcessFunctions: Set<string>;
  childProcessNamespaces: Set<string>;
  /** Local names bound to `$` from `bun`. */
  bunShell: Set<string>;
  /** Local names bound to `spawn` or `spawnSync` imported from `bun`. */
  bunSpawnFunctions: Set<string>;
  /** Local names for `it`, `test` and the hooks, including aliases imported from `bun:test`. */
  registrations: Set<string>;
  /** Namespace bindings of `bun:test`, so `bt.test(…)` registers a test. */
  testNamespaces: Set<string>;
};

function walk(node: ts.Node, visit: (node: ts.Node) => boolean | void): void {
  if (visit(node) === false) return;
  node.forEachChild((child) => walk(child, visit));
}

function moduleSpecifierText(node: ts.ImportDeclaration | ts.ExportDeclaration): string | null {
  const specifier = node.moduleSpecifier;
  return specifier !== undefined && ts.isStringLiteral(specifier) ? specifier.text : null;
}

let workspaceExports: Map<string, { directory: string; exports: unknown }> | undefined;

function workspacePackages(): Map<string, { directory: string; exports: unknown }> {
  if (workspaceExports !== undefined) return workspaceExports;
  workspaceExports = new Map();
  const visit = (directory: string, depth: number): void => {
    const manifestPath = join(directory, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        name?: string;
        exports?: unknown;
      };
      if (manifest.name !== undefined) {
        workspaceExports!.set(manifest.name, { directory, exports: manifest.exports });
      }
    }
    if (depth === 0) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      visit(join(directory, entry.name), depth - 1);
    }
  };
  for (const directory of SCANNED_DIRECTORIES) visit(join(root, directory), 2);
  return workspaceExports;
}

function exportTarget(exports: unknown, subpath: string): string | null {
  if (typeof exports === 'string') return subpath === '.' ? exports : null;
  if (exports === null || typeof exports !== 'object') return null;
  const entry = (exports as Record<string, unknown>)[subpath];
  if (typeof entry === 'string') return entry;
  if (entry !== null && typeof entry === 'object') {
    for (const condition of ['bun', 'import', 'default', 'types']) {
      const value = (entry as Record<string, unknown>)[condition];
      if (typeof value === 'string' && /\.(?:ts|tsx|js|mjs)$/.test(value)) return value;
    }
  }
  return null;
}

function resolveFile(candidate: string): string | null {
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  for (const extension of SOURCE_EXTENSIONS) {
    if (existsSync(candidate + extension)) return candidate + extension;
  }
  const withoutJs = candidate.replace(/\.js$/, '.ts');
  if (withoutJs !== candidate && existsSync(withoutJs)) return withoutJs;
  for (const extension of ['.ts', '.tsx', '.js']) {
    const index = join(candidate, `index${extension}`);
    if (existsSync(index)) return index;
  }
  return null;
}

/** Resolves a relative or `@lostgradient/*` workspace specifier to a source file, if it can. */
export function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (specifier.startsWith('.')) return resolveFile(resolve(dirname(fromFile), specifier));
  const match = /^((?:@[^/]+\/)?[^/]+)(\/.*)?$/.exec(specifier);
  if (match === null) return null;
  const workspace = workspacePackages().get(match[1]!);
  if (workspace === undefined) return null;
  const target = exportTarget(workspace.exports, `.${match[2] ?? ''}`);
  return target === null ? null : resolveFile(join(workspace.directory, target));
}

function importedNames(sourceFile: ts.SourceFile, fileName: string): ImportedNames {
  const names: ImportedNames = {
    spawning: new Set(),
    moduleNamespaces: new Map(),
    registrations: new Set([...TEST_FUNCTIONS, ...HOOK_FUNCTIONS]),
    testNamespaces: new Set(),
    childProcessFunctions: new Set(),
    childProcessNamespaces: new Set(),
    bunShell: new Set(),
    bunSpawnFunctions: new Set(),
  };
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = moduleSpecifierText(statement);
    const clause = statement.importClause;
    if (specifier === null || clause === undefined || clause.isTypeOnly) continue;
    const bindings = clause.namedBindings;
    const named =
      bindings !== undefined && ts.isNamedImports(bindings)
        ? bindings.elements.filter((element) => !element.isTypeOnly)
        : [];
    if (specifier === 'node:child_process' || specifier === 'child_process') {
      for (const element of named) {
        const imported = (element.propertyName ?? element.name).text;
        if (CHILD_PROCESS_FUNCTIONS.has(imported)) {
          names.childProcessFunctions.add(element.name.text);
        }
      }
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        names.childProcessNamespaces.add(bindings.name.text);
      }
      if (clause.name !== undefined) names.childProcessNamespaces.add(clause.name.text);
      continue;
    }
    if (specifier === 'bun:test') {
      for (const element of named) {
        const imported = (element.propertyName ?? element.name).text;
        if (TEST_FUNCTIONS.has(imported) || HOOK_FUNCTIONS.has(imported)) {
          names.registrations.add(element.name.text);
        }
      }
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        names.testNamespaces.add(bindings.name.text);
      }
      continue;
    }
    if (specifier === 'bun') {
      for (const element of named) {
        const imported = (element.propertyName ?? element.name).text;
        if (imported === '$') names.bunShell.add(element.name.text);
        if (imported === 'spawn' || imported === 'spawnSync') {
          names.bunSpawnFunctions.add(element.name.text);
        }
      }
      continue;
    }
    const resolved = resolveSpecifier(fileName, specifier);
    if (resolved === null) continue;
    const analysis = analyzeModule(resolved);
    for (const element of named) {
      const imported = (element.propertyName ?? element.name).text;
      if (analysis.exports.get(imported) === true) names.spawning.add(element.name.text);
    }
    if (clause.name !== undefined && analysis.exports.get('default') === true) {
      names.spawning.add(clause.name.text);
    }
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
      names.moduleNamespaces.set(bindings.name.text, analysis);
    }
  }
  return names;
}

function calleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const object = calleeName(expression.expression);
    return object === null ? null : `${object}.${expression.name.text}`;
  }
  return null;
}

function isBunShell(node: ts.Node, imports: ImportedNames): node is ts.TaggedTemplateExpression {
  if (!ts.isTaggedTemplateExpression(node)) return false;
  const tag = calleeName(node.tag);
  return tag === 'Bun.$' || (tag !== null && imports.bunShell.has(tag));
}

function isChildProcessCall(node: ts.Node, imports: ImportedNames): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const name = calleeName(node.expression);
  if (name === null) return false;
  if (imports.childProcessFunctions.has(name)) return true;
  const [namespace, member] = name.split('.');
  return (
    member !== undefined &&
    imports.childProcessNamespaces.has(namespace!) &&
    CHILD_PROCESS_FUNCTIONS.has(member)
  );
}

function isBunSpawn(node: ts.Node, imports: ImportedNames): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const name = calleeName(node.expression);
  return (
    name === 'Bun.spawn' ||
    name === 'Bun.spawnSync' ||
    (name !== null && imports.bunSpawnFunctions.has(name))
  );
}

/** Whether `node` is itself a process API call, as opposed to a call inferred to reach one. */
function isDirectSpawn(node: ts.Node, imports: ImportedNames): boolean {
  return (
    isBunSpawn(node, imports) || isChildProcessCall(node, imports) || isBunShell(node, imports)
  );
}

/** Whether `name` (an identifier, or `namespace.member`) names a spawning function or class. */
function isSpawningName(name: string, imports: ImportedNames, local: Set<string>): boolean {
  if (local.has(name) || imports.spawning.has(name)) return true;
  const [owner, member] = name.split('.');
  if (member === undefined) return false;
  // A static member of a spawning class, such as `Tools.run()`, counts as the class does.
  if (local.has(owner!) || imports.spawning.has(owner!)) return true;
  return imports.moduleNamespaces.get(owner!)?.exports.get(member) === true;
}

/** Whether `node` calls or constructs something known to start a process. */
function isInferredSpawn(node: ts.Node, imports: ImportedNames, local: Set<string>): boolean {
  if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return false;
  const name = calleeName(node.expression);
  return name !== null && isSpawningName(name, imports, local);
}

/** Whether `node` itself starts a process or calls something known to. */
function isSpawningNode(node: ts.Node, imports: ImportedNames, local: Set<string>): boolean {
  return isDirectSpawn(node, imports) || isInferredSpawn(node, imports, local);
}

function containsSpawn(body: ts.Node, imports: ImportedNames, local: Set<string>): boolean {
  let found = false;
  walk(body, (node) => {
    if (found) return false;
    if (isSpawningNode(node, imports, local)) found = true;
    return !found;
  });
  return found;
}

type NamedBody = { name: string; body: ts.Node; exported: boolean; isDefault: boolean };

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
  );
}

/**
 * Functions and classes declared by name anywhere in the file, not only at module scope, so a
 * helper declared inside a `describe` and passed to a test by name is still analyzed. Only a
 * module-scope declaration can be exported.
 */
function namedBodies(sourceFile: ts.SourceFile): NamedBody[] {
  const bodies: NamedBody[] = [];
  const statements: ts.Statement[] = [];
  walk(sourceFile, (node) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isVariableStatement(node)
    ) {
      statements.push(node);
    }
  });
  for (const statement of statements) {
    const exported =
      statement.parent === sourceFile && hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    const isDefault = exported && hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
    if (ts.isFunctionDeclaration(statement) && statement.body) {
      // An anonymous `export default function` is analyzed under the name `default`.
      const name = statement.name?.text ?? 'default';
      bodies.push({ name, body: statement.body, exported, isDefault });
    } else if (ts.isClassDeclaration(statement) && (statement.name || isDefault)) {
      bodies.push({
        name: statement.name?.text ?? 'default',
        body: statement,
        exported,
        isDefault,
      });
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer;
        if (
          ts.isIdentifier(declaration.name) &&
          initializer !== undefined &&
          (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
        ) {
          bodies.push({
            name: declaration.name.text,
            body: initializer.body,
            exported,
            isDefault: false,
          });
        }
      }
    }
  }
  return bodies;
}

const analyses = new Map<string, ModuleAnalysis>();

function analyzeModule(fileName: string): ModuleAnalysis {
  const cached = analyses.get(fileName);
  if (cached !== undefined) return cached;
  const analysis: ModuleAnalysis = { spawning: new Set(), exports: new Map() };
  // Registered before analysis, so an import cycle sees a partial (empty) result, not a loop.
  analyses.set(fileName, analysis);
  const sourceFile = ts.createSourceFile(
    fileName,
    readFileSync(fileName, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const imports = importedNames(sourceFile, fileName);
  const bodies = namedBodies(sourceFile);
  let changed = true;
  while (changed) {
    changed = false;
    for (const { name, body } of bodies) {
      if (analysis.spawning.has(name)) continue;
      if (containsSpawn(body, imports, analysis.spawning)) {
        analysis.spawning.add(name);
        changed = true;
      }
    }
  }
  for (const { name, exported, isDefault } of bodies) {
    if (exported) analysis.exports.set(isDefault ? 'default' : name, analysis.spawning.has(name));
  }
  for (const statement of sourceFile.statements) {
    // `export default run;` names a local binding; `export = …` is not an ES default.
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const name = calleeName(statement.expression);
      if (name !== null) {
        analysis.exports.set('default', isSpawningName(name, imports, analysis.spawning));
      } else if (
        (ts.isArrowFunction(statement.expression) ||
          ts.isFunctionExpression(statement.expression)) &&
        containsSpawn(statement.expression.body, imports, analysis.spawning)
      ) {
        analysis.exports.set('default', true);
      }
    }
  }
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
    const specifier = moduleSpecifierText(statement);
    const clause = statement.exportClause;
    if (specifier === null) {
      if (clause !== undefined && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          const local = (element.propertyName ?? element.name).text;
          const spawns = isSpawningName(local, imports, analysis.spawning);
          analysis.exports.set(element.name.text, spawns);
        }
      }
      continue;
    }
    const resolved = resolveSpecifier(fileName, specifier);
    if (resolved === null) continue;
    const target = analyzeModule(resolved);
    if (clause === undefined) {
      for (const [name, spawns] of target.exports) analysis.exports.set(name, spawns);
    } else if (ts.isNamedExports(clause)) {
      for (const element of clause.elements) {
        const imported = (element.propertyName ?? element.name).text;
        analysis.exports.set(element.name.text, target.exports.get(imported) === true);
      }
    }
  }
  return analysis;
}

/**
 * Whether `call` registers a test or hook: `it`, `test`, a hook, or an alias of one imported from
 * `bun:test`, with any modifier (`it.only`, `test.each(rows)`), or one reached through a
 * `bun:test` namespace (`bt.test.skip`).
 */
function isTestOrHookRegistration(call: ts.CallExpression, imports: ImportedNames): boolean {
  let current: ts.Expression = call.expression;
  let member: string | null = null;
  while (true) {
    if (ts.isIdentifier(current)) {
      if (imports.registrations.has(current.text)) return true;
      return (
        imports.testNamespaces.has(current.text) &&
        member !== null &&
        (TEST_FUNCTIONS.has(member) || HOOK_FUNCTIONS.has(member))
      );
    }
    if (ts.isPropertyAccessExpression(current)) {
      member = current.name.text;
      current = current.expression;
    } else if (ts.isCallExpression(current)) {
      member = null;
      current = current.expression;
    } else return false;
  }
}

function isTestOrHookCallback(node: ts.Node, imports: ImportedNames): boolean {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
  const call = node.parent;
  return (
    ts.isCallExpression(call) &&
    call.arguments.includes(node) &&
    isTestOrHookRegistration(call, imports)
  );
}

const SPAWN_FREE_MARKER = /\/\/\s*spawn-free:\s*(.*)$/m;
const MINIMUM_SPAWN_FREE_REASON = 20;

/** The `spawn-free:` reason written directly above the statement holding `call`, if any. */
function spawnFreeReason(call: ts.CallExpression, sourceFile: ts.SourceFile): string | null {
  let statement: ts.Node = call;
  while (statement.parent !== undefined && !ts.isExpressionStatement(statement)) {
    statement = statement.parent;
  }
  const comments = ts.getLeadingCommentRanges(sourceFile.text, statement.getFullStart()) ?? [];
  for (const comment of comments) {
    const match = SPAWN_FREE_MARKER.exec(sourceFile.text.slice(comment.pos, comment.end));
    if (match !== null) return match[1]!.trim();
  }
  return null;
}

/** The test or hook registration call whose callback lexically contains `node`, if any. */
function enclosingTestOrHook(node: ts.Node, imports: ImportedNames): ts.CallExpression | null {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (isTestOrHookCallback(current, imports)) return current.parent as ts.CallExpression;
  }
  return null;
}

export function findTestProcessSpawnViolations(
  sourceFile: ts.SourceFile,
): TestProcessSpawnViolation[] {
  const fileName = sourceFile.fileName;
  const imports = importedNames(sourceFile, fileName);
  const local = new Set<string>();
  const bodies = namedBodies(sourceFile);
  let changed = true;
  while (changed) {
    changed = false;
    for (const { name, body } of bodies) {
      if (!local.has(name) && containsSpawn(body, imports, local)) {
        local.add(name);
        changed = true;
      }
    }
  }

  const violations: TestProcessSpawnViolation[] = [];
  const report = (node: ts.Node, text: string): void => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({ line: line + 1, text: text.length > 100 ? `${text.slice(0, 97)}...` : text });
  };
  /** Reports an inferred spawn unless its test carries a `spawn-free` marker with a reason. */
  const reportInferred = (node: ts.Node, registration: ts.CallExpression): void => {
    const reason = spawnFreeReason(registration, sourceFile);
    if (reason !== null && reason.length >= MINIMUM_SPAWN_FREE_REASON) return;
    if (reason !== null) {
      report(
        registration,
        `spawn-free reason shorter than ${MINIMUM_SPAWN_FREE_REASON} characters`,
      );
      return;
    }
    report(node, node.getText(sourceFile).split('\n')[0]!);
  };
  walk(sourceFile, (node) => {
    // A test or hook body passed by name, as in `test('x', body)`, runs on the clock too.
    if (ts.isCallExpression(node) && isTestOrHookRegistration(node, imports)) {
      for (const argument of node.arguments) {
        const name = calleeName(argument);
        if (name !== null && isSpawningName(name, imports, local)) reportInferred(argument, node);
      }
    }
    if (!isSpawningNode(node, imports, local)) return;
    const registration = enclosingTestOrHook(node, imports);
    if (registration === null) return;
    // A `spawn-free` marker vouches for the helper calls the guard can only infer about. A
    // process API written in the test body itself is unambiguous, so no marker exempts it.
    if (isDirectSpawn(node, imports)) report(node, node.getText(sourceFile).split('\n')[0]!);
    else reportInferred(node, registration);
  });
  return violations;
}

/**
 * Process API calls written directly in a test file. Each one must go through the hang-guarded
 * helpers instead, which also lets the test-body analysis above infer them from their module.
 */
export function findDirectSpawns(sourceFile: ts.SourceFile): TestProcessSpawnViolation[] {
  const imports = importedNames(sourceFile, sourceFile.fileName);
  const violations: TestProcessSpawnViolation[] = [];
  walk(sourceFile, (node) => {
    if (!isDirectSpawn(node, imports)) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const name = ts.isTaggedTemplateExpression(node)
      ? 'a Bun shell template'
      : `\`${calleeName((node as ts.CallExpression).expression)}\``;
    violations.push({
      line: line + 1,
      text: `${name} in a test file; use spawnWithHangGuard or runWithHangGuard`,
    });
  });
  return violations;
}

export function collectTestFiles(directory: string, paths: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      if (entry.name === 'benchmarks' && basename(directory) === 'scripts') continue;
      collectTestFiles(path, paths);
    } else if (entry.isFile() && /\.test\.tsx?$/.test(entry.name)) {
      paths.push(path);
    }
  }
}

function scan(): string[] {
  const findings: string[] = [];
  const paths: string[] = [];
  for (const directory of SCANNED_DIRECTORIES) collectTestFiles(join(root, directory), paths);
  for (const path of paths.toSorted()) {
    const sourceFile = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const violation of [
      ...findTestProcessSpawnViolations(sourceFile),
      ...findDirectSpawns(sourceFile),
    ]) {
      findings.push(`${relative(root, path)}:${violation.line} — ${violation.text}`);
    }
  }
  return findings;
}

function main(): void {
  const findings = scan();
  if (findings.length === 0) {
    process.stdout.write(
      'check-test-process-spawns — OK (no test body or hook starts a child process, and no test file calls a process API directly).\n',
    );
    return;
  }
  process.stderr.write(
    'check-test-process-spawns — a test starts a child process on the per-test clock, or a test\n' +
      'file calls a process API directly instead of through the hang-guarded helpers.\n' +
      "A spawn inside a test pays the child's boot on Bun's five-second per-test clock and times\n" +
      'out on a loaded host. Call the logic in process when the child only runs repository code;\n' +
      'when the real process is the behavior, run it at module scope with top-level await and\n' +
      'assert on the recorded result, and start every process in a test file with\n' +
      'spawnWithHangGuard or runWithHangGuard, whose guard counts only awake time.\n' +
      'Never raise the per-test timeout.\n\n',
  );
  for (const finding of findings) process.stderr.write(`  ${finding}\n`);
  process.exitCode = 1;
}

if (import.meta.main) main();
