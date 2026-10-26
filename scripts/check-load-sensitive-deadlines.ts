/**
 * Guard against deadlines in blocking tests that a loaded host can overrun.
 *
 * A test deadline is a bet that the work finishes within some number of milliseconds. On a host
 * running several agents at once the bet loses at random, and the loser changes from run to run:
 * the element does arrive, the child does exit, the event does fire, only later than the clock
 * allowed, and the test passes when run alone. Owner decision: tests that can flake under load
 * cannot be in the critical path. Everything `bun run check` and `bun run validate` run therefore
 * has exactly one deadline, the awake-time hang guard (`HANG_GUARD_MILLISECONDS`), and it is never
 * a performance bound (see `scripts/test-deadlines.ts`). This guard fails when a blocking test
 * names a shorter one. The rules, all syntactic and file-local:
 *
 *   - `bun-test-timeout`: a per-test or per-hook timeout below the hang guard, as a numeric
 *     argument or a `{ timeout }` option of `test`, `it`, `describe` or a hook (with any modifier,
 *     `.each` included), or a `setDefaultTimeout` / `jest.setTimeout` call. Bun's own default is
 *     raised by `--timeout` on every invocation, so an override can only lower it.
 *   - `testing-library-timeout`: a `timeout` option on `findBy*`, `findAllBy*`, `waitFor` or
 *     `waitForElementToBeRemoved`, or a `configure({ asyncUtilTimeout })` below the hang guard.
 *     Their default is raised by `configureAsyncUtilityDeadline` in every UI preload.
 *   - `wait-budget`: a `timeout`, `timeoutMs`, `timeoutMilliseconds` or `hangGuardMilliseconds`
 *     property greater than zero and below the hang guard, passed to a call that waits for
 *     something that should eventually happen (`waitFor*`, `readFrames`, `nextServerMessage`, a
 *     hang-guarded spawn, and the others in `WAITING_CALLEES`), and `afterAwakeTime` with a
 *     duration below the hang guard. A product's own timeout option (`mailbox.awaitCleanup`,
 *     `outbox.drain`, `server.shutdownWorker`) is not read: tests of those drive an injected clock
 *     or a stalled dependency, which no load can speed up.
 *
 * A budget is read through numeric literals, `+ - * /`, parentheses, the hang-guard constants, and
 * a `const` declared in the file. A budget the guard cannot resolve is not a `wait-budget`
 * finding, but it is a `bun-test-timeout` or `testing-library-timeout` one, because those two
 * rules have no legitimate short value to protect.
 *
 * The one exemption is for a test of the hang guard itself, which must name a short guard to prove
 * it fires: a `// hang-guard-self-test: <reason>` comment of at least twenty characters directly
 * above the statement, covering only `spawnWithHangGuard`, `runWithHangGuard` and `afterAwakeTime`
 * inside that statement. It never covers a Bun test timeout or a Testing Library wait, and it does
 * not carry to the next statement. No load can make a child that never exits exit, so a short guard
 * on one cannot flake.
 *
 * Two further checks keep the deadline in place. `findPackageScriptViolations` rejects a
 * `package.json` script that starts `bun test` directly: the wrapper `scripts/bun-test.ts` (or
 * `scripts/bun-test-junit.ts`) passes `--timeout`, which is the only dependable way to raise Bun's
 * five-second default (`bunfig.toml` ignores `[test] timeout`, and `setDefaultTimeout` in a preload
 * covers the first file only). `findTestRunnerSpawnViolations` rejects a script that spawns
 * `bun test` without `TEST_TIMEOUT_ARGUMENT`.
 *
 * Blind spots, documented rather than claimed as covered. The guard cannot see:
 *
 *   - a short deadline in a product option under test (`createThing({ timeoutMs: 50 })`), because
 *     a product timeout that is expected to expire is deterministic and one that is expected to be
 *     met is not, and syntax cannot tell them apart; only the waiting callees above are read;
 *   - a budget inside a helper in another file, or an unresolvable identifier, for `wait-budget`;
 *   - a deadline that is not a `timeout` property: a loop with a fixed iteration cap, a
 *     `Promise.race` against a timer, a sleep used as synchronization (the rules below this list
 *     in the file cover the lexically visible forms), and the order in which independent events
 *     happen to arrive;
 *   - Playwright's own timeouts, which the browser lanes configure in their configuration files.
 *
 * `*.bench.ts` files and `.test.ts` files under a `scripts/benchmarks/` directory are outside the
 * default gate and outside the scan, as they are for `check-wall-clock-assertions.ts`.
 */

import { readdirSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import ts from 'typescript';
import { HANG_GUARD_MILLISECONDS } from './hang-guard.ts';
import { TEST_TIMEOUT_MILLISECONDS } from './test-deadlines.ts';
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
  // Playwright end-to-end suites run through `test:browser`, outside `check` and `validate`.
  'e2e',
]);

export type DeadlineRule =
  'bun-test-timeout' | 'testing-library-timeout' | 'wait-budget' | 'iteration-cap-wait';
export type DeadlineViolation = {
  rule: DeadlineRule;
  line: number;
  text: string;
  /** The name of the call the finding is on, when it has one. */
  callee?: string;
  /** The span of source that deletes the offending budget, for the one-time sweep that removed them. */
  removal?: { start: number; end: number };
};

