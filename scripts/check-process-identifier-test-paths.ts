/**
 * Guard against test files that name a path after the process id.
 *
 * A path built from `process.pid` is unique only among the processes alive at
 * that moment. The operating system reuses process ids, so a later run builds
 * the same path as an earlier one, opens the database the earlier run left
 * behind, and inherits its rows. Its assertions then fail with no fault in the
 * code under test. A run that crashes before its `finally` leaves exactly such
 * a file, and a test that never removes its files leaves one every time
 * (COR-1619). Tests name temporary paths with `createTemporaryPath` or
 * `createTemporaryDirectory` from `@lostgradient/testing/temporary-path`, which
 * make a fresh directory with `mkdtemp`, or with `uniqueFileName` where the
 * file must sit beside the source.
 *
 * Definitions, all syntactic and file-local:
 *
 *   - A process-identifier expression is `process.pid`, `process['pid']` or either with a
 *     `globalThis.` prefix, optionally wrapped in `String(...)`, `Number(...)` or `.toString()`.
 *   - An expression carries the process id when it is a process-identifier
 *     expression, a template literal with a span that carries it, a `+`
 *     expression with an operand that carries it, a conditional with a branch
 *     that carries it, a method called on a value that carries it
 *     (`String(process.pid).padStart(8, '0')`), or a name bound by a `const` in the file to an
 *     expression that carries it. Parentheses, `as`, `satisfies` and `!` are
 *     transparent. The propagation is by name across the whole file with
 *     scoping ignored, like the wall-clock guard.
 *   - A path call is a call of `join` or `resolve` imported from `node:path`
 *     or `path` (or their `/posix` and `/win32` forms), by name or alias, or a
 *     `join`/`resolve` member call on a namespace or default import of them.
 *
 * The guard reports a path call with an argument that carries the process id.
 * A `process.pid` that never reaches a path call is not reported: a lock
 * file's recorded owner, a process-group comparison, a process name and a
 * `process.kill` call are all legitimate. There is no allowlist; a false
 * positive is fixed by renaming or restructuring the code.
 *
 * Blind spots, documented rather than claimed as covered. The guard cannot see:
 *
 *   - a path joined by string concatenation or a template literal outside a
 *     `join` or `resolve` call (`` `${tmpdir()}/x-${process.pid}` ``);
 *   - a process id carried into a path inside a script held in a string or template literal,
 *     except by shape: a literal whose text has a `join(` or `resolve(` call that reads
 *     `process.pid` before the statement ends is reported, with no import to check (a template is
 *     matched whole, with a placeholder for each `${…}`);
 *   - a process id read through a destructured binding (`const { pid } = process`),
 *     a function parameter, an object property or a helper's return value;
 *   - a name bound with `let` or `var`, or one carried across files.
 *
 * It scans `*.test.ts` and `*.test-support.ts` files, and every `.ts` file under
 * a `src/test/` or `src/testing/` directory, where fixtures and child-process
 * scripts for the tests live. A workspace added later is covered without
 * opting in.
 */

import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { scannedSourceDirectories } from './workspace-directories.ts';

const root = join(import.meta.dir, '..');
const SCANNED_DIRECTORIES = scannedSourceDirectories(root);
// Installed dependencies and generated output, mirroring `.gitignore`. Dot
// directories (`.svelte-kit`, `.turbo`, `.playwright`) are skipped wholesale.
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

const PATH_MODULES = new Set([
  'node:path',
  'path',
  'node:path/posix',
  'path/posix',
  'node:path/win32',
  'path/win32',
]);
const PATH_FUNCTIONS = new Set(['join', 'resolve']);
const CONVERSION_FUNCTIONS = new Set(['String', 'Number']);
// A `join(` or `resolve(` call whose arguments, before the statement ends, read `process.pid`.
const SUBSTITUTION = '\u0000';
const EMBEDDED_PATH_CALL = /\b(?:join|resolve)\s*\([^;]*?\bprocess\.pid\b/;

export type ProcessIdentifierPathViolation = { line: number; text: string };

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** The dotted name of an identifier or property chain, without a `globalThis.` prefix. */
function dottedName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (!ts.isPropertyAccessExpression(expression)) return null;
  const receiver = dottedName(expression.expression);
  if (receiver === null) return null;
  const name = `${receiver}.${expression.name.text}`;
  return name.startsWith('globalThis.') ? name.slice('globalThis.'.length) : name;
}

