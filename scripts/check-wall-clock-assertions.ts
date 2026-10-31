/**
 * Guard against assertions whose pass or fail depends on host-load-sensitive
 * elapsed time inside the default test gate.
 *
 * A test that reads a clock, subtracts two readings, and asserts an upper bound
 * on the result measures the machine as much as the code. Under concurrent
 * agent sessions the host load swings by an order of magnitude, so whichever
 * such test happens to be on the clock fails, and it passes alone. AGENTS.md
 * rules that a wall-clock target belongs outside the gate: in a `*.bench.ts`
 * file, which Bun's default discovery skips, run by the owning package's
 * `test:benchmarks`. This guard enforces that rule for every default-suite
 * `*.test.ts` and `*.test-support.ts`, wherever it lives. A directory of benchmarks earns no
 * exemption: what makes a file a benchmark is its name, so a `.test.ts` under
 * `scripts/benchmarks/` is a default-suite test and is scanned like any other.
 *
 * Definitions, all syntactic and file-local:
 *
 *   - A reading is a call to `performance.now()`, `Date.now()`,
 *     `Bun.nanoseconds()`, `process.hrtime()` or `process.hrtime.bigint()`
 *     (optionally qualified with `globalThis.`).
 *   - An expression is reading-valued if it is a reading or a name bound to a
 *     reading-valued expression.
 *   - A duration is a `-` or `+` of two reading-valued expressions or of one
 *     reading-valued expression and a numeric literal, passed through
 *     parentheses, a ternary, `Number(...)`, `Math.min`, `Math.max`,
 *     `Math.abs`, `Math.round`, `Math.floor`, `Math.ceil` or `Math.trunc`, or
 *     scaled by a numeric literal with `*` or `/`.
 *   - A rate is a duration used as an operand of `*` or `/` with anything other
 *     than a numeric literal (or a numeric literal divided by a duration),
 *     passed through the same wrappers or scaled by a numeric literal.
 *
 * Readings, durations and rates propagate through a `const` or `let` declared
 * in the file with a plain identifier name, and through every later assignment
 * to it (`=`, `+=`, and the rest) at any depth, so
 * `fastest = Math.min(fastest, performance.now() - startedAt)` in a loop makes
 * `fastest` a duration. Propagation is by name across the whole file with
 * scoping ignored, like the `waitFor` guard: a name reused in unrelated tests
 * shares taint. That is deliberate and conservative. A false positive is fixed
 * by renaming the local variable; there is no allowlist.
 *
 * The guard reports an `expect` whose matcher is `toBeLessThan`,
 * `toBeLessThanOrEqual`, `toBeGreaterThan` or `toBeGreaterThanOrEqual`, with or
 * without `.not`, when the subject is a duration and the bound is an upper
 * bound (`toBeLessThan*`, or `.not.toBeGreaterThan*`), when the subject or the
 * argument is a rate, or when the subject and the argument are both durations.
 * A plain lower bound on a duration is not reported, because load cannot make
 * it fail. A single reading compared with a stored timestamp is neither a
 * duration nor a rate and is not reported.
 *
 * Blind spots, documented rather than claimed as covered. The guard cannot see:
 *
 *   - a duration returned from a helper call (`const { elapsed } = await
 *     measure()`, `timeIt(work)`), because neither propagates through a call
 *     that is not in the list above;
 *   - a duration stored in an object property or an array element
 *     (`result.elapsed`, `samples[0]`, `detail.durationMilliseconds`), a
 *     parameter, a destructured binding or a `for` binding;
 *   - a duration compared through `toBeCloseTo`, or a boolean built somewhere other than
 *     an operand of `check(...)`, `assert(...)` or `expect(...)`. A relational comparison of a
 *     duration inside those calls (`check('fast', elapsed < 4000)`,
 *     `expect(elapsed <= budget).toBe(true)`) is reported, and so are the `*.test-support.ts`
 *     files that cases are written in; the condition of a loop or an `if` is not, because a
 *     polling deadline is a hang guard;
 *   - a bound that lives outside the file, or a clock read inside a helper in
 *     another file.
 *
 * One property-held site known at the time of writing is such a blind spot:
 * `packages/operative/test/generate-events.test.ts` asserts
 * `detail.durationMilliseconds` under 5,000, which the guard cannot report.
 *
 * `*.bench.ts` files are outside Bun's default discovery and outside the scan.
 * A workspace added later is covered without opting in.
 */