const REGISTRATION_ROOTS = new Set([
  'test',
  'it',
  'describe',
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll',
]);
// Calls that configure a table or a condition for the registration that follows, not a test.
const TABLE_CALLEES = new Set(['each', 'skipIf', 'todoIf', 'if', 'failing']);
const TESTING_LIBRARY_WAIT = /^(findBy\w+|findAllBy\w+|waitFor|waitForElementToBeRemoved)$/;
const BUDGET_PROPERTIES = new Set([
  'timeout',
  'timeoutMs',
  'timeoutMilliseconds',
  'hangGuardMilliseconds',
]);
/** Calls whose budget is a wait for something that should eventually happen. */
const WAITING_CALLEES =
  /^(waitUntil|awakeTurns|waitFor\w*|poll\w*|eventually|\w+Until|readFrames|nextServerMessage|resolveWithin|launch|spawnWithHangGuard|runWithHangGuard|executeCodegen|executeConformance|createConformanceTargetRunner|runnerFor)$/;
// The hang guards, and the wait helpers whose own tests prove they give up. These are the only calls
// a `hang-guard-self-test` comment can exempt; a fake-timer scope never does.
const HANG_GUARD_CALLEES = new Set([
  'spawnWithHangGuard',
  'runWithHangGuard',
  'afterAwakeTime',
  'waitForCondition',
  'waitForParityCondition',
  'waitForWorkflowStatus',
  'waitForRunState',
  'waitUntil',
  'awakeTurns',
]);
// Hang guards on real work: a child process or an awake-time deadline, whatever the clock says.
const REAL_TIME_CALLEES = new Set(['spawnWithHangGuard', 'runWithHangGuard', 'afterAwakeTime']);
const HANG_GUARD_NAMES = new Map([
  ['HANG_GUARD_MILLISECONDS', HANG_GUARD_MILLISECONDS],
  ['TEST_TIMEOUT_MILLISECONDS', TEST_TIMEOUT_MILLISECONDS],
]);
const SELF_TEST_MARKER = /\/\/\s*hang-guard-self-test:\s*(.*)$/m;
const LOAD_PROOF_MARKER = /\/\/\s*load-proof:\s*(.*)$/m;
const MINIMUM_SELF_TEST_REASON = 20;

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

/** Every `const` initializer in the file by name, scoping ignored, like the other guards. */
function collectConstants(sourceFile: ts.SourceFile): Map<string, ts.Expression> {
  const constants = new Map<string, ts.Expression>();
  walk(sourceFile, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      constants.set(node.name.text, node.initializer);
    }
  });
  return constants;
}

/** The numeric value of `expression`, or `null` when it is not statically known. */
export function resolveNumber(
  expression: ts.Expression,
  constants: ReadonlyMap<string, ts.Expression>,
  seen: ReadonlySet<string> = new Set(),
): number | null {
  const unwrapped = unwrap(expression);
  if (ts.isNumericLiteral(unwrapped)) return Number(unwrapped.text.replaceAll('_', ''));
  if (ts.isIdentifier(unwrapped)) {
    const known = HANG_GUARD_NAMES.get(unwrapped.text);
    if (known !== undefined) return known;
    if (unwrapped.text === 'Infinity') return Infinity;
    const initializer = constants.get(unwrapped.text);
    if (initializer === undefined || seen.has(unwrapped.text)) return null;
    return resolveNumber(initializer, constants, new Set([...seen, unwrapped.text]));
  }
  if (
    ts.isPropertyAccessExpression(unwrapped) &&
    unwrapped.getText() === 'Number.POSITIVE_INFINITY'
  ) {
    return Infinity;
  }
  if (ts.isPrefixUnaryExpression(unwrapped)) {
    const operand = resolveNumber(unwrapped.operand, constants, seen);
    if (operand === null) return null;
    if (unwrapped.operator === ts.SyntaxKind.MinusToken) return -operand;
    if (unwrapped.operator === ts.SyntaxKind.PlusToken) return operand;
    return null;
  }
  if (!ts.isBinaryExpression(unwrapped)) return null;
  const left = resolveNumber(unwrapped.left, constants, seen);
  const right = resolveNumber(unwrapped.right, constants, seen);
  if (left === null || right === null) return null;
  switch (unwrapped.operatorToken.kind) {
    case ts.SyntaxKind.PlusToken:
      return left + right;
    case ts.SyntaxKind.MinusToken:
      return left - right;
    case ts.SyntaxKind.AsteriskToken:
      return left * right;
    case ts.SyntaxKind.SlashToken:
      return left / right;
    default:
      return null;
  }
}

/** The name a call ends in (`screen.findByRole` is `findByRole`), or `null` for a computed callee. */
function calleeName(call: ts.CallExpression): string | null {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/** The identifier a callee chain starts from: `test` in `test.each(rows)('a', fn)`. */
function chainRoot(expression: ts.Expression): ts.Expression {
  let current = unwrap(expression);
  while (ts.isCallExpression(current) || ts.isPropertyAccessExpression(current)) {
    current = unwrap(current.expression);
  }
  return current;
}

/**
 * Whether a call registers a test, a suite or a hook: `test('a', fn)` and
 * `test.each(rows)('a', fn)` do, while `test.each(rows)` alone only prepares the table.
 */
function isRegistration(call: ts.CallExpression): boolean {
  const root = chainRoot(call.expression);
  if (!ts.isIdentifier(root) || !REGISTRATION_ROOTS.has(root.text)) return false;
  const name = calleeName(call);
  return name === null || !TABLE_CALLEES.has(name);
}

function propertyNamed(
  object: ts.ObjectLiteralExpression,
  names: ReadonlySet<string>,
): ts.PropertyAssignment | undefined {
  return object.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      names.has(property.name.text),
  );
}

/**
 * The self-test reason written directly above `node` or above any statement or expression that
 * holds it, up to its enclosing statement: `// hang-guard-self-test: ...` before the call, or before
 * the `expect(...)` statement around it.
 */
