/**
 * Fails when a workspace's `src` reads a plain record with a key it does not control.
 *
 * `record[name]` on a plain object also answers for the keys every object inherits:
 * `constructor`, `toString`, `__proto__`, `hasOwnProperty`. When `name` comes from user input,
 * configuration, or storage, the read returns `Object.prototype` members instead of `undefined`,
 * and the caller treats a function as a found entry. Weft fixed that defect four times in a week
 * (`resolveAttributeDimensionKeys`, `hasWorkflow`, and two more) before this check existed.
 *
 * Run from a workspace directory, as each library's and component's `lint` does. The check loads
 * the workspace's `tsconfig.json` and flags every element access (`record[key]`) and every
 * membership test (`key in record`) in a non-test `src` file where the key is not a literal and
 * the receiver's type has a string index signature (`Record<string, T>`, `{ [key: string]: T }`,
 * `ProcessEnv`). A key typed as a union of literals is skipped, because the type already limits
 * it, and so are `Map`s, arrays, and typed arrays, which have no string index signature. A site
 * passes without a listing when any of these holds:
 *
 * - it is the target of a plain assignment or a `delete` (neither reads);
 * - the read is control-dependent on an own-property test of the same receiver and key
 *   (`Object.hasOwn`, a `hasOwnProperty(record, key)` helper, `Object.prototype.hasOwnProperty.call`,
 *   or `record.hasOwnProperty(key)`): it sits in the branch of an `if`, conditional, `&&` or `||`
 *   that the test decides, or it follows an `if` whose test, when false, proves ownership and whose
 *   body returns, throws, continues or breaks. A test whose result the read does not depend on
 *   (`void Object.hasOwn(record, key)`) does not count, and neither does an `in` test, which also
 *   answers for inherited keys;
 * - the key is a variable in the key position of an enumeration of the same receiver's own keys:
 *   the variable of `for (const key of Object.keys(record))`, the first element of a
 *   `[key, value]` pair from `Object.entries(record)`, or the first parameter of a callback over
 *   either, directly, through `filter`/`sort`/`toSorted`/`slice`/`reverse`, or through one local
 *   `const`. The value half of a pair, and anything a `map` produced, can be any string;
 * - the receiver is a local `const` created by `Object.create(null)`, which inherits nothing.
 *
 * Fix a finding by testing with `Object.hasOwn(record, key)` first, by holding the entries in a
 * `Map`, or by building the record with `Object.create(null)`. A site that is safe for a reason
 * the check cannot see (the key is a literal at every call site, a single character, or limited
 * by a regular expression) is listed in the workspace's `inherited-key-reads-allowlist.json` with
 * the reason. The list can only shrink on its own: an unlisted site fails, and so does an entry
 * that no longer matches a site, or that names more sites than remain. `--shrink` drops stale
 * entries and lowers counts. Adding an entry is a reviewed edit that needs a reason.
 *
 * The check judges declared types, so it does not see an `any` receiver, and it cannot read
 * `.svelte` files.
 */

import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

export const ALLOWLIST_FILE = 'inherited-key-reads-allowlist.json';
const ALLOWLIST_DESCRIPTION =
  'Dynamic reads allowed to use a key the code does not control, checked by scripts/check-inherited-key-reads.ts. Each entry names the file, the expression as written, how many such sites the file holds, and why no inherited key such as constructor can reach them. The list can only shrink: --shrink drops stale entries and lowers counts.';

const TEST_FILE =
  /(\.(test|spec|test-d|type-test|playwright|test-support)\.tsx?$)|(-test-[^/]*\.ts$)|(\.d\.ts$)/;
const TEST_DIRECTORY = /[\\/](test|tests|__tests__|__fixtures__|__test-helpers__)[\\/]/;

/** One flagged read: where it is and the receiver and key text the author wrote. */
export interface InheritedKeyRead {
  file: string;
  line: number;
  receiver: string;
  key: string;
  /** `read` for `receiver[key]`, `in` for `key in receiver`. */
  operator: 'read' | 'in';
}

