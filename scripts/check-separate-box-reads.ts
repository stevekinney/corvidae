/**
 * Guard against comparing positions that come from separate `boundingBox()` reads in
 * Interborough's end-to-end specs.
 *
 * Each `locator.boundingBox()` is its own round trip to the browser. A page that is still
 * moving (scrolling a newly opened row to the middle, settling a transition, growing a list)
 * lays out differently between two reads, so a position taken from one read and a position
 * taken from another can describe two different moments. `chat-responsive.spec.ts` read a row
 * and two buttons about 10 ms apart while the page was centring the row; the reads straddled a
 * scroll and the buttons appeared 22px apart (COR-2459, the same class as COR-2412).
 *
 * The guard flags one statement (an expression statement such as an `expect(...)` assertion, a
 * `return` or `if` condition that does arithmetic or a comparison, or the declaration of a
 * value computed from several reads) whose geometry derives from two or more separate reads: a
 * `boundingBox()` call, or an `.evaluate(...)` whose callback calls `getBoundingClientRect`.
 * Reads reach a statement directly or through a variable declared from a read, so
 * `const a = await x.boundingBox(); const b = await y.boundingBox(); expect(a.y).toBe(b.y)` is
 * flagged and `expect(a.width).toBeGreaterThan(10)` is not. A read inside a callback
 * (`controls.map((c) => c.boundingBox())`) runs once per element, so it counts as several
 * reads. A `=== null` or `=== undefined` test of a read compares no geometry and is ignored.
 * A value computed from several reads is flagged once, at its declaration, and counts as one
 * value afterwards.
 *
 * Limits: the guard follows variables declared with `const`/`let` in the same file, and not a
 * helper whose block body returns a read, nor the variable of a `for...of` loop. Those stay the
 * author's responsibility.
 *
 * The fix: wait for the settled state (`await expect(row).toBeFocused()`, a visible and
 * stable element), then read every box together with `readBoxes(page, { ... })` from
 * `applications/interborough/tests/e2e/read-boxes.ts`, which takes all the rects in one
 * in-page evaluation.
 *
 * Scope: only `applications/interborough/tests/e2e/`. The browser-fixture suites under
 * `scripts/browser-fixtures/tests/` render pages where nothing moves and are not scanned.
 *
 * Existing instances are listed in `ALLOWED_INSTANCES` with a reason. The allowlist only
 * shrinks: a file's entry must equal the count found, so a fixed instance fails the guard until
 * the entry is lowered or removed, and a new one fails it outright.
 */

import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const root = join(import.meta.dir, '..');
const SCANNED_DIRECTORY = 'applications/interborough/tests/e2e';

export type SeparateBoxReadViolation = { line: number; text: string };

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function isReadCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  const name = node.expression.name.text;
  if (name === 'boundingBox') return true;
  return name === 'evaluate' && node.arguments.some((argument) => callsRectRead(argument));
}

function callsRectRead(node: ts.Node): boolean {
  let found = false;
  walk(node, (inner) => {
    if (
      ts.isIdentifier(inner) &&
      (inner.text === 'getBoundingClientRect' || inner.text === 'getClientRects')
    ) {
      found = true;
    }
  });
  return found;
}

function isFunctionBoundary(node: ts.Node): boolean {
  return ts.isFunctionLike(node) || ts.isSourceFile(node);
}

function enclosingBoundaries(node: ts.Node): ts.Node[] {
  const boundaries: ts.Node[] = [];
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (isFunctionBoundary(current)) boundaries.push(current);
  }
  return boundaries;
}

/** The nearest function-like scope, or the file, that holds a declaration. */
function scopeOf(node: ts.Node): ts.Node {
  return enclosingBoundaries(node)[0] as ts.Node;
}

type Declaration = { name: string; position: number; scope: ts.Node; origins: Set<number> };

/**
 * The read origins a node draws on: each read call it contains, plus the origins of each
 * tracked variable it names. A read call inside a callback (`controls.map((c) => c.boundingBox())`)
 * runs once per element, one after another, so it counts as two origins: the reads it makes
 * are separate from each other.
 */
function originsOf(node: ts.Node, declarations: Declaration[]): Set<number> {
  const origins = new Set<number>();
  const visit = (inner: ts.Node, inCallback: boolean): void => {
    // A callback with a block body (a `test(...)` body) holds statements of its own, which the
    // walk judges one by one; only an expression-bodied callback belongs to this statement.
    if (ts.isFunctionLike(inner) && 'body' in inner && inner.body && ts.isBlock(inner.body)) return;
    if (isReadCall(inner)) {
      origins.add(inner.getStart());
      if (inCallback) origins.add(-inner.getStart() - 1);
    } else if (ts.isIdentifier(inner) && !isDeclarationName(inner)) {
      const declaration = resolve(inner, declarations);
      if (declaration) for (const origin of declaration.origins) origins.add(origin);
    }
    const nowInCallback = inCallback || (ts.isFunctionLike(inner) && inner !== node);
    inner.forEachChild((child) => visit(child, nowInCallback));
  };
  visit(node, false);
  return origins;
}