function selfTestReason(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  marker: RegExp = SELF_TEST_MARKER,
): string | null {
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    const comments = ts.getLeadingCommentRanges(sourceFile.text, current.getFullStart()) ?? [];
    for (const comment of comments.toReversed()) {
      const match = marker.exec(sourceFile.text.slice(comment.pos, comment.end));
      if (match !== null) return (match[1] ?? '').trim();
    }
    if (ts.isStatement(current) || ts.isSourceFile(current)) break;
  }
  return null;
}

/**
 * Whether a loop carries `// load-proof: <reason>` directly above it. A loop that waits for
 * something that must not happen (a descriptor that is held, an event that is suppressed) can be
 * bounded by turns or time without flaking, because a loaded host only makes the thing later, never
 * earlier: its pass is load-proof, and no hang guard can end a wait on an event that never comes.
 * The reason must be at least twenty characters and name what cannot happen.
 */
function isLoadProof(sourceFile: ts.SourceFile, node: ts.Node): boolean {
  const reason = selfTestReason(sourceFile, node, LOAD_PROOF_MARKER);
  return reason !== null && reason.length >= MINIMUM_SELF_TEST_REASON;
}

function violation(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  rule: DeadlineRule,
  removal?: { start: number; end: number },
): DeadlineViolation {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const text = node.getText(sourceFile).split('\n')[0] ?? '';
  const callee = ts.isCallExpression(node) ? calleeName(node) : null;
  return {
    rule,
    line: line + 1,
    text,
    ...(callee === null ? {} : { callee }),
    ...(removal === undefined ? {} : { removal }),
  };
}

/** The span that deletes `member` from `siblings`, with the comma that joins it to its neighbour. */
function removalOf(
  sourceFile: ts.SourceFile,
  siblings: ts.NodeArray<ts.Node>,
  member: ts.Node,
): { start: number; end: number } {
  const index = siblings.indexOf(member);
  const previous = siblings[index - 1];
  if (previous !== undefined) return { start: previous.getEnd(), end: member.getEnd() };
  const next = siblings[index + 1];
  if (next !== undefined)
    return { start: member.getStart(sourceFile), end: next.getStart(sourceFile) };
  return { start: member.getFullStart(), end: member.getEnd() };
}

/**
 * The span that deletes a `timeout`-style `property` of an options `object` passed as `argument`
 * of `call`: the whole argument when the property is all there is, the property alone otherwise.
 */
function removalOfOption(
  sourceFile: ts.SourceFile,
  call: ts.CallExpression,
  argument: ts.Expression,
  object: ts.ObjectLiteralExpression,
  property: ts.PropertyAssignment,
): { start: number; end: number } {
  return object.properties.length === 1
    ? removalOf(sourceFile, call.arguments, argument)
    : removalOf(sourceFile, object.properties, property);
}

/** Whether `value` is, or cannot be shown not to be, a deadline below the hang guard. */
function isShort(
  value: ts.Expression,
  constants: ReadonlyMap<string, ts.Expression>,
  options: { unresolvedIsShort: boolean; allowZero: boolean },
): boolean {
  const resolved = resolveNumber(value, constants);
  if (resolved === null) return options.unresolvedIsShort;
  if (options.allowZero && resolved <= 0) return false;
  return resolved < HANG_GUARD_MILLISECONDS;
}

// Calls that put a test on a clock it advances itself: Bun's fake timers, and the manual runtime
// services and manual clocks the workspaces own. Under any of them a duration is virtual time.
const MANUAL_CLOCK_CALLEES = new Set([
  'useFakeTimers',
  'createManualRuntimeServices',
  'createManualClock',
  'createManualDurableEngine',
]);

/** Whether `node` installs a manual clock: `useFakeTimers()`, `createManualRuntimeServices()`, `new ManualClock()`. */
function callsUseFakeTimers(node: ts.Node): boolean {
  let found = false;
  walk(node, (child) => {
    if (ts.isCallExpression(child)) {
      const name = calleeName(child);
      if (name !== null && MANUAL_CLOCK_CALLEES.has(name)) found = true;
    } else if (ts.isNewExpression(child) && /ManualClock$/.test(child.expression.getText())) {
      found = true;
    }
  });
  return found;
}

/** Whether a hook argument installs fake timers: `beforeEach(useFakeTimers)` or a body that calls it. */
function hookInstallsFakeTimers(call: ts.CallExpression): boolean {
  return call.arguments.some(
    (argument) =>
      (ts.isIdentifier(argument) && MANUAL_CLOCK_CALLEES.has(argument.text)) ||
      ((ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) &&
        callsUseFakeTimers(argument)),
  );
}

/**
 * Whether `node` runs under Bun's fake timers, so a duration it names is virtual time that a load
 * cannot stretch: its test or hook body calls `useFakeTimers`, or a suite around it installs them
 * in a `beforeEach`/`beforeAll`. A budget handed to a wait is read as real time everywhere else.
 */
function isUnderFakeTimers(node: ts.Node): boolean {
  for (
    let current: ts.Node | undefined = node.parent;
    current !== undefined;
    current = current.parent
  ) {
    if (!ts.isFunctionLike(current) || !ts.isCallExpression(current.parent)) continue;
    const call = current.parent;
    if (!isRegistration(call)) continue;
    const root = chainRoot(call.expression);
    const isSuite = ts.isIdentifier(root) && root.text === 'describe';
    if (!isSuite && callsUseFakeTimers(current)) return true;
    if (isSuite && ts.isBlock((current as ts.FunctionLikeDeclaration).body ?? current)) {
      const body = (current as ts.FunctionLikeDeclaration).body as ts.Block;
      for (const statement of body.statements) {
        if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression))
          continue;
        const hook = statement.expression;
        const hookRoot = chainRoot(hook.expression);
        if (
          ts.isIdentifier(hookRoot) &&
          (hookRoot.text === 'beforeEach' || hookRoot.text === 'beforeAll') &&
          hookInstallsFakeTimers(hook)
        ) {
          return true;
        }
      }
    }
  }
  // A hook at the top of the file covers every test in it.
  for (const statement of node.getSourceFile().statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression))
      continue;
    const hookRoot = chainRoot(statement.expression.expression);
    if (
      ts.isIdentifier(hookRoot) &&
      (hookRoot.text === 'beforeEach' || hookRoot.text === 'beforeAll') &&
      hookInstallsFakeTimers(statement.expression)
    ) {
      return true;
    }
  }
  return false;
}