import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
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

const READING_CALLEES = new Set([
  'performance.now',
  'Date.now',
  'Bun.nanoseconds',
  'process.hrtime',
  'process.hrtime.bigint',
]);
const READING_MARKERS = ['performance.now', 'Date.now', 'nanoseconds', 'hrtime'];

const PASS_THROUGH_CALLEES = new Set([
  'Number',
  'Math.min',
  'Math.max',
  'Math.abs',
  'Math.round',
  'Math.floor',
  'Math.ceil',
  'Math.trunc',
]);

const UPPER_BOUND_MATCHERS = new Set(['toBeLessThan', 'toBeLessThanOrEqual']);
const LOWER_BOUND_MATCHERS = new Set(['toBeGreaterThan', 'toBeGreaterThanOrEqual']);

export type WallClockAssertionViolation = { line: number; matcher: string; text: string };

type Binding = { name: string; value: ts.Expression };
type Taint = { readings: Set<string>; durations: Set<string>; rates: Set<string> };

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

function isNumericLiteral(expression: ts.Expression): boolean {
  const unwrapped = unwrap(expression);
  if (ts.isNumericLiteral(unwrapped)) return true;
  return (
    ts.isPrefixUnaryExpression(unwrapped) &&
    (unwrapped.operator === ts.SyntaxKind.MinusToken ||
      unwrapped.operator === ts.SyntaxKind.PlusToken) &&
    ts.isNumericLiteral(unwrapped.operand)
  );
}

function isReadingCall(expression: ts.Expression): boolean {
  if (!ts.isCallExpression(expression)) return false;
  const name = dottedName(expression.expression);
  return name !== null && READING_CALLEES.has(name);
}

/** Collect every `const`/`let` initializer and every assignment to a plain identifier. */
function collectBindings(sourceFile: ts.SourceFile): Binding[] {
  const bindings: Binding[] = [];
  walk(sourceFile, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) !== 0
    ) {
      bindings.push({ name: node.name.text, value: node.initializer });
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left)
    ) {
      bindings.push({ name: node.left.text, value: node.right });
    }
  });
  return bindings;
}

function isReading(expression: ts.Expression, taint: Taint): boolean {
  const unwrapped = unwrap(expression);
  if (ts.isIdentifier(unwrapped)) return taint.readings.has(unwrapped.text);
  return isReadingCall(unwrapped);
}

function isDuration(expression: ts.Expression, taint: Taint): boolean {
  const unwrapped = unwrap(expression);
  if (ts.isIdentifier(unwrapped)) return taint.durations.has(unwrapped.text);
  if (ts.isConditionalExpression(unwrapped)) {
    return isDuration(unwrapped.whenTrue, taint) || isDuration(unwrapped.whenFalse, taint);
  }
  if (ts.isCallExpression(unwrapped)) {
    const name = dottedName(unwrapped.expression);
    return (
      name !== null &&
      PASS_THROUGH_CALLEES.has(name) &&
      unwrapped.arguments.some((argument) => isDuration(argument, taint))
    );
  }
  if (!ts.isBinaryExpression(unwrapped)) return false;
  const { left, right } = unwrapped;
  switch (unwrapped.operatorToken.kind) {
    case ts.SyntaxKind.MinusToken:
    case ts.SyntaxKind.PlusToken:
      return (
        (isReading(left, taint) && isReading(right, taint)) ||
        (isReading(left, taint) && isNumericLiteral(right)) ||
        (isNumericLiteral(left) && isReading(right, taint))
      );
    case ts.SyntaxKind.AsteriskToken:
      return (
        (isDuration(left, taint) && isNumericLiteral(right)) ||
        (isNumericLiteral(left) && isDuration(right, taint))
      );
    case ts.SyntaxKind.SlashToken:
      return isDuration(left, taint) && isNumericLiteral(right);
    default:
      return false;
  }
}