function isDeclarationName(identifier: ts.Identifier): boolean {
  const { parent } = identifier;
  return (
    (ts.isVariableDeclaration(parent) && parent.name === identifier) ||
    (ts.isBindingElement(parent) && parent.name === identifier) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier)
  );
}

function resolve(identifier: ts.Identifier, declarations: Declaration[]): Declaration | null {
  const boundaries = new Set(enclosingBoundaries(identifier));
  let best: Declaration | null = null;
  for (const declaration of declarations) {
    if (declaration.name !== identifier.text) continue;
    if (declaration.position >= identifier.getStart()) continue;
    if (!boundaries.has(declaration.scope)) continue;
    if (best === null || declaration.position > best.position) best = declaration;
  }
  return best;
}

function boundNames(name: ts.BindingName, names: ts.Identifier[] = []): ts.Identifier[] {
  if (ts.isIdentifier(name)) names.push(name);
  else {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) boundNames(element.name, names);
    }
  }
  return names;
}

export function findSeparateBoxReadViolations(
  sourceFile: ts.SourceFile,
): SeparateBoxReadViolation[] {
  const violations: SeparateBoxReadViolation[] = [];
  const declarations: Declaration[] = [];

  const report = (node: ts.Node): void => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({ line: line + 1, text: node.getText(sourceFile).split('\n')[0] ?? '' });
  };

  const judge = (node: ts.Node, expression: ts.Node): void => {
    if (originsOf(expression, declarations).size >= 2) report(node);
  };

  // Statements are visited in source order, so a declaration is known before its uses.
  walk(sourceFile, (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const origins = originsOf(node.initializer, declarations);
      // A value computed from several reads is the comparison; a value that only gathers reads
      // (a read, a `Promise.all` of reads) carries its origins on to the statement that compares.
      let recorded = origins;
      if (origins.size >= 2 && computesFromOperands(node.initializer)) {
        report(node);
        recorded = new Set([node.getStart()]);
      }
      const perElement = elementOrigins(node, declarations);
      for (const name of boundNames(node.name)) {
        declarations.push({
          name: name.text,
          position: node.getStart(),
          scope: scopeOf(node),
          origins: perElement.get(name.text) ?? recorded,
        });
      }
      return;
    }
    if (ts.isExpressionStatement(node)) judge(node, node.expression);
    else if (
      ts.isReturnStatement(node) &&
      node.expression &&
      computesFromOperands(node.expression)
    ) {
      judge(node, node.expression);
    } else if (ts.isIfStatement(node) && computesFromOperands(node.expression)) {
      judge(node, node.expression);
    }
  });

  return violations;
}

const OPERAND_OPERATORS = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

/** True when the initializer does arithmetic or a comparison, as opposed to only collecting reads. */
function computesFromOperands(initializer: ts.Node): boolean {
  let computes = false;
  walk(initializer, (inner) => {
    if (
      ts.isBinaryExpression(inner) &&
      OPERAND_OPERATORS.has(inner.operatorToken.kind) &&
      !isNullCheck(inner)
    ) {
      computes = true;
    }
  });
  return computes;
}

/** `box === null` asks whether a read found the element; it compares no geometry. */
function isNullCheck(expression: ts.BinaryExpression): boolean {
  const isNull = (operand: ts.Expression): boolean =>
    operand.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(operand) && operand.text === 'undefined');
  return isNull(expression.left) || isNull(expression.right);
}

/**
 * For `const [a, b] = await Promise.all([x.boundingBox(), y.boundingBox()])`, each name draws on
 * its own element's reads, so `expect(a.width)` alone is not a comparison across reads.
 */
function elementOrigins(
  declaration: ts.VariableDeclaration,
  declarations: Declaration[],
): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  const { name, initializer } = declaration;
  if (!ts.isArrayBindingPattern(name) || initializer === undefined) return result;
  let call: ts.Expression = initializer;
  while (ts.isAwaitExpression(call) || ts.isParenthesizedExpression(call)) call = call.expression;
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return result;
  if (call.expression.name.text !== 'all') return result;
  const [list] = call.arguments;
  if (list === undefined || !ts.isArrayLiteralExpression(list)) return result;
  name.elements.forEach((element, index) => {
    const source = list.elements[index];
    if (ts.isBindingElement(element) && ts.isIdentifier(element.name) && source !== undefined) {
      result.set(element.name.text, originsOf(source, declarations));
    }
  });
  return result;
}

