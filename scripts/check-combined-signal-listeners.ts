/**
 * Ban an `AbortSignal.any` result as the `signal` option of an event listener.
 *
 * Bun collects a signal built with `AbortSignal.any` when only a listener's `signal` option refers
 * to it, and aborting its sources then never removes the listener: an unsubscribed observer kept
 * receiving events on a loaded Linux CI host (COR-2374). A combined signal is safe where code
 * holds it itself (passed to `fetch`, read with `.aborted`, listened to with
 * `signal.addEventListener('abort', ...)`); it is unsafe as the lifetime of another listener.
 *
 * Give the listener a controller of its own and abort that controller from each source instead
 * (`packages/lifecycle/src/event-observable.ts`, `packages/armorer/src/listener-lifetime.ts`).
 *
 * oxlint has no data-flow rule for this, so detection walks the TypeScript AST of each file. A
 * signal is combined when it is an `AbortSignal.any(...)` expression, a variable initialised from
 * one, or a call to a function of the same file whose body contains one. A sink is a call to
 * `addEventListener`, `once`, or `on` with an options argument whose `signal` is combined, written
 * inline or held in a variable. Production sources only: a test may combine freely.
 */

import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { scannedSourceDirectories } from './workspace-directories.ts';

const root = join(import.meta.dir, '..');
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'build',
  'dist',
  'artifacts',
  'coverage',
  'playwright-report',
  'test-results',
  'test-output',
  'test',
  'tests',
]);
const SCANNED_FILE_PATTERN = /(?<!\.d)\.tsx?$/;
const TEST_FILE_PATTERN = /\.(test|spec|bench)\.tsx?$/;
const LISTENER_METHODS = new Set(['addEventListener', 'once', 'on']);

export type CombinedSignalListenerViolation = { line: number; text: string };

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function isAbortSignalAny(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'any' &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'AbortSignal'
  );
}

function contains(node: ts.Node, predicate: (node: ts.Node) => boolean): boolean {
  let found = false;
  walk(node, (child) => {
    if (predicate(child)) found = true;
  });
  return found;
}

/** The identifier names this file binds to a combined signal or to a function that returns one. */
function combinedNames(sourceFile: ts.SourceFile): {
  variables: Set<string>;
  functions: Set<string>;
} {
  const variables = new Set<string>();
  const functions = new Set<string>();
  walk(sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      if (contains(node.body, isAbortSignalAny)) functions.add(node.name.text);
    }
  });
  const isCombined = (expression: ts.Node): boolean =>
    contains(
      expression,
      (child) =>
        isAbortSignalAny(child) ||
        (ts.isIdentifier(child) && variables.has(child.text)) ||
        (ts.isCallExpression(child) &&
          ts.isIdentifier(child.expression) &&
          functions.has(child.expression.text)),
    );
  // A variable can be initialised from one declared earlier, so repeat until nothing is added.
  for (let changed = true; changed;) {
    changed = false;
    walk(sourceFile, (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        !variables.has(node.name.text) &&
        !ts.isObjectLiteralExpression(node.initializer) &&
        isCombined(node.initializer)
      ) {
        variables.add(node.name.text);
        changed = true;
      }
    });
  }
  return { variables, functions };
}

/** Every listener registration whose `signal` option is a combined signal. */
export function findCombinedSignalListeners(
  sourceFile: ts.SourceFile,
): CombinedSignalListenerViolation[] {
  const { variables, functions } = combinedNames(sourceFile);
  const isCombined = (expression: ts.Node): boolean =>
    contains(
      expression,
      (child) =>
        isAbortSignalAny(child) ||
        (ts.isIdentifier(child) && variables.has(child.text)) ||
        (ts.isCallExpression(child) &&
          ts.isIdentifier(child.expression) &&
          functions.has(child.expression.text)),
    );
  const optionsObjects = new Map<string, ts.ObjectLiteralExpression>();
  walk(sourceFile, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      optionsObjects.set(node.name.text, node.initializer);
    }
  });
  const hasCombinedSignal = (options: ts.ObjectLiteralExpression): boolean =>
    options.properties.some((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return property.name.text === 'signal' && variables.has('signal');
      }
      return (
        ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
        property.name.text === 'signal' &&
        isCombined(property.initializer)
      );
    });

  const violations: CombinedSignalListenerViolation[] = [];
  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const called = node.expression;
    if (!ts.isPropertyAccessExpression(called) || !LISTENER_METHODS.has(called.name.text)) return;
    const unsafe = node.arguments.some((argument) => {
      if (ts.isObjectLiteralExpression(argument)) return hasCombinedSignal(argument);
      if (ts.isIdentifier(argument)) {
        const held = optionsObjects.get(argument.text);
        return held !== undefined && hasCombinedSignal(held);
      }
      return false;
    });
    if (!unsafe) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({ line: line + 1, text: node.getText(sourceFile).split('\n')[0] ?? '' });
  });
  return violations;
}

/** Text prefilter before parsing: a file with no `AbortSignal.any` cannot combine a signal. */
export function mayCombineSignals(source: string): boolean {
  return source.includes('AbortSignal.any');
}

export function collectScannedFiles(directory: string, paths: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      collectScannedFiles(path, paths);
    } else if (
      entry.isFile() &&
      SCANNED_FILE_PATTERN.test(entry.name) &&
      !TEST_FILE_PATTERN.test(entry.name)
    ) {
      paths.push(path);
    }
  }
}

async function scan(): Promise<string[]> {
  const findings: string[] = [];
  const paths: string[] = [];
  for (const directory of scannedSourceDirectories(root)) {
    collectScannedFiles(join(root, directory), paths);
  }
  for (const path of paths.toSorted()) {
    const source = await Bun.file(path).text();
    if (!mayCombineSignals(source)) continue;
    const sourceFile = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    for (const violation of findCombinedSignalListeners(sourceFile)) {
      findings.push(`${relative(root, path)}:${violation.line} — ${violation.text}`);
    }
  }
  return findings;
}

async function main(): Promise<void> {
  const findings = await scan();
  if (findings.length === 0) {
    process.stdout.write(
      'check-combined-signal-listeners — OK (no AbortSignal.any result is a listener signal option).\n',
    );
    return;
  }
  process.stderr.write(
    'check-combined-signal-listeners — Bun collects an AbortSignal.any signal that only a listener\n' +
      'refers to, and aborting its sources then never removes the listener (COR-2374). Register the\n' +
      "listener with a controller's signal of its own and abort that controller from each source:\n" +
      '  packages/lifecycle/src/event-observable.ts, packages/armorer/src/listener-lifetime.ts\n\n',
  );
  for (const finding of findings) process.stderr.write(`  ${finding}\n`);
  process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('check-combined-signal-listeners failed:', error);
    process.exitCode = 1;
  });
}