export function findDeadlineViolations(sourceFile: ts.SourceFile): DeadlineViolation[] {
  const violations: DeadlineViolation[] = [];
  const constants = collectConstants(sourceFile);

  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const name = calleeName(node);

    // Bun's per-test and per-hook timeouts.
    if (name === 'setDefaultTimeout' || unwrap(node.expression).getText() === 'jest.setTimeout') {
      const [budget] = node.arguments;
      if (
        budget !== undefined &&
        isShort(budget, constants, { unresolvedIsShort: true, allowZero: false })
      ) {
        violations.push(violation(sourceFile, node, 'bun-test-timeout'));
      }
      return;
    }
    if (isRegistration(node)) {
      for (const argument of node.arguments.slice(1)) {
        const unwrapped = unwrap(argument);
        const option = ts.isObjectLiteralExpression(unwrapped)
          ? propertyNamed(unwrapped, new Set(['timeout']))
          : undefined;
        const budget = ts.isObjectLiteralExpression(unwrapped)
          ? option?.initializer
          : ts.isFunctionLike(unwrapped) || ts.isStringLiteralLike(unwrapped)
            ? undefined
            : argument;
        if (
          budget !== undefined &&
          isNumberLike(budget) &&
          isShort(budget, constants, { unresolvedIsShort: true, allowZero: false })
        ) {
          const removal =
            ts.isObjectLiteralExpression(unwrapped) && option !== undefined
              ? removalOfOption(sourceFile, node, argument, unwrapped, option)
              : removalOf(sourceFile, node.arguments, argument);
          violations.push(violation(sourceFile, node, 'bun-test-timeout', removal));
          break;
        }
      }
      return;
    }

    // A callee with no name (a computed or parenthesised call) is none of what follows.
    if (name === null) return;

    // Testing Library's asynchronous utilities.
    if (TESTING_LIBRARY_WAIT.test(name)) {
      for (const argument of node.arguments) {
        const unwrapped = unwrap(argument);
        if (!ts.isObjectLiteralExpression(unwrapped)) continue;
        const option = propertyNamed(unwrapped, new Set(['timeout']));
        if (
          option !== undefined &&
          isShort(option.initializer, constants, { unresolvedIsShort: true, allowZero: false })
        ) {
          violations.push(
            violation(
              sourceFile,
              node,
              'testing-library-timeout',
              removalOfOption(sourceFile, node, argument, unwrapped, option),
            ),
          );
          break;
        }
      }
      return;
    }
    if (name === 'configure') {
      for (const argument of node.arguments) {
        const unwrapped = unwrap(argument);
        if (!ts.isObjectLiteralExpression(unwrapped)) continue;
        const budget = propertyNamed(unwrapped, new Set(['asyncUtilTimeout']))?.initializer;
        if (
          budget !== undefined &&
          isShort(budget, constants, { unresolvedIsShort: true, allowZero: false })
        ) {
          violations.push(violation(sourceFile, node, 'testing-library-timeout'));
        }
      }
      return;
    }

    // Waits for something that should eventually happen, and the hang guards themselves.
    const exempt = (): boolean => {
      // A wait for something that must not happen, whatever the callee.
      if (isLoadProof(sourceFile, node)) return true;
      if (!HANG_GUARD_CALLEES.has(name)) return false;
      const reason = selfTestReason(sourceFile, node);
      return reason !== null && reason.length >= MINIMUM_SELF_TEST_REASON;
    };
    if (name === 'afterAwakeTime') {
      const [budget] = node.arguments;
      if (
        budget !== undefined &&
        isShort(budget, constants, { unresolvedIsShort: false, allowZero: true }) &&
        !exempt()
      ) {
        violations.push(violation(sourceFile, node, 'wait-budget'));
      }
      return;
    }
    // A hang-guarded child is real work whatever the clock; any other wait is virtual under fakes.
    if (!WAITING_CALLEES.test(name)) return;
    if (!REAL_TIME_CALLEES.has(name) && isUnderFakeTimers(node)) return;
    for (const argument of node.arguments) {
      const unwrapped = unwrap(argument);
      if (!ts.isObjectLiteralExpression(unwrapped)) continue;
      const option = propertyNamed(unwrapped, BUDGET_PROPERTIES);
      if (
        option !== undefined &&
        isShort(option.initializer, constants, { unresolvedIsShort: false, allowZero: true }) &&
        !exempt()
      ) {
        violations.push(
          violation(
            sourceFile,
            node,
            'wait-budget',
            removalOfOption(sourceFile, node, argument, unwrapped, option),
          ),
        );
        break;
      }
    }
  });

  return [
    ...violations,
    ...findIterationCapWaits(sourceFile, constants),
    ...findWallClockPolls(sourceFile),
    ...findDefaultedBudgets(sourceFile, constants),
    ...findSleepSynchronization(sourceFile, constants),
    ...findTimerRejections(sourceFile, constants),
    ...findTimerRaces(sourceFile, constants),
  ];
}