/** `process.pid`, with a `globalThis.` prefix and the conversions that keep it the same number. */
function isProcessIdentifier(expression: ts.Expression): boolean {
  const unwrapped = unwrap(expression);
  if (ts.isPropertyAccessExpression(unwrapped)) return dottedName(unwrapped) === 'process.pid';
  // `process['pid']`
  if (ts.isElementAccessExpression(unwrapped)) {
    return (
      ts.isStringLiteralLike(unwrapped.argumentExpression) &&
      unwrapped.argumentExpression.text === 'pid' &&
      dottedName(unwrapped.expression) === 'process'
    );
  }
  if (!ts.isCallExpression(unwrapped)) return false;
  const [argument] = unwrapped.arguments;
  const callee = unwrapped.expression;
  if (ts.isIdentifier(callee) && CONVERSION_FUNCTIONS.has(callee.text) && argument !== undefined) {
    return isProcessIdentifier(argument);
  }
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'toString' &&
    isProcessIdentifier(callee.expression)
  );
}

type Binding = { name: string; value: ts.Expression };

/** Every `const` declared with a plain identifier name and an initializer. */
function collectConstants(sourceFile: ts.SourceFile): Binding[] {
  const bindings: Binding[] = [];
  walk(sourceFile, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      bindings.push({ name: node.name.text, value: node.initializer });
    }
  });
  return bindings;
}

function carriesProcessIdentifier(
  expression: ts.Expression,
  tainted: ReadonlySet<string>,
): boolean {
  const unwrapped = unwrap(expression);
  if (isProcessIdentifier(unwrapped)) return true;
  if (ts.isIdentifier(unwrapped)) return tainted.has(unwrapped.text);
  if (ts.isTemplateExpression(unwrapped)) {
    return unwrapped.templateSpans.some((span) =>
      carriesProcessIdentifier(span.expression, tainted),
    );
  }
  if (ts.isConditionalExpression(unwrapped)) {
    return (
      carriesProcessIdentifier(unwrapped.whenTrue, tainted) ||
      carriesProcessIdentifier(unwrapped.whenFalse, tainted)
    );
  }
  // A method called on a value that carries the process id: `String(process.pid).padStart(8, '0')`.
  if (ts.isCallExpression(unwrapped) && ts.isPropertyAccessExpression(unwrapped.expression)) {
    return carriesProcessIdentifier(unwrapped.expression.expression, tainted);
  }
  return (
    ts.isBinaryExpression(unwrapped) &&
    unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    (carriesProcessIdentifier(unwrapped.left, tainted) ||
      carriesProcessIdentifier(unwrapped.right, tainted))
  );
}

/** Grow the set of constants that carry the process id until a pass adds none. */
function propagate(bindings: Binding[]): Set<string> {
  const tainted = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const { name, value } of bindings) {
      if (!tainted.has(name) && carriesProcessIdentifier(value, tainted)) {
        tainted.add(name);
        changed = true;
      }
    }
  }
  return tainted;
}

type PathImports = { functions: Set<string>; namespaces: Set<string> };

/** The local names that `join` and `resolve` (and the whole `node:path` module) are bound to. */
function collectPathImports(sourceFile: ts.SourceFile): PathImports {
  const imports: PathImports = { functions: new Set(), namespaces: new Set() };
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !PATH_MODULES.has(statement.moduleSpecifier.text)
    ) {
      continue;
    }
    const clause = statement.importClause;
    if (clause === undefined) continue;
    if (clause.name !== undefined) imports.namespaces.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      imports.namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (PATH_FUNCTIONS.has(imported)) imports.functions.add(element.name.text);
      // `import { posix } from 'node:path'` exposes the same functions as a member.
      if (imported === 'posix' || imported === 'win32') imports.namespaces.add(element.name.text);
    }
  }
  // `const { join } = await import('node:path')` and `const path = require('node:path')`.
  walk(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || node.initializer === undefined) return;
    const initializer = unwrap(node.initializer);
    const call = ts.isAwaitExpression(initializer) ? unwrap(initializer.expression) : initializer;
    if (!ts.isCallExpression(call)) return;
    const [specifier] = call.arguments;
    const loader = call.expression;
    const isLoader =
      loader.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(loader) && loader.text === 'require');
    if (!isLoader || specifier === undefined || !ts.isStringLiteralLike(specifier)) return;
    if (!PATH_MODULES.has(specifier.text)) return;
    if (ts.isIdentifier(node.name)) {
      imports.namespaces.add(node.name.text);
      return;
    }
    if (!ts.isObjectBindingPattern(node.name)) return;
    for (const element of node.name.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      const imported = (element.propertyName ?? element.name).getText(sourceFile);
      if (PATH_FUNCTIONS.has(imported)) imports.functions.add(element.name.text);
      if (imported === 'posix' || imported === 'win32') imports.namespaces.add(element.name.text);
    }
  });
  return imports;
}

