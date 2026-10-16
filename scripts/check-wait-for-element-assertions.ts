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
 * Element identity assertions pay the same cost from the other direction:
 * `waitFor(() => expect(document.activeElement).toBe(button))` fails its first
 * poll while focus has not moved yet, and bun serializes both elements into the
 * message. So the guard also flags `toBe`, `toEqual`, and `toStrictEqual`
 * (negated or not) when either operand is element-valued: an element-shaped
 * query call or property as above, a same-file helper or variable whose type
 * annotation names an element type (`HTMLElement`, `Element`, `Node`,
 * `SVG…Element`), a variable initialized from an element-valued expression, a
 * call narrowed by an element constructor (`requiredInstance(x,
 * HTMLButtonElement)`), or an index into an element list. A bare identifier is
 * element-valued here only when its same-file declaration says so, because
 * equality matchers compare counters and strings far more often than elements;
 * an identifier bound elsewhere (a parameter, a `waitFor` result) is not
 * resolved, so those comparisons remain the author's responsibility.
 *
 * The fix is to drive the change synchronously and assert without `waitFor`
 * (`flushSync()` from `svelte`, then `expect(...)`), or, where the change is
 * genuinely asynchronous, to assert on something cheap to serialize:
 * `waitFor(() => expect(queryMenu()?.outerHTML ?? null).toBeNull())` or
 * `waitFor(() => expect(document.activeElement === button).toBe(true))`.
 *
 * Detection walks the TypeScript AST rather than matching text, so multi-line
 * and block-bodied callbacks are covered. oxlint's rule set cannot express
 * "inside the callback passed to `waitFor`", so this stays a local check.
 *
 * The hazard belongs to bun and happy-dom, not to any one package, so the scan
 * covers every `*.test.ts` in every workspace directory and root `scripts/`,
 * and runs from the root `lint:root` script. A workspace added later is
 * covered without opting in.
 */

import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { workspaceParentDirectories } from './workspace-directories.ts';

const root = join(import.meta.dir, '..');
const SCANNED_DIRECTORIES = [...workspaceParentDirectories, 'scripts'];
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

const ABSENCE_MATCHERS = new Set(['toBeNull', 'toBeUndefined', 'toBeFalsy']);
const NEGATED_ABSENCE_MATCHERS = new Set(['toBeTruthy', 'toBeDefined']);
const EQUALITY_MATCHERS = new Set(['toBe', 'toEqual', 'toStrictEqual']);