// Yields that hand control to the event loop, so something outside the promise chain (a timer, a
// socket, a child process, another thread) can make progress before the loop looks again. How many
// such turns a settle takes depends on the host. A pure microtask yield (`await Promise.resolve()`,
// Svelte's `tick`, a `flushMicrotasks`) is not here: microtasks drain before anything else runs, so
// the number a promise chain needs is a property of the code, not of the load.
const YIELDING_CALLEE =
  /(sleep|delay|setTimeout|setImmediate|macrotask|eventLoop|timerTurn|waitOneTurn|nextTimer|advanceTimers)/i;

/** Whether an `await` operand hands control back without finishing the work being waited for. */
function isYield(expression: ts.Expression): boolean {
  const operand = unwrap(expression);
  if (ts.isNewExpression(operand)) {
    // `await new Promise((resolve) => setTimeout(resolve, 5))` is a timer turn.
    return (
      operand.expression.getText() === 'Promise' &&
      /setTimeout|setImmediate|MessageChannel/.test(operand.getText())
    );
  }
  if (!ts.isCallExpression(operand)) return false;
  const name = calleeName(operand);
  return name !== null && YIELDING_CALLEE.test(name);
}

function containsYieldingAwait(node: ts.Node): boolean {
  let found = false;
  walk(node, (child) => {
    if (ts.isAwaitExpression(child) && isYield(child.expression)) found = true;
  });
  return found;
}

/** Whether `node` (without entering nested functions) leaves the loop early from inside an `if`. */
function hasConditionalExit(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (ts.isFunctionLike(child)) return;
    if (
      ts.isIfStatement(child) &&
      (ts.isReturnStatement(child.thenStatement) ||
        ts.isBreakStatement(child.thenStatement) ||
        (ts.isBlock(child.thenStatement) &&
          child.thenStatement.statements.some(
            (statement) => ts.isReturnStatement(statement) || ts.isBreakStatement(statement),
          )))
    ) {
      found = true;
    }
    child.forEachChild(visit);
  };
  node.forEachChild(visit);
  return found;
}

const CAP_NAME =
  /^(max(imum)?|limit|attempts?|iterations?|turns?|ticks?|yields?|retries|rounds?)([A-Z_]\w*)?$/i;