function isLiteralKeyType(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.every(isLiteralKeyType);
  return (
    (type.flags &
      (ts.TypeFlags.StringLiteral |
        ts.TypeFlags.NumberLike |
        ts.TypeFlags.BigIntLike |
        ts.TypeFlags.ESSymbolLike |
        ts.TypeFlags.Never |
        ts.TypeFlags.EnumLike)) !==
    0
  );
}

function hasStringIndex(checker: ts.TypeChecker, type: ts.Type): boolean {
  const apparent = checker.getApparentType(checker.getNonNullableType(type));
  if (apparent.isUnion() || apparent.isIntersection()) {
    return apparent.types.some((member) => hasStringIndex(checker, member));
  }
  return checker
    .getIndexInfosOfType(apparent)
    .some((info) => (info.keyType.flags & ts.TypeFlags.StringLike) !== 0);
}

/** The expression without the casts, `!` and parentheses that change its type but not its value. */
function unwrap(node: ts.Node): ts.Node {
  let current = node;
  while (
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

const textOf = (node: ts.Node): string => unwrap(node).getText().replaceAll(/\s+/g, '');

/** Whether `call` is an own-property test of `receiver` and `key`, in any of the usual spellings. */
function isOwnPropertyTest(call: ts.CallExpression, receiver: string, key: string): boolean {
  const callee = textOf(call.expression);
  const [first, second] = call.arguments;
  const name = callee.slice(callee.lastIndexOf('.') + 1);
  if (!(callee.endsWith('hasOwnProperty.call') || name === 'hasOwn' || name === 'hasOwnProperty')) {
    return false;
  }
  // `Object.hasOwn(record, key)`, a `hasOwnProperty(record, key)` helper, and
  // `Object.prototype.hasOwnProperty.call(record, key)` take the record first.
  if (first && second) return textOf(first) === receiver && textOf(second) === key;
  // `record.hasOwnProperty(key)` takes only the key.
  return first !== undefined && callee === `${receiver}.hasOwnProperty` && textOf(first) === key;
}

/** Whether `expression` evaluating to `value` proves that the receiver owns the key. */
function impliesOwnership(
  expression: ts.Expression,
  value: boolean,
  receiver: string,
  key: string,
): boolean {
  const node = unwrap(expression);
  if (ts.isCallExpression(node)) return value && isOwnPropertyTest(node, receiver, key);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    return impliesOwnership(node.operand, !value, receiver, key);
  }
  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    // `a && b` is true only when both are, so either one proves it; `a || b` is false only when
    // both are false, so either one's falsity proves it. The other outcomes prove nothing.
    if (kind === ts.SyntaxKind.AmpersandAmpersandToken && value) {
      return (
        impliesOwnership(node.left, true, receiver, key) ||
        impliesOwnership(node.right, true, receiver, key)
      );
    }
    if (kind === ts.SyntaxKind.BarBarToken && !value) {
      return (
        impliesOwnership(node.left, false, receiver, key) ||
        impliesOwnership(node.right, false, receiver, key)
      );
    }
  }
  return false;
}

/** Whether a statement always leaves the block it sits in: `return`, `throw`, `continue`, `break`. */
function leavesBlock(statement: ts.Statement): boolean {
  if (
    ts.isReturnStatement(statement) ||
    ts.isThrowStatement(statement) ||
    ts.isContinueStatement(statement) ||
    ts.isBreakStatement(statement)
  ) {
    return true;
  }
  if (ts.isBlock(statement)) {
    const last = statement.statements.at(-1);
    return last !== undefined && leavesBlock(last);
  }
  return false;
}

/**
 * Whether the read is control-dependent on an own-property test of the same receiver and key: it
 * sits in the branch of an `if`, conditional, `&&` or `||` that the test decides, or it follows an
 * `if` whose test, when false, proves ownership and whose body leaves the block. A test whose
 * result the read does not depend on (`void Object.hasOwn(record, key)`) does not count.
 */