function isRate(expression: ts.Expression, taint: Taint): boolean {
  const unwrapped = unwrap(expression);
  if (ts.isIdentifier(unwrapped)) return taint.rates.has(unwrapped.text);
  if (ts.isConditionalExpression(unwrapped)) {
    return isRate(unwrapped.whenTrue, taint) || isRate(unwrapped.whenFalse, taint);
  }
  if (ts.isCallExpression(unwrapped)) {
    const name = dottedName(unwrapped.expression);
    return (
      name !== null &&
      PASS_THROUGH_CALLEES.has(name) &&
      unwrapped.arguments.some((argument) => isRate(argument, taint))
    );
  }
  if (!ts.isBinaryExpression(unwrapped)) return false;
  const kind = unwrapped.operatorToken.kind;
  if (kind !== ts.SyntaxKind.AsteriskToken && kind !== ts.SyntaxKind.SlashToken) return false;
  const { left, right } = unwrapped;
  if (isRate(left, taint) || isRate(right, taint)) return true;
  // A duration in a divisor makes a rate even under a numeric literal
  // (`1000 / elapsed`); as a multiplier or dividend it needs a non-literal partner.
  if (kind === ts.SyntaxKind.SlashToken && isDuration(right, taint)) return true;
  return (
    (isDuration(left, taint) && !isNumericLiteral(right)) ||
    (isDuration(right, taint) && !isNumericLiteral(left))
  );
}

/** Grow the reading, duration and rate names until a pass adds none. */
function propagate(bindings: Binding[]): Taint {
  const taint: Taint = { readings: new Set(), durations: new Set(), rates: new Set() };
  let changed = true;
  while (changed) {
    changed = false;
    for (const { name, value } of bindings) {
      const additions: [Set<string>, boolean][] = [
        [taint.readings, isReading(value, taint)],
        [taint.durations, isDuration(value, taint)],
        [taint.rates, isRate(value, taint)],
      ];
      for (const [names, applies] of additions) {
        if (applies && !names.has(name)) {
          names.add(name);
          changed = true;
        }
      }
    }
  }
  return taint;
}

/**
 * For `expect(value)`, resolve the matcher applied to it: `.toBeLessThan(...)`
 * or `.not.toBeGreaterThan(...)`.
 */
function matcherFor(
  expectCall: ts.CallExpression,
): { name: string; negated: boolean; call: ts.CallExpression } | null {
  const receiver = expectCall.parent;
  if (!ts.isPropertyAccessExpression(receiver) || receiver.expression !== expectCall) return null;
  let access: ts.PropertyAccessExpression = receiver;
  let negated = false;
  if (receiver.name.text === 'not') {
    negated = true;
    const next = receiver.parent;
    if (!ts.isPropertyAccessExpression(next) || next.expression !== receiver) return null;
    access = next;
  }
  const call = access.parent;
  if (!ts.isCallExpression(call) || call.expression !== access) return null;
  return { name: access.name.text, negated, call };
}

const ASSERTING_CALLEES = new Set(['check', 'assert', 'expect']);

/**
 * Whether `node` is an operand of an assertion-like call (`check(...)`, `assert(...)`,
 * `expect(...)`), found by climbing out through operators and parentheses. A condition of a loop or
 * an `if` is not one: a polling loop's deadline is a hang guard, not a claim about speed.
 */
function isAsserted(node: ts.Node): boolean {
  for (let current = node; current.parent !== undefined; current = current.parent) {
    const parent = current.parent;
    if (ts.isCallExpression(parent) && parent.arguments.includes(current as ts.Expression)) {
      const name = dottedName(parent.expression);
      return name !== null && ASSERTING_CALLEES.has(name.split('.').at(-1) as string);
    }
    if (
      ts.isBlock(parent) ||
      ts.isSourceFile(parent) ||
      ts.isFunctionLike(parent) ||
      ts.isIterationStatement(parent, false) ||
      ts.isIfStatement(parent)
    ) {
      return false;
    }
  }
  return false;
}