const RELATIONAL = new Set([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

/** Whether `expression` holds a relational comparison against a number that is two or more. */
function capsAtNumber(
  expression: ts.Expression,
  constants: ReadonlyMap<string, ts.Expression>,
): boolean {
  let found = false;
  walk(expression, (node) => {
    if (!ts.isBinaryExpression(node) || !RELATIONAL.has(node.operatorToken.kind)) return;
    for (const side of [node.left, node.right]) {
      if (ts.isPrefixUnaryExpression(unwrap(side)) || ts.isPostfixUnaryExpression(unwrap(side))) {
        continue;
      }
      const value = resolveNumber(side, constants);
      if (value !== null && value >= 2) found = true;
      // A cap passed in or defaulted elsewhere: `attempt < maximumAttempts`.
      const named = unwrap(side);
      if (ts.isIdentifier(named) && CAP_NAME.test(named.text)) found = true;
    }
  });
  return found;
}

/**
 * Loops that wait by counting turns: a `for` or `while` with a numeric cap that yields to the event
 * loop each pass and leaves early once something holds. How many turns a real settle takes depends
 * on the host, so the cap is a performance bound; the wait should end on the signal it is for, or
 * on the awake-time hang guard.
 */
function findIterationCapWaits(
  sourceFile: ts.SourceFile,
  constants: ReadonlyMap<string, ts.Expression>,
): DeadlineViolation[] {
  const violations: DeadlineViolation[] = [];
  walk(sourceFile, (node) => {
    if (!ts.isForStatement(node) && !ts.isWhileStatement(node) && !ts.isDoStatement(node)) return;
    const condition = ts.isForStatement(node) ? node.condition : node.expression;
    const body = node.statement;
    if (!containsYieldingAwait(body)) return;
    const capInCondition = condition !== undefined && capsAtNumber(condition, constants);
    // `while (!done() && attempt < 50)` or `for (...; attempt < 50 && !done(); ...)`.
    const conditionalCondition =
      condition !== undefined &&
      ts.isBinaryExpression(unwrap(condition)) &&
      (unwrap(condition) as ts.BinaryExpression).operatorToken.kind ===
        ts.SyntaxKind.AmpersandAmpersandToken;
    // `for (...; attempt < 50; ...) { if (done()) return; await tick(); }`.
    const exitsEarly = hasConditionalExit(body);
    // `while (true) { if (attempt++ > 50) throw ...; await tick(); }`.
    let capInBody = false;
    walk(body, (child) => {
      if (
        ts.isIfStatement(child) &&
        capsAtNumber(child.expression, constants) &&
        (ts.isThrowStatement(child.thenStatement) ||
          ts.isBreakStatement(child.thenStatement) ||
          (ts.isBlock(child.thenStatement) &&
            child.thenStatement.statements.some(
              (statement) => ts.isThrowStatement(statement) || ts.isBreakStatement(statement),
            )))
      ) {
        capInBody = true;
      }
    });
    if ((capInCondition && (conditionalCondition || exitsEarly)) || capInBody) {
      if (isLoadProof(sourceFile, node)) return;
      violations.push(violation(sourceFile, node, 'iteration-cap-wait'));
    }
  });
  return violations;
}

/** Whether `expression` reads a clock: `Date.now()`, `performance.now()`. */
function readsClock(expression: ts.Expression): boolean {
  let found = false;
  walk(expression, (node) => {
    if (!ts.isCallExpression(node)) return;
    const text = unwrap(node.expression).getText();
    if (/^(globalThis\.)?(Date\.now|performance\.now)$/.test(text)) found = true;
  });
  return found;
}

/**
 * Polling loops that end on a wall-clock deadline: `while (Date.now() < deadline)` around a yield.
 * The deadline is a budget the host's load can overrun, and a clock keeps running while the host
 * sleeps (COR-1541). They wait through `waitUntil` or the awake-time hang guard instead.
 */
function findWallClockPolls(sourceFile: ts.SourceFile): DeadlineViolation[] {
  const violations: DeadlineViolation[] = [];
  walk(sourceFile, (node) => {
    if (!ts.isForStatement(node) && !ts.isWhileStatement(node) && !ts.isDoStatement(node)) return;
    const condition = ts.isForStatement(node) ? node.condition : node.expression;
    if (!containsAwait(node.statement)) return;
    // `while (Date.now() < deadline)`, or `for (;;) { ...; if (Date.now() > deadline) throw ...; }`.
    if ((condition !== undefined && readsClock(condition)) || leavesOnClock(node.statement)) {
      if (isLoadProof(sourceFile, node)) return;
      violations.push(violation(sourceFile, node, 'wall-clock-poll'));
    }
  });
  return violations;
}

/** Whether `node` holds an `if` on a clock reading that throws, breaks or returns, outside nested functions. */
function leavesOnClock(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (ts.isFunctionLike(child)) return;
    if (
      ts.isIfStatement(child) &&
      readsClock(child.expression) &&
      /^\s*(\{\s*)?(throw|break|return)\b/.test(child.thenStatement.getText())
    ) {
      found = true;
    }
    child.forEachChild(visit);
  };
  node.forEachChild(visit);
  return found;
}

function containsAwait(node: ts.Node): boolean {
  let found = false;
  walk(node, (child) => {
    if (ts.isAwaitExpression(child)) found = true;
  });
  return found;
}

const DEFAULTED_BUDGETS = new Set([
  ...BUDGET_PROPERTIES,
  'maximumAttempts',
  'maxAttempts',
  'attempts',
  'maximumTurns',
  'maxTurns',
  'maximumIterations',
  'maxIterations',
]);

/**
 * A parameter or destructured option whose default is a budget below the hang guard:
 * `{ timeoutMs = 2_000 }`, `maximumAttempts = 50`. A helper's default decides what every caller that
 * leaves it out gets, so a short one is a short deadline in every test that uses the helper.
 */
function findDefaultedBudgets(
  sourceFile: ts.SourceFile,
  constants: ReadonlyMap<string, ts.Expression>,
): DeadlineViolation[] {
  const violations: DeadlineViolation[] = [];
  walk(sourceFile, (node) => {
    const isBinding = ts.isBindingElement(node) && ts.isIdentifier(node.name);
    const isParameter = ts.isParameter(node) && ts.isIdentifier(node.name);
    if (!isBinding && !isParameter) return;
    const name = (node.name as ts.Identifier).text;
    const initializer = (node as ts.BindingElement | ts.ParameterDeclaration).initializer;
    if (initializer === undefined || !DEFAULTED_BUDGETS.has(name)) return;
    // `{ timeoutMs: limit = 50 }` renames the property; the property name is the budget.
    const resolved = resolveNumber(initializer, constants);
    if (resolved === null || resolved <= 0) return;
    const isAttempts = !BUDGET_PROPERTIES.has(name);
    if (isAttempts ? resolved < 2 : resolved >= HANG_GUARD_MILLISECONDS) return;
    violations.push(violation(sourceFile, node, 'wait-budget-default'));
  });
  return violations;
}

const SLEEP_CALLEES = new Set(['sleep', 'delay', 'wait', 'pause', 'nap']);

/** The delay of `await sleep(n)`, `await Bun.sleep(n)` or `await new Promise((r) => setTimeout(r, n))`. */
function awaitedSleepDelay(expression: ts.Expression): ts.Expression | null {
  const operand = unwrap(expression);
  if (ts.isCallExpression(operand)) {
    const callee = unwrap(operand.expression);
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee) && callee.expression.getText() === 'Bun'
        ? callee.name.text
        : null;
    if (name !== null && SLEEP_CALLEES.has(name)) return operand.arguments[0] ?? null;
    return null;
  }
  if (ts.isNewExpression(operand) && operand.expression.getText() === 'Promise') {
    const executor = operand.arguments?.[0];
    if (executor === undefined) return null;
    let delay: ts.Expression | null = null;
    walk(executor, (node) => {
      if (
        ts.isCallExpression(node) &&
        /^(globalThis\.)?setTimeout$/.test(unwrap(node.expression).getText()) &&
        node.arguments.length >= 2 &&
        node.arguments[0] !== undefined &&
        ts.isIdentifier(unwrap(node.arguments[0])) &&
        (unwrap(node.arguments[0]) as ts.Identifier).text ===
          ((ts.isArrowFunction(executor) || ts.isFunctionExpression(executor)) &&
          executor.parameters[0] !== undefined
            ? executor.parameters[0].name.getText()
            : '')
      ) {
        delay = node.arguments[1] ?? null;
      }
    });
    return delay;
  }
  return null;
}

/**
 * `await sleep(50)` as a statement of a test or hook body, not under a manual clock: the test waits
 * a fixed time for something to settle and then asserts, so a host that needs longer fails it. Wait
 * for the thing itself (`waitUntil`, an awaited event or promise), or drive a fake clock. Sleeps in
 * helper functions and test doubles are not statements of the test body and are not read.
 */
function findSleepSynchronization(
  sourceFile: ts.SourceFile,
  constants: ReadonlyMap<string, ts.Expression>,
): DeadlineViolation[] {
  const violations: DeadlineViolation[] = [];
  walk(sourceFile, (node) => {
    if (!ts.isExpressionStatement(node) || !ts.isAwaitExpression(node.expression)) return;
    const delay = awaitedSleepDelay(node.expression.expression);
    if (delay === null) return;
    const value = resolveNumber(delay, constants);
    if (value !== null && value <= 0) return;
    // A sleep inside a loop is a poll, which the loop rules cover. Only a bare pause in the body of a
    // test or hook is read here: the nearest enclosing function is the registered callback.
    if (
      ts.findAncestor(
        node,
        (ancestor) => ts.isIterationStatement(ancestor, false) || ts.isFunctionLike(ancestor),
      ) !== undefined
    ) {
      const nearest = ts.findAncestor(
        node,
        (ancestor) => ts.isIterationStatement(ancestor, false) || ts.isFunctionLike(ancestor),
      );
      if (nearest !== undefined && ts.isIterationStatement(nearest, false)) return;
    }
    const body = ts.findAncestor(node, ts.isFunctionLike);
    if (
      body === undefined ||
      !ts.isCallExpression(body.parent) ||
      !isRegistration(body.parent) ||
      isUnderFakeTimers(node) ||
      isLoadProof(sourceFile, node)
    ) {
      return;
    }
    violations.push(violation(sourceFile, node, 'sleep-synchronization'));
  });
  return violations;
}

/**
 * `setTimeout` (or `AbortSignal.timeout`) whose callback rejects or throws, with a delay below the
 * hang guard: the timer half of a `Promise.race` against real work, which a loaded host loses.
 */
function findTimerRejections(
  sourceFile: ts.SourceFile,
  constants: ReadonlyMap<string, ts.Expression>,
): DeadlineViolation[] {
  const violations: DeadlineViolation[] = [];
  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = unwrap(node.expression).getText();
    if (callee === 'AbortSignal.timeout') {
      const [delay] = node.arguments;
      if (
        delay !== undefined &&
        isShort(delay, constants, { unresolvedIsShort: false, allowZero: true })
      ) {
        if (!isLoadProof(sourceFile, node))
          violations.push(violation(sourceFile, node, 'timer-rejection'));
      }
      return;
    }
    if (!/^(globalThis\.)?setTimeout$/.test(callee)) return;
    const [callback, delay] = node.arguments;
    if (callback === undefined || delay === undefined) return;
    if (!(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return;
    let rejects = false;
    walk(callback.body, (child) => {
      if (ts.isThrowStatement(child)) rejects = true;
      if (
        ts.isCallExpression(child) &&
        /^(reject|rejectPromise|fail)$/.test(unwrap(child.expression).getText())
      ) {
        rejects = true;
      }
    });
    if (!rejects || isUnderFakeTimers(node) || isLoadProof(sourceFile, node)) return;
    if (!isShort(delay, constants, { unresolvedIsShort: false, allowZero: true })) return;
    violations.push(violation(sourceFile, node, 'timer-rejection'));
  });
  return violations;
}

/**
 * `Promise.race([work, sleep(3000)])`: the work against a timer. A loaded host lets the timer win
 * over work that was merely late. Await the work (its own failure or the hang guard ends it); a
 * race that checks the work is still pending belongs under `// load-proof:`.
 */
function findTimerRaces(
  sourceFile: ts.SourceFile,
  constants: ReadonlyMap<string, ts.Expression>,
): DeadlineViolation[] {
  const violations: DeadlineViolation[] = [];
  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || unwrap(node.expression).getText() !== 'Promise.race') return;
    const [racers] = node.arguments;
    if (racers === undefined || !ts.isArrayLiteralExpression(unwrap(racers))) return;
    for (const racer of (unwrap(racers) as ts.ArrayLiteralExpression).elements) {
      const delay = awaitedSleepDelay(racer);
      if (delay === null) continue;
      const value = resolveNumber(delay, constants);
      if (value === null || value <= 0 || value >= HANG_GUARD_MILLISECONDS) continue;
      if (isUnderFakeTimers(node) || isLoadProof(sourceFile, node)) continue;
      violations.push(violation(sourceFile, node, 'timer-race'));
      break;
    }
  });
  return violations;
}