function isGuardedByOwnTest(node: ts.Node, receiver: string, key: string): boolean {
  for (
    let child: ts.Node = node, parent = node.parent;
    parent;
    child = parent, parent = parent.parent
  ) {
    if (ts.isIfStatement(parent)) {
      if (
        child === parent.thenStatement &&
        impliesOwnership(parent.expression, true, receiver, key)
      ) {
        return true;
      }
      if (
        child === parent.elseStatement &&
        impliesOwnership(parent.expression, false, receiver, key)
      ) {
        return true;
      }
    } else if (ts.isConditionalExpression(parent)) {
      if (child === parent.whenTrue && impliesOwnership(parent.condition, true, receiver, key)) {
        return true;
      }
      if (child === parent.whenFalse && impliesOwnership(parent.condition, false, receiver, key)) {
        return true;
      }
    } else if (ts.isBinaryExpression(parent) && child === parent.right) {
      const kind = parent.operatorToken.kind;
      if (
        (kind === ts.SyntaxKind.AmpersandAmpersandToken &&
          impliesOwnership(parent.left, true, receiver, key)) ||
        (kind === ts.SyntaxKind.BarBarToken && impliesOwnership(parent.left, false, receiver, key))
      ) {
        return true;
      }
    } else if (ts.isBlock(parent) || ts.isSourceFile(parent) || ts.isCaseClause(parent)) {
      const statements = parent.statements;
      const index = statements.indexOf(child as ts.Statement);
      for (const earlier of statements.slice(0, Math.max(index, 0))) {
        if (
          ts.isIfStatement(earlier) &&
          leavesBlock(earlier.thenStatement) &&
          impliesOwnership(earlier.expression, false, receiver, key)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/** How an enumeration lists the object: its keys alone, or `[key, value]` pairs. */
type ElementShape = 'keys' | 'entries';

/** Methods that hand on the elements of the array they are called on, unchanged. */
const SHAPE_PRESERVING_METHODS = new Set([
  'filter',
  'toSorted',
  'sort',
  'slice',
  'toReversed',
  'reverse',
]);

/**
 * What the elements of `expression` are when it enumerates the receiver's own keys: the keys, the
 * `[key, value]` pairs, or `undefined` when it is anything else. It follows `Object.keys`,
 * `Object.entries`, `Object.getOwnPropertyNames` and `Reflect.ownKeys` of the receiver, a spread of
 * one, a chain of order-or-membership methods, and one level of local `const`.
 */
function elementShapeOf(
  checker: ts.TypeChecker,
  expression: ts.Node,
  receiver: string,
): ElementShape | undefined {
  const node = unwrap(expression);
  if (ts.isArrayLiteralExpression(node) && node.elements.length === 1) {
    const only = node.elements[0]!;
    return ts.isSpreadElement(only)
      ? elementShapeOf(checker, only.expression, receiver)
      : undefined;
  }
  if (ts.isIdentifier(node)) {
    const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
    if (
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const
    ) {
      return elementShapeOf(checker, declaration.initializer, receiver);
    }
    return undefined;
  }
  if (!ts.isCallExpression(node)) return undefined;
  const callee = unwrap(node.expression);
  if (ts.isPropertyAccessExpression(callee) && SHAPE_PRESERVING_METHODS.has(callee.name.text)) {
    return elementShapeOf(checker, callee.expression, receiver);
  }
  const argument = node.arguments[0];
  if (node.arguments.length !== 1 || !argument || textOf(argument) !== receiver) return undefined;
  const name = textOf(callee);
  if (['Object.keys', 'Object.getOwnPropertyNames', 'Reflect.ownKeys'].includes(name))
    return 'keys';
  return name === 'Object.entries' ? 'entries' : undefined;
}

/**
 * Whether `key` is a binding that holds an own key of the receiver. Only the key position counts:
 * the variable of a loop over `Object.keys(record)`, the first element of a `[key, value]` pair
 * from `Object.entries(record)`, or the first parameter of a callback over either. The value half
 * of a pair, and an index or array parameter, can be anything.
 */
function isOwnKeyIteration(checker: ts.TypeChecker, key: ts.Expression, receiver: string): boolean {
  const identifier = unwrap(key);
  if (!ts.isIdentifier(identifier)) return false;
  const declaration = checker.getSymbolAtLocation(identifier)?.valueDeclaration;
  if (!declaration) return false;
  // `for (const key in record)` lists the record's enumerable keys.
  if (ts.isVariableDeclaration(declaration)) {
    const list = declaration.parent;
    const loop = ts.isVariableDeclarationList(list) ? list.parent : undefined;
    if (loop && ts.isForInStatement(loop)) return textOf(loop.expression) === receiver;
  }
  // The key position: a plain binding, or element 0 of an array pattern.
  let position: ts.Node = declaration;
  let pair = false;
  if (ts.isBindingElement(declaration)) {
    const pattern = declaration.parent;
    if (!ts.isArrayBindingPattern(pattern) || pattern.elements[0] !== declaration) return false;
    position = pattern.parent;
    pair = true;
  }
  const expected: ElementShape = pair ? 'entries' : 'keys';
  // A loop variable over the enumeration.
  if (ts.isVariableDeclaration(position)) {
    const list = position.parent;
    const loop = ts.isVariableDeclarationList(list) ? list.parent : undefined;
    return (
      loop !== undefined &&
      ts.isForOfStatement(loop) &&
      elementShapeOf(checker, loop.expression, receiver) === expected
    );
  }
  // The first parameter of a callback passed to a method of the enumeration.
  if (ts.isParameter(position)) {
    const callback = position.parent;
    const call = callback.parent;
    if (
      !ts.isFunctionLike(callback) ||
      callback.parameters[0] !== position ||
      !ts.isCallExpression(call) ||
      !call.arguments.includes(callback as ts.Expression)
    ) {
      return false;
    }
    const method = unwrap(call.expression);
    return (
      ts.isPropertyAccessExpression(method) &&
      elementShapeOf(checker, method.expression, receiver) === expected
    );
  }
  return false;
}

/** The receiver and key of an element access or `in` test, and the node to report. */
interface KeyedSite {
  node: ts.Node;
  receiver: ts.Expression;
  key: ts.Expression;
}

function siteOf(node: ts.Node): KeyedSite | undefined {
  if (ts.isElementAccessExpression(node)) {
    const parent = node.parent;
    const isWrite =
      (ts.isBinaryExpression(parent) &&
        parent.left === node &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) ||
      ts.isDeleteExpression(parent);
    return isWrite ? undefined : { node, receiver: node.expression, key: node.argumentExpression };
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
    !ts.isPrivateIdentifier(node.left)
  ) {
    return { node, receiver: node.right, key: node.left };
  }
  return undefined;
}

/** Whether the receiver is a local `const` created by `Object.create(null)`, so it inherits nothing. */
function isNullPrototypeLocal(checker: ts.TypeChecker, receiver: ts.Expression): boolean {
  if (!ts.isIdentifier(receiver)) return false;
  const declaration = checker.getSymbolAtLocation(receiver)?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) {
    return false;
  }
  if (!(ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const)) return false;
  let initializer: ts.Expression = declaration.initializer;
  while (
    ts.isAsExpression(initializer) ||
    ts.isParenthesizedExpression(initializer) ||
    ts.isSatisfiesExpression(initializer) ||
    ts.isTypeAssertionExpression(initializer)
  ) {
    initializer = initializer.expression;
  }
  return (
    ts.isCallExpression(initializer) &&
    textOf(initializer.expression) === 'Object.create' &&
    initializer.arguments.length === 1 &&
    initializer.arguments[0]?.kind === ts.SyntaxKind.NullKeyword
  );
}

/** Lists every unguarded dynamic read on a string-indexed receiver in the program's own `src`. */
export function findInheritedKeyReads(program: ts.Program, directory: string): InheritedKeyRead[] {
  const checker = program.getTypeChecker();
  const source = join(resolve(directory), 'src') + sep;
  const reads: InheritedKeyRead[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    const fileName = resolve(sourceFile.fileName);
    if (
      !fileName.startsWith(source) ||
      TEST_FILE.test(fileName) ||
      TEST_DIRECTORY.test(fileName.slice(source.length - 1))
    ) {
      continue;
    }
    const inspect = (site: KeyedSite): void => {
      const { node, receiver, key } = site;
      if (
        ts.isStringLiteralLike(key) ||
        ts.isNumericLiteral(key) ||
        isLiteralKeyType(checker.getTypeAtLocation(key)) ||
        !hasStringIndex(checker, checker.getTypeAtLocation(receiver)) ||
        isNullPrototypeLocal(checker, receiver)
      ) {
        return;
      }
      const receiverText = textOf(receiver);
      const keyText = textOf(key);
      if (
        isGuardedByOwnTest(node, receiverText, keyText) ||
        isOwnKeyIteration(checker, key, receiverText)
      ) {
        return;
      }
      reads.push({
        file: relative(directory, fileName),
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        receiver: receiver.getText(sourceFile),
        key: key.getText(sourceFile),
        operator: ts.isElementAccessExpression(node) ? 'read' : 'in',
      });
    };
    const visit = (node: ts.Node): void => {
      const site = siteOf(node);
      if (site) inspect(site);
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return reads.toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** The expression as the author wrote it, which is what an allowlist entry names. */
export function expressionOf(read: InheritedKeyRead): string {
  return read.operator === 'in'
    ? `${read.key} in ${read.receiver}`
    : `${read.receiver}[${read.key}]`;
}

/** One allowlist entry: `count` sites in `file` read `expression`, and `reason` says why that is safe. */
export interface AllowlistEntry {
  file: string;
  expression: string;
  count: number;
  reason: string;
}

export interface AllowlistJudgement {
  /** Sites beyond what the allowlist names, with the lines they sit on. */
  unlisted: { file: string; expression: string; found: number; allowed: number; lines: number[] }[];
  /** Entries that name sites which are gone, or more sites than remain. */
  stale: { file: string; expression: string; found: number; allowed: number }[];
  /** Entries with no usable reason or count. */
  invalid: AllowlistEntry[];
}

/** Compares the sites found with the allowlist, group by group (same file and expression). */
export function judgeReads(
  reads: readonly InheritedKeyRead[],
  allowlist: readonly AllowlistEntry[],
): AllowlistJudgement {
  const groups = new Map<string, { file: string; expression: string; lines: number[] }>();
  for (const read of reads) {
    const expression = expressionOf(read);
    const id = `${read.file}\u0000${expression}`;
    const group = groups.get(id) ?? { file: read.file, expression, lines: [] };
    group.lines.push(read.line);
    groups.set(id, group);
  }
  const allowed = new Map<string, AllowlistEntry>(
    allowlist.map((entry) => [`${entry.file}\u0000${entry.expression}`, entry]),
  );
  const unlisted: AllowlistJudgement['unlisted'] = [];
  for (const [id, group] of groups) {
    const permitted = allowed.get(id)?.count ?? 0;
    if (group.lines.length > permitted) {
      unlisted.push({ ...group, found: group.lines.length, allowed: permitted });
    }
  }
  const stale: AllowlistJudgement['stale'] = [];
  for (const [id, entry] of allowed) {
    const found = groups.get(id)?.lines.length ?? 0;
    if (found < entry.count) {
      stale.push({ file: entry.file, expression: entry.expression, found, allowed: entry.count });
    }
  }
  const invalid = allowlist.filter(
    (entry) => entry.reason.trim() === '' || !Number.isInteger(entry.count) || entry.count < 1,
  );
  return { unlisted, stale, invalid };
}

function readConfiguration(directory: string): ts.ParsedCommandLine {
  const path = join(directory, 'tsconfig.json');
  const loaded = ts.readConfigFile(path, (file) => ts.sys.readFile(file));
  if (loaded.error) {
    throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
  }
  return ts.parseJsonConfigFileContent(loaded.config, ts.sys, directory);
}

async function readAllowlist(path: string): Promise<AllowlistEntry[]> {
  if (!existsSync(path)) return [];
  const contents: { entries?: AllowlistEntry[] } = await Bun.file(path).json();
  return contents.entries ?? [];
}

async function writeAllowlist(path: string, entries: readonly AllowlistEntry[]): Promise<void> {
  const sorted = entries.toSorted(
    (a, b) => a.file.localeCompare(b.file) || a.expression.localeCompare(b.expression),
  );
  await Bun.write(
    path,
    `${JSON.stringify({ description: ALLOWLIST_DESCRIPTION, entries: sorted }, null, 2)}\n`,
  );
}

async function main(argv: readonly string[]): Promise<number> {
  const mode = argv[0];
  if (mode !== undefined && mode !== '--shrink' && mode !== '--report') {
    process.stderr.write(`check-inherited-key-reads — unknown argument ${mode}\n`);
    return 2;
  }
  const directory = process.cwd();
  const name = relative(join(import.meta.dir, '..'), directory);
  const configuration = readConfiguration(directory);
  const program = ts.createProgram(configuration.fileNames, {
    ...configuration.options,
    noEmit: true,
  });
  const reads = findInheritedKeyReads(program, directory);
  if (mode === '--report') {
    process.stdout.write(`${JSON.stringify(reads, null, 2)}\n`);
    return 0;
  }
  const allowlistPath = join(directory, ALLOWLIST_FILE);
  const allowlist = await readAllowlist(allowlistPath);
  const { unlisted, stale, invalid } = judgeReads(reads, allowlist);

  if (mode === '--shrink') {
    const found = new Map<string, number>();
    for (const read of reads) {
      const id = `${read.file}\u0000${expressionOf(read)}`;
      found.set(id, (found.get(id) ?? 0) + 1);
    }
    const kept = allowlist
      .map((entry) => ({
        ...entry,
        count: Math.min(entry.count, found.get(`${entry.file}\u0000${entry.expression}`) ?? 0),
      }))
      .filter((entry) => entry.count > 0);
    if (allowlist.length > 0 || kept.length > 0) await writeAllowlist(allowlistPath, kept);
    process.stdout.write(
      `check-inherited-key-reads — ${name}: dropped ${stale.length} stale entries.\n`,
    );
    return unlisted.length > 0 || invalid.length > 0 ? 1 : 0;
  }

  if (unlisted.length === 0 && stale.length === 0 && invalid.length === 0) {
    process.stdout.write(
      `check-inherited-key-reads — ${name}: OK (${allowlist.length} allowlisted).\n`,
    );
    return 0;
  }
  const lines = [
    ...unlisted.map(
      (item) =>
        `${item.file}:${item.lines.join(',')}  ${item.expression}  (${item.found} found, ${item.allowed} allowlisted)`,
    ),
    ...stale.map(
      (item) =>
        `stale allowlist entry: ${item.file}  ${item.expression}  (${item.found} found, ${item.allowed} allowlisted)`,
    ),
    ...invalid.map(
      (entry) =>
        `allowlist entry needs a reason and a count of 1 or more: ${entry.file}  ${entry.expression}`,
    ),
  ];
  process.stderr.write(
    `check-inherited-key-reads — ${name}:\n${lines.map((line) => `  ${line}`).join('\n')}\n\n` +
      'A key outside the code\'s control (input, configuration, storage) can be "constructor" or ' +
      '"__proto__", and a plain object answers for it. Read with Object.hasOwn(record, key) ' +
      'first, hold the entries in a Map, or build the record with Object.create(null). ' +
      `A site that is safe for a reason the check cannot see goes in ${ALLOWLIST_FILE} with that ` +
      'reason. Remove stale entries with: bun ../../scripts/check-inherited-key-reads.ts --shrink\n',
  );
  return 1;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