const ELEMENT_QUERY_METHODS = new Set([
  'querySelector',
  'querySelectorAll',
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

const ELEMENT_TYPE_PATTERN = /^(?:Element|Node|(?:HTML|SVG)\w*Element)$/;

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

function assertsAbsence(matcher: {
  name: string;
  negated: boolean;
  call: ts.CallExpression;
}): boolean {
  if (matcher.negated) return NEGATED_ABSENCE_MATCHERS.has(matcher.name);
  if (ABSENCE_MATCHERS.has(matcher.name)) return true;
  return EQUALITY_MATCHERS.has(matcher.name) && isNullish(matcher.call.arguments[0]);
}

function namesElementType(type: ts.TypeNode | undefined): boolean {
  if (type === undefined) return false;
  if (ts.isParenthesizedTypeNode(type)) return namesElementType(type.type);
  if (ts.isUnionTypeNode(type)) return type.types.some(namesElementType);
  if (ts.isArrayTypeNode(type)) return namesElementType(type.elementType);
  return (
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    ELEMENT_TYPE_PATTERN.test(type.typeName.text)
  );
}

type Declarations = {
  variables: Map<string, ts.VariableDeclaration[]>;
  functions: Map<string, ts.SignatureDeclaration[]>;
};

function append<Value>(map: Map<string, Value[]>, key: string, value: Value): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

/**
 * Index every named variable and function in the file. Scoping is ignored on
 * purpose: a name counts as element-valued if any same-file declaration of it
 * is, which is the conservative direction for a guard.
 */
function collectDeclarations(sourceFile: ts.SourceFile): Declarations {
  const declarations: Declarations = { variables: new Map(), functions: new Map() };
  walk(sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      append(declarations.functions, node.name.text, node);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const { initializer } = node;
      if (
        initializer &&
        (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
      ) {
        append(declarations.functions, node.name.text, initializer);
      } else {
        append(declarations.variables, node.name.text, node);
      }
    }
  });
  return declarations;
}

function isElementValued(
  value: ts.Expression,
  declarations: Declarations,
  visiting: Set<string> = new Set(),
): boolean {
  if (ts.isAsExpression(value) && namesElementType(value.type)) return true;
  const expression = unwrap(value);
  if (ts.isIdentifier(expression)) {
    const name = expression.text;
    if (visiting.has(name)) return false;
    visiting.add(name);
    return (declarations.variables.get(name) ?? []).some(
      (declaration) =>
        namesElementType(declaration.type) ||
        (declaration.initializer !== undefined &&
          isElementValued(declaration.initializer, declarations, visiting)),
    );
  }
  if (isElementShaped(expression)) return true;
  if (ts.isElementAccessExpression(expression)) {
    return isElementValued(expression.expression, declarations, visiting);
  }
  if (!ts.isCallExpression(expression)) return false;
  const narrowedByConstructor = expression.arguments.some(
    (argument) => ts.isIdentifier(argument) && ELEMENT_TYPE_PATTERN.test(argument.text),
  );
  if (narrowedByConstructor) return true;
  if (!ts.isIdentifier(expression.expression)) return false;
  return (declarations.functions.get(expression.expression.text) ?? []).some((declaration) =>
    namesElementType(declaration.type),
  );
}

function comparesElements(
  expectCall: ts.CallExpression,
  matcher: { name: string; call: ts.CallExpression },
  declarations: Declarations,
): boolean {
  if (!EQUALITY_MATCHERS.has(matcher.name)) return false;
  const [actual] = expectCall.arguments;
  const [expected] = matcher.call.arguments;
  return [actual, expected].some(
    (operand) => operand !== undefined && isElementValued(operand, declarations),
  );
}

export function findWaitForElementAssertionViolations(
  sourceFile: ts.SourceFile,
): WaitForElementAssertionViolation[] {
  const violations: WaitForElementAssertionViolation[] = [];
  const reported = new Set<ts.Node>();
  const declarations = collectDeclarations(sourceFile);

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
      const matcher = matcherFor(inner);
      if (!matcher || reported.has(matcher.call)) return;
      const [value] = inner.arguments;
      const absenceOfElement =
        value !== undefined && isElementShaped(value) && assertsAbsence(matcher);
      if (!absenceOfElement && !comparesElements(inner, matcher, declarations)) return;
      reported.add(matcher.call);
      const { line } = sourceFile.getLineAndCharacterOfPosition(matcher.call.getStart(sourceFile));
      violations.push({ line: line + 1, text: matcher.call.getText(sourceFile) });
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
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
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
    if (!source.includes('waitFor')) continue;
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    for (const violation of findWaitForElementAssertionViolations(sourceFile)) {
      findings.push(`${relative(root, path)}:${violation.line} — ${violation.text}`);
    }
  }

  return findings;
}

async function main(): Promise<void> {
  const findings = await scan();
  if (findings.length === 0) {
    process.stdout.write(
      'check-wait-for-element-assertions — OK (no element absence or identity assertions inside waitFor).\n',
    );
    return;
  }

  process.stderr.write(
    'check-wait-for-element-assertions — absence or identity assertion on a DOM element inside waitFor.\n' +
      "waitFor's first poll usually runs before the change flushes, and bun serializes the\n" +
      'whole happy-dom element graph into that failure message (tens of megabytes, seconds\n' +
      'of blocked event loop under load). Either drive the change synchronously and assert\n' +
      'without waitFor (flushSync() from svelte, then expect), or assert on something cheap:\n\n' +
      '  await waitFor(() => expect(queryMenu()?.outerHTML ?? null).toBeNull());\n' +
      '  await waitFor(() => expect(document.activeElement === button).toBe(true));\n\n',
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