/** Whether `expression` is shaped like a number: a literal, arithmetic, or a bare name. */
function isNumberLike(expression: ts.Expression): boolean {
  const unwrapped = unwrap(expression);
  return (
    ts.isNumericLiteral(unwrapped) ||
    ts.isIdentifier(unwrapped) ||
    ts.isBinaryExpression(unwrapped) ||
    ts.isPrefixUnaryExpression(unwrapped)
  );
}

const BUN_TEST_COMMAND = /(^|[\s;&|(])bun\s+(?:--\S+\s+)*test(\s|$)/;
const WRAPPER_COMMAND = /scripts\/bun-test(?:-junit)?\.ts/;

/**
 * The problem with one `package.json` script, as a list of messages. A script that starts `bun
 * test` itself carries no deadline unless it passes `--timeout` as long as the test timeout.
 */
export function findPackageScriptViolations(command: string): string[] {
  if (WRAPPER_COMMAND.test(command) || !BUN_TEST_COMMAND.test(command)) return [];
  const explicit = /--timeout[= ](\d+)/.exec(command);
  if (explicit !== null && Number(explicit[1]) >= TEST_TIMEOUT_MILLISECONDS) return [];
  return [
    "starts `bun test` directly, so Bun's five-second per-test deadline applies; start it through `scripts/bun-test.ts` (or `scripts/bun-test-junit.ts`)",
  ];
}

const SPAWN_ARRAY_HEADS = new Set(['bun', 'process.execPath']);

/**
 * A script that spawns `bun test` without `TEST_TIMEOUT_ARGUMENT`: a `['bun', 'test', ...]` or
 * `[process.execPath, 'test', ...]` array, or a `$` shell template whose text runs `bun ... test`.
 */
export function findTestRunnerSpawnViolations(sourceFile: ts.SourceFile): DeadlineViolation[] {
  const violations: DeadlineViolation[] = [];
  walk(sourceFile, (node) => {
    if (ts.isArrayLiteralExpression(node)) {
      const [head, second] = node.elements;
      if (head === undefined || second === undefined) return;
      const headText = ts.isStringLiteralLike(head) ? head.text : head.getText(sourceFile);
      if (!SPAWN_ARRAY_HEADS.has(headText)) return;
      if (!ts.isStringLiteralLike(second) || second.text !== 'test') return;
      if (node.getText(sourceFile).includes('TEST_TIMEOUT_ARGUMENT')) return;
      violations.push(violation(sourceFile, node, 'bun-test-timeout'));
      return;
    }
    if (ts.isTaggedTemplateExpression(node) && node.tag.getText(sourceFile) === '$') {
      const text = ts.isNoSubstitutionTemplateLiteral(node.template)
        ? node.template.text
        : node.template.head.text +
          node.template.templateSpans.map((span) => ` \${} ${span.literal.text}`).join('');
      if (!BUN_TEST_COMMAND.test(` ${text}`)) return;
      if (node.template.getText(sourceFile).includes('TEST_TIMEOUT_ARGUMENT')) return;
      violations.push(violation(sourceFile, node, 'bun-test-timeout'));
    }
  });
  return violations;
}

// Directories whose modules exist to support tests: a helper there sets the deadline of every test
// that calls it, so it is scanned like a test file.
const TEST_SUPPORT_DIRECTORIES = new Set(['test', 'tests', 'testing', '__tests__', 'fixtures']);

function isTestFile(name: string, directory: string): boolean {
  if (name.endsWith('.playwright.ts') || name.endsWith('.spec.ts')) return false;
  return (
    name.endsWith('.test.ts') ||
    name.endsWith('.test-support.ts') ||
    (name.endsWith('.ts') &&
      !name.endsWith('.d.ts') &&
      directory.split(sep).some((segment) => TEST_SUPPORT_DIRECTORIES.has(segment)))
  );
}

export function collectFiles(directory: string, tests: string[], runners: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      // Wall-clock targets belong under a package's `scripts/benchmarks/`.
      if (entry.name === 'benchmarks' && basename(directory) === 'scripts') continue;
      collectFiles(path, tests, runners);
    } else if (entry.isFile() && isTestFile(entry.name, relative(root, directory))) {
      tests.push(path);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      runners.push(path);
    }
  }
}

