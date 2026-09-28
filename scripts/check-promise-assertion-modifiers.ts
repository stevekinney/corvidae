/**
 * Ban Bun's `.resolves` and `.rejects` expect modifiers.
 *
 * In Bun these modifiers do not return a promise. `expect(promise).resolves.toBe(x)`
 * returns `undefined` after blocking synchronously: the matcher spins a nested
 * event loop until the promise settles (`scripts/bun-matchers.test.ts` pins that
 * contract). The assertion is live, but the nested loop is a hazard. With no
 * timer pending, a promise settled by a real Worker's message never settles
 * inside it, because the host's `message` listener does not run there, and the
 * test hangs until its timeout (COR-1330). To a reader who knows Jest, the
 * missing `await` also looks like a bug when it is not one.
 *
 * Assert on the awaited value instead:
 *
 *   expect(await promise).toBe(x);
 *   expect(await rejectionOf(promise)).toBeInstanceOf(SomeError);
 *   expect(await throwingRejectionOf(promise)).toThrow('message');
 *
 * `rejectionOf` and `throwingRejectionOf` live in `promise-outcome`. The mirror
 * ships packages to separate public targets, so the module is copied into each
 * package that cannot depend on `@lostgradient/testing`; `PROMISE_OUTCOME_COPIES`
 * lists every copy, and this check fails when one drifts from the canonical file.
 *
 * oxlint cannot express the ban: its `jest/valid-expect` and
 * `jest/no-restricted-matchers` recognize `expect` only as a global or an
 * `@jest/globals` import, not a `bun:test` one, and `typescript/no-floating-promises`
 * cannot see a call that returns `void`. Detection walks the TypeScript AST, so
 * chains split across lines are covered. The scan covers every TypeScript file
 * in every workspace directory and root `scripts/`, and runs from the root
 * `lint:root` script.
 */

import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const root = join(import.meta.dir, '..');
const SCANNED_DIRECTORIES = ['applications', 'components', 'packages', 'internal', 'scripts'];
// Installed dependencies and generated output, mirroring `.gitignore`. Dot
// directories (`.svelte-kit`, `.turbo`, `.hutch`) are skipped wholesale.
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
// Every TypeScript source, not only `*.test.ts`: shared harnesses such as
// `packages/memory/test/contract-harness.ts` assert too. Production code has no
// `expect(...)` call for the AST check to match.
const SCANNED_FILE_PATTERN = /(?<!\.d)\.tsx?$/;

/**
 * Files allowed to use the modifiers. `bun-matchers.test.ts` characterizes the
 * synchronous contract this check exists because of; if a Bun upgrade changes
 * that contract, that test fails and this ban needs revisiting.
 */
export const EXEMPT_FILES = new Set(['scripts/bun-matchers.test.ts']);

export const CANONICAL_PROMISE_OUTCOME = 'packages/testing/src/helpers/promise-outcome.ts';

/** Byte-identical copies of the canonical module, one per package that cannot import it. */
export const PROMISE_OUTCOME_COPIES = [
  'packages/armorer/src/testing/promise-outcome.test-support.ts',
  'packages/bureau/src/testing/promise-outcome.test-support.ts',
  'packages/conversationalist/src/testing/promise-outcome.test-support.ts',
  'packages/lifecycle/src/testing/promise-outcome.test-support.ts',
  'packages/memory/src/testing/promise-outcome.test-support.ts',
  'packages/operative/src/testing/promise-outcome.test-support.ts',
  'packages/skills/src/testing/promise-outcome.test-support.ts',
  'packages/weft/src/testing/promise-outcome.test-support.ts',
  'scripts/promise-outcome.test-support.ts',
];

export type PromiseAssertionModifierViolation = { line: number; text: string };

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** Every `expect(...).resolves` or `expect(...).rejects` access in a file. */
export function findPromiseAssertionModifierViolations(
  sourceFile: ts.SourceFile,
): PromiseAssertionModifierViolation[] {
  const violations: PromiseAssertionModifierViolation[] = [];
  walk(sourceFile, (node) => {
    if (
      !ts.isPropertyAccessExpression(node) ||
      (node.name.text !== 'resolves' && node.name.text !== 'rejects') ||
      !ts.isCallExpression(node.expression) ||
      !ts.isIdentifier(node.expression.expression) ||
      node.expression.expression.text !== 'expect'
    ) {
      return;
    }
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.name.getStart(sourceFile));
    violations.push({ line: line + 1, text: node.getText(sourceFile) });
  });
  return violations;
}

export function collectScannedFiles(directory: string, paths: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      collectScannedFiles(path, paths);
    } else if (entry.isFile() && SCANNED_FILE_PATTERN.test(entry.name)) {
      paths.push(path);
    }
  }
}

/** Copies whose bytes differ from the canonical module, or that are missing. */
export async function findDriftedCopies(repositoryRoot: string): Promise<string[]> {
  const canonical = await Bun.file(join(repositoryRoot, CANONICAL_PROMISE_OUTCOME)).text();
  const drifted: string[] = [];
  for (const copy of PROMISE_OUTCOME_COPIES) {
    const file = Bun.file(join(repositoryRoot, copy));
    if (!(await file.exists()) || (await file.text()) !== canonical) drifted.push(copy);
  }
  return drifted;
}

async function scan(): Promise<string[]> {
  const findings: string[] = [];
  const paths: string[] = [];
  for (const directory of SCANNED_DIRECTORIES) collectScannedFiles(join(root, directory), paths);

  for (const path of paths.toSorted()) {
    const relativePath = relative(root, path);
    if (EXEMPT_FILES.has(relativePath)) continue;
    const source = await Bun.file(path).text();
    if (!source.includes('.resolves') && !source.includes('.rejects')) continue;
    const sourceFile = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    for (const violation of findPromiseAssertionModifierViolations(sourceFile)) {
      findings.push(`${relativePath}:${violation.line} — ${violation.text}`);
    }
  }

  return findings;
}

async function main(): Promise<void> {
  const findings = await scan();
  const drifted = await findDriftedCopies(root);
  if (findings.length === 0 && drifted.length === 0) {
    process.stdout.write(
      'check-promise-assertion-modifiers — OK (no .resolves/.rejects; promise-outcome copies match).\n',
    );
    return;
  }

  if (findings.length > 0) {
    process.stderr.write(
      'check-promise-assertion-modifiers — expect(...).resolves or .rejects.\n' +
        'Bun runs these synchronously in a nested event loop, which can starve Worker\n' +
        'messages until the test times out. Assert on the awaited value instead:\n\n' +
        '  expect(await promise).toBe(value);\n' +
        '  expect(await rejectionOf(promise)).toBeInstanceOf(SomeError);\n' +
        "  expect(await throwingRejectionOf(promise)).toThrow('message');\n\n",
    );
    for (const finding of findings) process.stderr.write(`  ${finding}\n`);
  }
  if (drifted.length > 0) {
    process.stderr.write(
      `check-promise-assertion-modifiers — promise-outcome copies differ from ${CANONICAL_PROMISE_OUTCOME}:\n`,
    );
    for (const copy of drifted) process.stderr.write(`  ${copy}\n`);
  }
  process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('check-promise-assertion-modifiers failed:', error);
    process.exitCode = 1;
  });
}