/**
 * Instances present when the guard was added (COR-2459), by file. A fixed instance lowers the
 * count, and an entry that no longer matches fails the guard, so the list only shrinks.
 */
const NOT_YET_CONVERTED =
  'present when the guard was added and not yet converted to readBoxes; convert it the next time the spec is touched';
const WITH_BEFORE_AND_AFTER =
  'as the others, and some compare a box before and after an action on purpose, so those reads are meant to be separate';

function entries(counts: Record<string, number>, reason: string) {
  return Object.entries(counts).map(([file, count]) => [
    `applications/interborough/tests/e2e/${file}`,
    { count, reason },
  ]);
}

export const ALLOWED_INSTANCES: Record<string, { count: number; reason: string }> =
  Object.fromEntries([
    ...entries(
      {
        '14-shell-and-principal.spec.ts': 2,
        'chat-states.spec.ts': 1,
        'first-run.spec.ts': 3,
        'health-audit-states.spec.ts': 2,
        'health-audit.spec.ts': 6,
        'health-overview.spec.ts': 2,
        'health-states.spec.ts': 2,
        'health-storage.spec.ts': 5,
        'health-workers-states.spec.ts': 3,
        'run-page.spec.ts': 4,
        'run-steps.spec.ts': 2,
        'schedules-detail.spec.ts': 7,
        'schedules-new.spec.ts': 3,
        'schedules-states.spec.ts': 2,
        'settings-allowed-models.spec.ts': 3,
        'settings-general.spec.ts': 1,
        'settings-models.spec.ts': 3,
        'shell-states.spec.ts': 1,
        'workflow-page.spec.ts': 1,
      },
      NOT_YET_CONVERTED,
    ),
    ...entries({ 'chat-list.spec.ts': 2, 'home.spec.ts': 28 }, WITH_BEFORE_AND_AFTER),
  ]);

export function collectSpecFiles(directory: string, paths: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collectSpecFiles(path, paths);
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      paths.push(path);
    }
  }
}

export async function scan(): Promise<{ file: string; violations: SeparateBoxReadViolation[] }[]> {
  const paths: string[] = [];
  collectSpecFiles(join(root, SCANNED_DIRECTORY), paths);
  const results: { file: string; violations: SeparateBoxReadViolation[] }[] = [];
  for (const path of paths.toSorted()) {
    const source = await Bun.file(path).text();
    if (!source.includes('boundingBox') && !source.includes('getBoundingClientRect')) continue;
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const violations = findSeparateBoxReadViolations(sourceFile);
    if (violations.length > 0) results.push({ file: relative(root, path), violations });
  }
  return results;
}

async function main(): Promise<void> {
  const results = await scan();
  const problems: string[] = [];
  const allowed = new Map(Object.entries(ALLOWED_INSTANCES));

  for (const { file, violations } of results) {
    const entry = allowed.get(file);
    allowed.delete(file);
    if (entry !== undefined && entry.count === violations.length) continue;
    if (entry !== undefined) {
      problems.push(
        `${file}: ${violations.length} instance(s) found, the allowlist says ${entry.count}. ` +
          'Lower the entry when you fix one; never raise it.',
      );
    }
    for (const violation of violations) {
      problems.push(`${file}:${violation.line} — ${violation.text}`);
    }
  }
  for (const file of allowed.keys()) {
    problems.push(`${file}: allowlisted, but no instance is left. Remove the entry.`);
  }

  if (problems.length === 0) {
    process.stdout.write(
      'check-separate-box-reads — OK (no assertion compares geometry from separate reads beyond the allowlist).\n',
    );
    return;
  }

  process.stderr.write(
    'check-separate-box-reads — geometry from two or more separate boundingBox() reads in one\n' +
      'comparison. Each read is its own round trip, so a page that is still moving can lay out\n' +
      'differently between them (COR-2459). Wait for the settled state, then read every box with\n' +
      'readBoxes(page, { ... }) from tests/e2e/read-boxes.ts, which takes them in one evaluation:\n\n' +
      '  await expect(row).toBeFocused();\n  const { deny, approve } = await readBoxes(page, { deny: denyButton, approve: approveButton });\n  expect(Math.abs(deny.y - approve.y)).toBeLessThan(1);\n\n',
  );
  for (const problem of problems) process.stderr.write(`  ${problem}\n`);
  process.exit(1);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('check-separate-box-reads failed:', error);
    process.exit(1);
  });
}