// A module that imports Playwright belongs to a browser lane (`test:browser`), which runs outside
// `check` and `validate`, so its waits are Playwright's, not a blocking test's.
const PLAYWRIGHT_IMPORT = /from\s+['"](@playwright\/test|playwright|playwright-core)['"]/;

async function scan(): Promise<string[]> {
  const findings: string[] = [];
  const tests: string[] = [];
  const runners: string[] = [];
  for (const directory of SCANNED_DIRECTORIES) collectFiles(join(root, directory), tests, runners);

  for (const path of tests.toSorted()) {
    const source = await Bun.file(path).text();
    if (PLAYWRIGHT_IMPORT.test(source)) continue;
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    for (const found of findDeadlineViolations(sourceFile)) {
      findings.push(`${relative(root, path)}:${found.line} — ${found.rule} — ${found.text}`);
    }
  }

  for (const path of runners.toSorted()) {
    const source = await Bun.file(path).text();
    if (!source.includes('test')) continue;
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    for (const found of findTestRunnerSpawnViolations(sourceFile)) {
      findings.push(`${relative(root, path)}:${found.line} — ${found.rule} — ${found.text}`);
    }
  }

  const manifests = [
    join(root, 'package.json'),
    ...SCANNED_DIRECTORIES.flatMap((directory) => {
      try {
        return readdirSync(join(root, directory), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(root, directory, entry.name, 'package.json'));
      } catch {
        return [];
      }
    }),
    join(root, 'scripts', 'browser-fixtures', 'package.json'),
  ];
  for (const manifest of manifests) {
    const file = Bun.file(manifest);
    if (!(await file.exists())) continue;
    const scripts = ((await file.json()) as { scripts?: Record<string, string> }).scripts ?? {};
    for (const [name, command] of Object.entries(scripts)) {
      for (const message of findPackageScriptViolations(command)) {
        findings.push(`${relative(root, manifest)} — script ${name} — ${message}`);
      }
    }
  }

  return findings;
}

async function main(): Promise<void> {
  const findings = await scan();
  if (findings.length === 0) {
    process.stdout.write(
      'check-load-sensitive-deadlines — OK (no blocking test names a deadline below the hang guard).\n',
    );
    return;
  }

  process.stderr.write(
    'check-load-sensitive-deadlines — a blocking test names a deadline below the hang guard.\n' +
      'A deadline a loaded host can overrun makes the test flake, and it passes alone. Delete the\n' +
      'timeout so the shared hang guard applies (Bun: `--timeout` through scripts/bun-test.ts;\n' +
      'Testing Library: configureAsyncUtilityDeadline), or make the wait deterministic. A test of\n' +
      'the hang guard itself carries `// hang-guard-self-test: <reason>` above the statement.\n\n',
  );
  for (const finding of findings) process.stderr.write(`  ${finding}\n`);
  process.exit(1);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('check-load-sensitive-deadlines failed:', error);
    process.exit(1);
  });
}