function isPathCall(call: ts.CallExpression, imports: PathImports): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return imports.functions.has(callee.text);
  if (!ts.isPropertyAccessExpression(callee) || !PATH_FUNCTIONS.has(callee.name.text)) return false;
  let receiver = callee.expression;
  // `path.posix.join(...)`
  if (ts.isPropertyAccessExpression(receiver)) receiver = receiver.expression;
  return ts.isIdentifier(receiver) && imports.namespaces.has(receiver.text);
}

export function findProcessIdentifierPathViolations(
  sourceFile: ts.SourceFile,
): ProcessIdentifierPathViolation[] {
  const violations: ProcessIdentifierPathViolation[] = [];
  const imports = collectPathImports(sourceFile);
  const tainted = propagate(collectConstants(sourceFile));
  const hasPathImports = imports.functions.size > 0 || imports.namespaces.size > 0;

  walk(sourceFile, (node) => {
    // A child-process script written out in a string or template literal: its text is not parsed,
    // so a `join(...process.pid...)` inside it is found by shape instead.
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      // A template is matched whole, with a placeholder for each `${…}`, so a substitution between
      // `join(` and `process.pid` does not split the match. The placeholder holds no `;`.
      const text = ts.isTemplateExpression(node)
        ? node.head.text +
          node.templateSpans.map((span) => `${SUBSTITUTION}${span.literal.text}`).join('')
        : node.text;
      const embedded = EMBEDDED_PATH_CALL.exec(text);
      if (embedded !== null) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        violations.push({ line: line + 1, text: embedded[0].trim() });
      }
      return;
    }
    if (!hasPathImports || !ts.isCallExpression(node) || !isPathCall(node, imports)) return;
    const carrier = node.arguments.find((argument) => carriesProcessIdentifier(argument, tainted));
    if (carrier === undefined) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(carrier.getStart(sourceFile));
    violations.push({ line: line + 1, text: carrier.getText(sourceFile) });
  });

  return violations;
}

/** Whether `path` (relative to the scan root) is a `.ts` file under `src/test/` or `src/testing/`. */
function isTestDirectoryFile(path: string): boolean {
  if (!path.endsWith('.ts')) return false;
  const segments = path.split(sep);
  return segments.some(
    (segment, index) =>
      segment === 'src' &&
      index < segments.length - 2 &&
      (segments[index + 1] === 'test' || segments[index + 1] === 'testing'),
  );
}

export function collectScannedFiles(directory: string, paths: string[], base = directory): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      collectScannedFiles(path, paths, base);
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.test.ts') ||
        entry.name.endsWith('.test-support.ts') ||
        isTestDirectoryFile(relative(base, path)))
    ) {
      paths.push(path);
    }
  }
}

async function scan(): Promise<string[]> {
  const findings: string[] = [];
  const paths: string[] = [];
  for (const directory of SCANNED_DIRECTORIES)
    collectScannedFiles(join(root, directory), paths, root);

  for (const path of paths.toSorted()) {
    const source = await Bun.file(path).text();
    if (!source.includes('pid')) continue;
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    for (const violation of findProcessIdentifierPathViolations(sourceFile)) {
      findings.push(`${relative(root, path)}:${violation.line} — ${violation.text}`);
    }
  }

  return findings;
}

async function main(): Promise<void> {
  const findings = await scan();
  if (findings.length === 0) {
    process.stdout.write(
      'check-process-identifier-test-paths — OK (no test path is named after a process id).\n',
    );
    return;
  }

  process.stderr.write(
    'check-process-identifier-test-paths — a test path is named after the process id.\n' +
      'The operating system reuses process ids, so a later run builds the same path, opens the\n' +
      'database an earlier run left behind, and inherits its rows. Use `createTemporaryPath` from\n' +
      '`@lostgradient/testing/temporary-path` (a fresh `mkdtemp` directory, removed with\n' +
      '`removeTemporaryPath` in a `finally`), or `uniqueFileName` for a file that must sit beside\n' +
      'the source.\n\n',
  );
  for (const finding of findings) {
    process.stderr.write(`  ${finding}\n`);
  }
  process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('check-process-identifier-test-paths failed:', error);
    process.exitCode = 1;
  });
}
