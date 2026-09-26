/**
 * Guard against asserting a DOM element's absence inside a `waitFor` callback.
 *
 * `waitFor` runs its callback once synchronously, usually before Svelte has
 * flushed the unmount being waited for, so the first poll of
 * `waitFor(() => expect(queryMenu()).toBeNull())` almost always fails while the
 * element is still mounted. Bun then builds that failure message by serializing
 * the whole happy-dom element graph: one failed poll measured 65–350 million
 * characters and 0.6–4 seconds of blocked event loop, scaling with host load
 * until a test crosses bun's per-test timeout. The retry succeeds, so the cost
 * is invisible until the host is busy.
 *
 * An absence assertion only pays that cost when it fails while holding an
 * element, so this guard flags exactly that shape inside a `waitFor` callback:
 *
 *   - an absence matcher: `toBeNull()`, `toBeUndefined()`, `toBeFalsy()`,
 *     `toBe(null)`, `toBe(undefined)`, `toEqual(null)`, `toStrictEqual(null)`,
 *     `not.toBeTruthy()`, or `not.toBeDefined()`;
 *   - applied to an element-shaped value: a DOM or testing-library query call
 *     (`querySelector`, `closest`, `getByRole`, a local `queryMenu()`), an
 *     element-valued property (`document.activeElement`), or a bare identifier.
 *
 * Presence assertions (`not.toBeNull()`, `toBeTruthy()`) fail only while the
 * value is null, which serializes cheaply, so they are not flagged. Neither is
 * a primitive projection such as `?.getAttribute('aria-hidden')`.
 *
 * The fix is to drive the unmount synchronously and assert without `waitFor`
 * (`flushSync()` from `svelte`, then `expect(...)`), or, where the unmount is
 * genuinely asynchronous, to assert on something cheap to serialize:
 * `waitFor(() => expect(queryMenu()?.outerHTML ?? null).toBeNull())`.
 *
 * Detection walks the TypeScript AST rather than matching text, so multi-line
 * and block-bodied callbacks are covered. oxlint's rule set cannot express
 * "inside the callback passed to `waitFor`", so this stays a local check wired
 * into the package's `lint` script.
 */

import { Glob } from 'bun';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDirectory, '..');
const sourceRoot = resolve(packageRoot, 'src');

const ABSENCE_MATCHERS = new Set(['toBeNull', 'toBeUndefined', 'toBeFalsy']);
const NEGATED_ABSENCE_MATCHERS = new Set(['toBeTruthy', 'toBeDefined']);
const EQUALITY_MATCHERS = new Set(['toBe', 'toEqual', 'toStrictEqual']);

const ELEMENT_QUERY_METHODS = new Set([
  'querySelector',
  'closest',
  'getElementById',
  'elementFromPoint',
]);

const ELEMENT_PROPERTIES = new Set([
  'activeElement',
  'body',
  'documentElement',
  'firstChild',
  'firstElementChild',
  'lastChild',
  'lastElementChild',
  'nextElementSibling',
  'nextSibling',
  'parentElement',
  'parentNode',
  'previousElementSibling',
  'previousSibling',
]);

// `get*`/`query*`/`find*` helpers conventionally return elements; these
// DOM methods share the prefix but return primitives.
const PRIMITIVE_GETTERS = new Set(['getAttribute', 'getAttributeNS', 'getPropertyValue']);

const QUERY_HELPER_PATTERN = /^(?:get|query|find)[A-Z]/;

export type WaitForElementAssertionViolation = { line: number; text: string };

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
    ts.isSatisfiesExpression(current) ||
    ts.isAwaitExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function calleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function isWaitForCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && calleeName(node.expression) === 'waitFor';
}

function isElementShaped(value: ts.Expression): boolean {
  const expression = unwrap(value);
  if (ts.isIdentifier(expression)) return expression.text !== 'undefined';
  if (ts.isPropertyAccessExpression(expression)) {
    return ELEMENT_PROPERTIES.has(expression.name.text);
  }
  if (!ts.isCallExpression(expression)) return false;
  const name = calleeName(expression.expression);
  if (name === null || PRIMITIVE_GETTERS.has(name)) return false;
  return ELEMENT_QUERY_METHODS.has(name) || QUERY_HELPER_PATTERN.test(name);
}