const RELATIONAL_UPPER = new Set([ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken]);
const RELATIONAL_LOWER = new Set([
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

export function findWallClockAssertionViolations(
  sourceFile: ts.SourceFile,
): WallClockAssertionViolation[] {
  const violations: WallClockAssertionViolation[] = [];
  const taint = propagate(collectBindings(sourceFile));

  walk(sourceFile, (node) => {
    // `check('fast', elapsed < 4000)` and `expect(elapsed < 10).toBe(true)` hide the bound in a boolean.
    if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind;
      const duration = RELATIONAL_UPPER.has(kind)
        ? node.left
        : RELATIONAL_LOWER.has(kind)
          ? node.right
          : undefined;
      const bound = duration === node.left ? node.right : node.left;
      if (duration !== undefined && isDuration(duration, taint) && isAsserted(node)) {
        void bound;
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        violations.push({
          line: line + 1,
          matcher: node.operatorToken.getText(sourceFile),
          text: node.getText(sourceFile),
        });
      }
      return;
    }
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
    if (node.expression.text !== 'expect') return;
    const matcher = matcherFor(node);
    if (matcher === null) return;
    const isUpper = UPPER_BOUND_MATCHERS.has(matcher.name);
    const isLower = LOWER_BOUND_MATCHERS.has(matcher.name);
    if (!isUpper && !isLower) return;

    const [subject] = node.arguments;
    const [bound] = matcher.call.arguments;
    if (subject === undefined || bound === undefined) return;

    const upperBound = matcher.negated ? isLower : isUpper;
    const subjectIsDuration = isDuration(subject, taint);
    const reported =
      (subjectIsDuration && upperBound) ||
      isRate(subject, taint) ||
      isRate(bound, taint) ||
      (subjectIsDuration && isDuration(bound, taint));
    if (!reported) return;

    const { line } = sourceFile.getLineAndCharacterOfPosition(matcher.call.getStart(sourceFile));
    violations.push({
      line: line + 1,
      matcher: `${matcher.negated ? '.not.' : ''}${matcher.name}`,
      text: matcher.call.getText(sourceFile),
    });
  });

  return violations;
}

export function collectTestFiles(directory: string, paths: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      collectTestFiles(path, paths);
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test-support.ts'))
    ) {
      paths.push(path);
    }
  }
}

async function scan(): Promise<string[]> {
  const findings: string[] = [];
  const paths: string[] = [];
  for (const directory of SCANNED_DIRECTORIES) collectTestFiles(join(root, directory), paths);

  for (const path of paths.toSorted()) {
    const source = await Bun.file(path).text();
    if (!READING_MARKERS.some((marker) => source.includes(marker))) continue;
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    for (const violation of findWallClockAssertionViolations(sourceFile)) {
      findings.push(
        `${relative(root, path)}:${violation.line} — ${violation.matcher} — ${violation.text}`,
      );
    }
  }

  return findings;
}

async function main(): Promise<void> {
  const findings = await scan();
  if (findings.length === 0) {
    process.stdout.write(
      'check-wall-clock-assertions — OK (no host-load-sensitive timing assertions in default test files).\n',
    );
    return;
  }

  process.stderr.write(
    'check-wall-clock-assertions — timing assertion in a default test file.\n' +
      'An upper bound on elapsed time, or a rate or ratio derived from it, fails whichever test\n' +
      'is on the clock when the host is busy, and passes alone. Move a performance claim to a\n' +
      "`*.bench.ts` under the package's scripts/benchmarks/ (run by its test:benchmarks); for a\n" +
      'hang guard, drop the reading and rely on the per-test timeout; for a proxy, assert the\n' +
      'observable it stands in for.\n\n',
  );
  for (const finding of findings) {
    process.stderr.write(`  ${finding}\n`);
  }
  process.exit(1);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('check-wall-clock-assertions failed:', error);
    process.exit(1);
  });
}