function isNullish(argument: ts.Expression | undefined): boolean {
  if (argument === undefined) return false;
  const expression = unwrap(argument);
  return (
    expression.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(expression) && expression.text === 'undefined')
  );
}

/**
 * For `expect(value)`, resolve the matcher applied to it: `.toBeNull()` or
 * `.not.toBeTruthy()`, returning the matcher call and whether it is negated.
 */
function matcherFor(
  expectCall: ts.CallExpression,
): { name: string; negated: boolean; call: ts.CallExpression } | null {
  let access = expectCall.parent;
  let negated = false;
  if (!ts.isPropertyAccessExpression(access) || access.expression !== expectCall) return null;
  if (access.name.text === 'not') {
    negated = true;
    const next = access.parent;
    if (!ts.isPropertyAccessExpression(next) || next.expression !== access) return null;
    access = next;
  }
  const call = access.parent;
  if (!ts.isCallExpression(call) || call.expression !== access) return null;
  return { name: access.name.text, negated, call };
}

function assertsAbsence(matcher: {
  name: string;
  negated: boolean;
  call: ts.CallExpression;
}): boolean {
  if (matcher.negated) return NEGATED_ABSENCE_MATCHERS.has(matcher.name);
  if (ABSENCE_MATCHERS.has(matcher.name)) return true;
  return EQUALITY_MATCHERS.has(matcher.name) && isNullish(matcher.call.arguments[0]);
}

export function findWaitForElementAssertionViolations(
  sourceFile: ts.SourceFile,
): WaitForElementAssertionViolation[] {
  const violations: WaitForElementAssertionViolation[] = [];
  const reported = new Set<ts.Node>();

  walk(sourceFile, (node) => {
    if (!isWaitForCall(node)) return;
    const callback = node.arguments[0];
    if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return;

    walk(callback.body, (inner) => {
      if (
        !ts.isCallExpression(inner) ||
        !ts.isIdentifier(inner.expression) ||
        inner.expression.text !== 'expect'
      ) {
        return;
      }
      const [value] = inner.arguments;
      if (!value || !isElementShaped(value)) return;
      const matcher = matcherFor(inner);
      if (!matcher || !assertsAbsence(matcher) || reported.has(matcher.call)) return;
      reported.add(matcher.call);
      const { line } = sourceFile.getLineAndCharacterOfPosition(matcher.call.getStart(sourceFile));
      violations.push({ line: line + 1, text: matcher.call.getText(sourceFile) });
    });
  });

  return violations;
}

async function scan(): Promise<string[]> {
  const findings: string[] = [];
  const glob = new Glob('**/*.test.ts');
  const paths = [...glob.scanSync({ cwd: sourceRoot, absolute: true })].toSorted();

  for (const path of paths) {
    const source = await Bun.file(path).text();
    if (!source.includes('waitFor')) continue;
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    for (const violation of findWaitForElementAssertionViolations(sourceFile)) {
      findings.push(`${relative(packageRoot, path)}:${violation.line} — ${violation.text}`);
    }
  }

  return findings;
}

async function main(): Promise<void> {
  const findings = await scan();
  if (findings.length === 0) {
    process.stdout.write(
      'check-wait-for-element-assertions — OK (no element absence assertions inside waitFor).\n',
    );
    return;
  }

  process.stderr.write(
    'check-wait-for-element-assertions — absence assertion on a DOM element inside waitFor.\n' +
      "waitFor's first poll usually runs before the unmount flushes, and bun serializes the\n" +
      'whole happy-dom element graph into that failure message (tens of megabytes, seconds\n' +
      'of blocked event loop under load). Either drive the unmount synchronously and assert\n' +
      'without waitFor (flushSync() from svelte, then expect), or assert on something cheap:\n\n' +
      '  await waitFor(() => expect(queryMenu()?.outerHTML ?? null).toBeNull());\n\n',
  );
  for (const finding of findings) {
    process.stderr.write(`  ${finding}\n`);
  }
  process.exit(1);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('check-wait-for-element-assertions failed:', error);
    process.exit(1);
  });
}
