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
 *     duration below the hang guard. The same budget passed BY POSITION is read for every wait helper
 *     the scanned files declare: a function named like a wait (`waitForMessage`, `waitForLine`...)
 *     with a parameter named `timeout`, `timeoutMs`, `budget...` or `deadline...`, and a function
 *     of any name that races (`Promise.race`/`Promise.any`) a `setTimeout`, `sleep` or `Bun.sleep`
 *     whose delay is one of its parameters (`withTimeout(work, milliseconds)`), has that argument
 *     checked at every call, in any file, from a table merged across the scan. A product's own timeout option (`mailbox.awaitCleanup`,
 *     `outbox.drain`, `server.shutdownWorker`) is not read: tests of those drive an injected clock
 *     or a stalled dependency, which no load can speed up.
 *
 *   - `wait-budget-default`: a parameter or destructured option named like a budget whose default
 *     is below the hang guard (`{ timeoutMs = 2_000 }`), or any default for an attempts or turns
 *     cap (`attempts = 50`): a helper's default is the deadline of every test that omits it.
 *   - `iteration-cap-wait`: a `for` or `while` loop that yields to the event loop on a timer, a
 *     macrotask or a sleep, leaves early once something holds, and stops at a numeric cap (in its
 *     condition or an `if` in its body). How many turns a settle takes depends on the host; use
 *     `waitUntil`, or `for await (const turn of awakeTurns())`, whose only end is the hang guard. A
 *     loop that yields only microtasks (`await Promise.resolve()`, Svelte's `tick`) is not read:
 *     microtasks drain before anything else runs, so their count belongs to the code.
 *   - `wall-clock-poll`: a loop that ends on `Date.now()` or `performance.now()` against a
 *     deadline, which also keeps counting while the host sleeps (COR-1541).
 *   - `sleep-synchronization`: `await sleep(n)`, `await Bun.sleep(n)`, the promise `setTimeout` of
 *     `node:timers/promises`, `waitForRealTimersForTesting(n)`, or an awaited promise around
 *     `setTimeout` (with the callback wrapped or not), with `n` above zero, as a statement of a test
 *     or `beforeEach`/`beforeAll` body, when the test asserts anything after it. A fixed pause before
 *     an assertion fails exactly when the host is slow. Wait for the thing (`waitUntil`, an awaited
 *     promise, an event, a registry or storage state), or, for something that must NOT happen, call
 *     `quietFor(n)`, which says so: load can only delay an event, never advance it. A sleep in a
 *     helper or double, inside a loop (a poll), in a teardown hook, or one after which nothing is
 *     asserted, is not read. A one-turn yield is `single-turn-settle`'s.
 *   - `single-turn-settle`: a pause that gives the event loop ONE turn and then goes on, whether an
 *     assertion or an action follows. `sleepForTesting(n)` does exactly that under real timers, whatever
 *     `n` is (it advances a fake clock, and does nothing like waiting `n` milliseconds otherwise); so do
 *     `setImmediate`, a message port, a promise around `setTimeout(r, 0)` or `setTimeout(r)`, and
 *     `Bun.sleep(0)`. What the next step needs (a socket, a message, a file, a child process) may need
 *     more than one turn on a loaded host, so wait for that state or event instead. Where only
 *     microtasks are pending, or nothing load-dependent follows, the yield carries `// load-proof:
 *     <reason>`. Not read: a yield under fake timers, inside a loop (a poll), raced against work, last in
 *     a test, or in a teardown hook; `sleepForTesting(0)`, which drains microtasks. A same-file helper
 *     whose body is such a yield (`const settle = () => new Promise((r) => setTimeout(r, 0))`, `flush`,
 *     `flushEffects`...) is read at its DEFINITION, because hundreds of calls would each need a marker
 *     that says the same thing; the marker there states what the helper settles and why it is safe for
 *     every caller. A helper in another file is read where it is defined, not where it is called,
 *     except the three exported one-turn yields (`yieldToEventLoop`, `yieldToPortableEventLoop`,
 *     `yieldEventLoopTurn`): a call to one is resolved through the file's imports (a named import under
 *     any local name, or a member of a namespace import) and read like a same-file yield, so each call
 *     needs a marker or a following step that is not load-dependent. There is no allowlist. A yield
 *     that is not awaited but chained (`void yieldToPortableEventLoop().then(() => abort())`) is read
 *     the same way, because its action races the code under test after one turn.
 *     `yieldToEventLoop` advances a fake clock, so under fake timers it is not read.
 *   - `timer-rejection`: a `setTimeout` whose callback rejects or throws (through any parameter name),
 *     or an `AbortSignal.timeout`, with a delay below the hang guard: the timer half of a race.
 *   - `timer-race`: a timer promise raced against work, in `Promise.race`/`Promise.any`: `sleep(n)`,
 *     `Bun.sleep(n).then(...)`, the `node:timers/promises` sleep, a `new Promise` around `setTimeout`
 *     (resolving or rejecting), or a `const` holding one, with `n` above zero and below the hang
 *     guard; and a `new Promise` executor whose own `setTimeout` also resolves it while something else
 *     can, which is the same race written inline.
 *   - `quiet-window`: `await quietFor(n)` followed, in the same block, by an assertion that something
 *     happened (`toBe(true)`, `toContain`, `toBeDefined`, `toBeGreaterThan`...). `quietFor` proves an
 *     absence; before a positive assertion it is a fixed pause that passes the sleep rule by name.
 *     Counts (`toHaveLength(1)`) read as "still one" and are not here.
 *
 * A budget is read through numeric literals, `+ - * /`, parentheses, the hang-guard constants, and
 * a `const` declared in the file. A budget the guard cannot resolve is not a `wait-budget`
 * finding, but it is a `bun-test-timeout` or `testing-library-timeout` one, because those two
 * rules have no legitimate short value to protect.
 *
 * A duration is virtual time, and so is not read, inside a test or hook (or a suite whose
 * `beforeEach`/`beforeAll` does) that calls `useFakeTimers`, which patches the global `setTimeout`.
 * Even then a `Bun.sleep`, a `node:timers/promises` sleep and the real-timer helper keep real time,
 * and `createManualRuntimeServices`, `createManualClock` and manual engines do not patch the global
 * timers at all: they inject their own, so only a call THROUGH the injected services
 * (`runtime.sleep(n)`, a `sleep` destructured from them) is virtual, and the guard reads a bare
 * global sleep beside one as the real wait it is. A fake clock never excuses a Bun test timeout, a
 * Testing Library wait, or a hang-guarded child.
 *
 * Two narrow exemptions, each a comment of at least twenty characters directly above the statement
 * (or the expression inside it) and covering only that statement:
 *
 *   - `// hang-guard-self-test: <reason>` for a test of the hang guard, or of a wait helper, that
 *     must name a short guard to prove it fires: `spawnWithHangGuard`, `runWithHangGuard`,
 *     `afterAwakeTime`, `waitForCondition`, `waitUntil` and the like. No load can make a child that
 *     never exits exit, or a condition that is never true hold.
 *   - `// load-proof: <reason>` for a wait that load cannot flip, and the reason must say why in terms
 *     of determinism, never of expected speed: it waits for something that must not happen (a
 *     longer wait only gives it more time), is rejected before it starts, ends on an event whatever
 *     the clock says, or relies on timers of one clock firing in order of their deadlines. It covers
 *     the wait rules above (not a Bun or Testing Library timeout).
 *
 * Two further checks keep the deadline in place. `findPackageScriptViolations` rejects a
 * `package.json` script that starts `bun test` directly: the wrapper `scripts/bun-test.ts` (or
 * `scripts/bun-test-junit.ts`) passes `--timeout`, which is the only dependable way to raise Bun's
 * five-second default (`bunfig.toml` ignores `[test] timeout`, and `setDefaultTimeout` in a preload
 * covers the first file only). `findTestRunnerSpawnViolations` rejects a script that spawns
 * `bun test` without `TEST_TIMEOUT_ARGUMENT`.
 *
 * Scanned: every `*.test.ts` and `*.test-support.ts`, and every `.ts` module under a directory named
 * `test`, `tests`, `testing`, `__tests__` or `fixtures`, in every workspace and the root `scripts/`.
 * Not scanned: the Playwright specs (`*.playwright.ts`, `*.spec.ts`, `e2e/`, and the helpers in
 * `scripts/browser-fixtures/tests/`), which `test:browser` runs outside `check` and `validate`, and
 * the real-browser smoke tests that read `WEFT_BROWSER_SMOKE` (they skip unless that opt-in flag is
 * set, and no gate sets it). `test:browser-fixtures` is NOT a Playwright lane: it runs the Bun tests
 * in `scripts/browser-fixtures/scripts` and a build verification, so those are scanned like any
 * other test, including a file that imports Playwright for its types or version.
 *
 * Blind spots, documented rather than claimed as covered. The guard cannot see:
 *
 *   - a short deadline in a product option under test (`createThing({ timeoutMs: 50 })`,
 *     `mailbox.awaitCleanup`, `server.shutdownWorker`): a product timeout expected to expire is
 *     deterministic and one expected to be met is not, and syntax cannot tell them apart. Such
 *     tests were read by hand: they drive an injected clock, a stalled dependency or a pre-aborted
 *     signal;
 *   - a positional budget of a helper the scan does not declare (a package's own export, or a
 *     parameter named something other than a budget), or an unresolvable identifier, for `wait-budget`;
 *   - an unconditional pause of a fixed number of turns (`for (i < 3) await yieldTurn()`), which has
 *     no condition to flake on but is not a wait either;
 *   - sleeps inside helper functions and test doubles, and a negative window written as
 *     `quietFor`: its length is never checked against what it must outlast;
 *   - the order in which independent events happen to arrive, races between two timers armed at
 *     different times, and I/O ordering: nothing syntactic distinguishes a deterministic order from
 *     a lucky one;
 *   - the number of microtask turns a promise chain needs, which is deterministic by construction;
 *   - Playwright's own timeouts, which the browser lanes configure in their configuration files.
 *
 * `*.bench.ts` files are outside the default gate and outside the scan, as they are for
 * `check-wall-clock-assertions.ts`. A directory of benchmarks earns no exemption: a `.test.ts`
 * under `scripts/benchmarks/` is a default-suite test and is scanned like any other.
 */

import { readdirSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import ts from 'typescript';
import { HANG_GUARD_MILLISECONDS } from '../testing/testing/src/hang-guard.ts';
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
// `scripts/browser-fixtures/tests` holds the Playwright specs (`*.playwright.ts`) and their helpers;
// `test:browser` runs them, outside `check` and `validate`. The Bun tests that `test:browser-fixtures`
// runs live in `scripts/browser-fixtures/scripts` and are scanned.
const PLAYWRIGHT_LANE_DIRECTORY = join('scripts', 'browser-fixtures', 'tests');

export type DeadlineRule =
  | 'bun-test-timeout'
  | 'testing-library-timeout'
  | 'wait-budget'
  | 'iteration-cap-wait'
  | 'wait-budget-default'
  | 'wall-clock-poll'
  | 'sleep-synchronization'
  | 'timer-rejection'
  | 'timer-race'
  | 'quiet-window'
  | 'single-turn-settle'
  | 'real-timer-double'
  | 'fixed-count-yield-loop'
  | 'direct-bun-spawn';
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
const WAIT_FOR_BUDGETS = new Set(
  [...BUDGET_PROPERTIES].filter((property) => property !== 'timeout'),
);
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
  'waitForMessage',
  'waitForHandleEventForTesting',
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
  const start = chainRoot(call.expression);
  if (!ts.isIdentifier(start) || !REGISTRATION_ROOTS.has(start.text)) return false;
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

/** Whether a call passes an option object with a `hangGuardMilliseconds` property. */
function spellsHangGuard(call: ts.CallExpression): boolean {
  return call.arguments.some((argument) => {
    const unwrapped = unwrap(argument);
    return (
      ts.isObjectLiteralExpression(unwrapped) &&
      propertyNamed(unwrapped, new Set(['hangGuardMilliseconds'])) !== undefined
    );
  });
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

// Calls that patch the global timers, so a `setTimeout` the test or the code under test makes runs on
// a clock the test advances. Manual runtime services and manual clocks are NOT here: they hand the code
// under test an injected clock and leave `setTimeout`, `Bun.sleep` and `node:timers/promises` real, so
// a test that sleeps for real beside one is still timing the host. Only a call through the injected
// services (`runtime.sleep(n)`, `clock.advance(n)`) is virtual time, and the guard reads those as
// member calls it does not match.
const MANUAL_CLOCK_CALLEES = new Set(['useFakeTimers']);

/** Whether `node` patches the global timers with `useFakeTimers()`. */
function callsUseFakeTimers(node: ts.Node): boolean {
  let found = false;
  walk(node, (child) => {
    if (ts.isCallExpression(child)) {
      const name = calleeName(child);
      if (name !== null && MANUAL_CLOCK_CALLEES.has(name)) found = true;
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
    const start = chainRoot(call.expression);
    const isSuite = ts.isIdentifier(start) && start.text === 'describe';
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

/** For each wait helper a file declares, the positions of its budget parameters. */
export type PositionalBudgets = ReadonlyMap<string, readonly number[]>;

// Parameters whose value is how long a wait may take.
const BUDGET_PARAMETER =
  /^(timeout|timeoutMs|timeoutMilliseconds|timeoutMillis|budget\w*|deadline\w*|maxWait\w*|waitMs|waitMilliseconds)$/i;

/**
 * The names a function's body races against a timer it starts: the delay of a `setTimeout`, a
 * `sleep`, or a `Bun.sleep` in a body that also calls `Promise.race` or `Promise.any`. A parameter
 * among them is a window the helper's callers choose (`settled(work, 150)`), whatever it is called.
 */
function racedTimerDelays(body: ts.Node): Set<string> {
  let races = false;
  const delays = new Set<string>();
  walk(body, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = unwrap(node.expression).getText();
    if (/^Promise\.(race|any)$/.test(callee)) races = true;
    const delay = /^(globalThis\.)?setTimeout$/.test(callee)
      ? node.arguments[1]
      : SLEEP_NAME.test(callee) || callee === 'Bun.sleep'
        ? node.arguments[0]
        : undefined;
    if (delay !== undefined && ts.isIdentifier(unwrap(delay)))
      delays.add((unwrap(delay) as ts.Identifier).text);
  });
  return races ? delays : new Set();
}

/**
 * The wait helpers a file declares and the positions of their budget parameters: a function or
 * arrow whose name reads as a wait (see `WAITING_CALLEES`), by the name of the parameter, and any
 * function that races a timer whose delay is one of its parameters, by that parameter. A caller that
 * passes a number there sets a deadline the same as one that spells it `{ timeoutMs }`. The scan
 * merges the tables of every scanned file, so a helper declared in a support module is read at its
 * call sites everywhere.
 */
export function collectPositionalBudgets(sourceFile: ts.SourceFile): Map<string, number[]> {
  const found = new Map<string, number[]>();
  const record = (
    name: string,
    parameters: ts.NodeArray<ts.ParameterDeclaration>,
    body: ts.Node | undefined,
  ): void => {
    const named = WAITING_CALLEES.test(name);
    const raced = body === undefined ? new Set<string>() : racedTimerDelays(body);
    const positions = parameters.flatMap((parameter, index) =>
      ts.isIdentifier(parameter.name) &&
      ((named && BUDGET_PARAMETER.test(parameter.name.text)) || raced.has(parameter.name.text))
        ? [index]
        : [],
    );
    if (positions.length > 0) found.set(name, [...(found.get(name) ?? []), ...positions]);
  };
  walk(sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      record(node.name.text, node.parameters, node.body);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(unwrap(node.initializer)) ||
        ts.isFunctionExpression(unwrap(node.initializer)))
    ) {
      const helper = unwrap(node.initializer) as ts.ArrowFunction;
      record(node.name.text, helper.parameters, helper.body);
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      record(node.name.text, node.parameters, node.body);
    }
  });
  return found;
}

export function findDeadlineViolations(
  sourceFile: ts.SourceFile,
  helperBudgets: PositionalBudgets = collectPositionalBudgets(sourceFile),
): DeadlineViolation[] {
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

    // A budget handed to a wait helper by position: `waitForMessage(ws, matches, 1_000)`.
    const positions = helperBudgets.get(name);
    if (positions !== undefined && !isLoadProof(sourceFile, node) && !isUnderFakeTimers(node)) {
      const hangGuardSelfTest =
        HANG_GUARD_CALLEES.has(name) &&
        (selfTestReason(sourceFile, node)?.length ?? 0) >= MINIMUM_SELF_TEST_REASON;
      for (const position of positions) {
        const budget = node.arguments[position];
        if (
          budget !== undefined &&
          !hangGuardSelfTest &&
          isShort(budget, constants, { unresolvedIsShort: false, allowZero: true })
        ) {
          violations.push(violation(sourceFile, node, 'wait-budget'));
          break;
        }
      }
    }

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
      // `waitFor` is also the name workspaces import their own wait helpers under
      // (`waitForParityCondition as waitFor`), whose budget is `timeoutMs`: read it below too.
      if (name !== 'waitFor') return;
    } else if (name === 'configure') {
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
      // The self-test marker covers the hang guards and the wait helpers named in HANG_GUARD_CALLEES, and
      // any wait helper whose budget is spelled `hangGuardMilliseconds`: the option exists to be shortened
      // by a test that proves the helper gives up.
      if (!HANG_GUARD_CALLEES.has(name) && !spellsHangGuard(node)) return false;
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
      // `waitFor`'s `timeout` is Testing Library's, reported above.
      const option = propertyNamed(
        unwrapped,
        name === 'waitFor' ? WAIT_FOR_BUDGETS : BUDGET_PROPERTIES,
      );
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
    ...findPositiveQuietWindows(sourceFile),
    ...withoutLinesAlreadyReported(findSingleTurnSettles(sourceFile, constants), violations),
    ...findRealTimerDoubles(sourceFile, constants),
    ...findDirectBunSpawns(sourceFile),
  ];
}

/** The settle findings on lines that no other rule has already reported. */
function withoutLinesAlreadyReported(
  settles: DeadlineViolation[],
  others: DeadlineViolation[],
): DeadlineViolation[] {
  const reported = new Set(others.map((other) => other.line));
  return settles.filter((settle) => !reported.has(settle.line));
}

// A promise that settles on the next macrotask rather than a clock: `setImmediate`, a message port,
// or a `setTimeout` given no delay at all.
const MACROTASK_TURN = /setImmediate|MessageChannel|setTimeout\(\s*\w+\s*\)/;

/**
 * Whether `expression` is a SINGLE-TURN yield: a promise that gives the event loop one turn and
 * then settles, whatever the work the next step needs. That is `sleepForTesting(n)` under real
 * timers (it ignores `n`), a timer of at most one millisecond (`setTimeout(r, 0)`, `Bun.sleep(0)`),
 * and `setImmediate` or a message port. A timer that waits a real, longer time is `sleep-synchronization`'s.
 */
function isSingleTurnYield(
  expression: ts.Expression,
  context: TimerContext,
  underFakeTimers: boolean,
): boolean {
  const operand = unwrap(expression);
  const timer = timerPromiseOf(operand, context);
  if (timer !== null) {
    // Fake timers advance a virtual sleep.
    if (timer.virtual && underFakeTimers) return false;
    const value = resolveNumber(timer.delay, context.constants);
    // `sleepForTesting(0)` is a microtask drain, which the code's own promise chain decides.
    if (timer.singleTurn === true) return value !== 0;
    return value !== null && value <= 1;
  }
  if (ts.isNewExpression(operand) && operand.expression.getText() === 'Promise') {
    return MACROTASK_TURN.test(operand.getText());
  }
  if (!ts.isCallExpression(operand)) return false;
  if (calleeName(operand) === 'setImmediate') return true;
  // The exported yields are resolved through the file's imports: the file that calls one cannot see
  // the yield, so this is the only place it can be read. `yieldToEventLoop` advances a fake clock
  // under fake timers (a virtual turn); the other two are message-port turns whatever the clock.
  const exported = exportedSingleTurnYieldOf(operand, context);
  if (exported === null) return false;
  return !(exported === 'yieldToEventLoop' && underFakeTimers);
}

/** The exported one-turn yield a call resolves to through the file's imports, if it is one. */
function exportedSingleTurnYieldOf(call: ts.CallExpression, context: TimerContext): string | null {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) return context.importedYields.get(callee.text) ?? null;
  if (ts.isPropertyAccessExpression(callee)) {
    const receiver = unwrap(callee.expression);
    return EXPORTED_SINGLE_TURN_YIELDS.has(callee.name.text) &&
      ts.isIdentifier(receiver) &&
      context.namespaceImports.has(receiver.text)
      ? callee.name.text
      : null;
  }
  return null;
}

/** The operand a function's whole body awaits or returns, for a body that is one expression. */
function soleOperand(body: ts.ConciseBody): ts.Expression | undefined {
  if (!ts.isBlock(body)) return body;
  const statement = body.statements.length === 1 ? body.statements[0] : undefined;
  const expression =
    statement !== undefined &&
    (ts.isExpressionStatement(statement) || ts.isReturnStatement(statement))
      ? statement.expression
      : undefined;
  if (expression === undefined) return undefined;
  const unwrapped = unwrap(expression);
  return ts.isAwaitExpression(unwrapped) ? unwrapped.expression : expression;
}

/**
 * `single-turn-settle`: a pause that lets real work happen without waiting for it. `sleepForTesting(n)`
 * yields ONE scheduler turn under real timers whatever `n` is, `setImmediate` and `setTimeout(r, 0)`
 * yield one macrotask, and neither waits for the thing the next step needs, so a loaded host that has
 * not finished by then breaks the step after it, whether that step is an assertion or an action. A
 * single-turn yield that something follows must wait on the state or event instead, or carry
 * `// load-proof: <reason>` saying why nothing load-dependent follows (the work is microtask-only, or
 * the step is a negative window). Not read: a yield under fake timers, one inside a loop (a poll, which
 * the loop rules read), one raced against work (`timer-race` reads it), the last statement of a test,
 * and one in a teardown hook. A same-file helper whose body is a yield (`const settle = () => new
 * Promise((r) => setTimeout(r, 0))`) is read at each of its calls, where the marker belongs; an
 * exported one is read at its definition, because its callers are in files this one cannot see.
 */
function findSingleTurnSettles(
  sourceFile: ts.SourceFile,
  constants: ReadonlyMap<string, ts.Expression>,
): DeadlineViolation[] {
  const violations: DeadlineViolation[] = [];
  const context = timerContext(sourceFile, constants);
  const report = (node: ts.Node) => {
    if (!isLoadProof(sourceFile, node)) {
      violations.push(violation(sourceFile, node, 'single-turn-settle'));
    }
  };
  const isHelperCandidate = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) &&
    node.body !== undefined &&
    // A registered callback, a `new Promise` executor and a timer callback are not helpers.
    !(
      ts.isCallExpression(node.parent) ||
      ts.isNewExpression(node.parent) ||
      ts.isPropertyAssignment(node.parent)
    );
  // The same-file helpers: name -> declaration, for those whose body is a single-turn yield.
  const helpers = new Map<string, ts.FunctionLikeDeclaration>();
  walk(sourceFile, (node) => {
    if (!isHelperCandidate(node)) return;
    const operand = soleOperand(node.body as ts.ConciseBody);
    if (operand === undefined || !isSingleTurnYield(operand, context, false)) return;
    const name = ts.isFunctionDeclaration(node)
      ? node.name?.text
      : ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)
        ? node.parent.name.text
        : undefined;
    if (name !== undefined) helpers.set(name, node);
  });
  for (const declaration of helpers.values()) report(declaration);
  const insideHelper = (node: ts.Node) =>
    ts.findAncestor(node, (ancestor) => [...helpers.values()].includes(ancestor as never)) !==
    undefined;

  // A yield that is not awaited but chained: `void yieldToPortableEventLoop().then(() => abort())`.
  // The action runs after one turn whatever the code under test is doing, which is a race against
  // it: observe the point the action belongs at (a timer armed, an event, a state) instead.
  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || insideHelper(node)) return;
    const callee = unwrap(node.expression);
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'then') return;
    if (!node.arguments.some((argument) => ts.isFunctionLike(unwrap(argument)))) return;
    const source = unwrap(callee.expression);
    if (!isSingleTurnYield(source, context, isUnderFakeTimers(node))) return;
    if (ts.findAncestor(node, ts.isAwaitExpression) !== undefined) return;
    report(ts.findAncestor(node, ts.isStatement) ?? node);
  });

  walk(sourceFile, (node) => {
    if (!ts.isAwaitExpression(node) || insideHelper(node)) return;
    const nearest = ts.findAncestor(
      node,
      (ancestor) => ts.isIterationStatement(ancestor, false) || ts.isFunctionLike(ancestor),
    );
    if (nearest !== undefined && ts.isIterationStatement(nearest, false)) return;
    const raced = ts.findAncestor(
      node,
      (ancestor) =>
        ts.isFunctionLike(ancestor) ||
        (ts.isCallExpression(ancestor) &&
          /^Promise\.(race|any)$/.test(unwrap(ancestor.expression).getText())),
    );
    if (raced !== undefined && !ts.isFunctionLike(raced)) return;
    if (!isSingleTurnYield(node.expression, context, isUnderFakeTimers(node))) return;
    // A test or hook body: a teardown hook checks nothing, and the last statement of a test has
    // nothing after it to break.
    const registration =
      nearest !== undefined && ts.isCallExpression(nearest.parent) && isRegistration(nearest.parent)
        ? nearest.parent
        : null;
    if (registration !== null) {
      const registrationRoot = chainRoot(registration.expression);
      if (ts.isIdentifier(registrationRoot) && registrationRoot.text.startsWith('after')) return;
      const statement = ts.findAncestor(node, ts.isStatement);
      if (
        ts.isIdentifier(registrationRoot) &&
        (registrationRoot.text === 'test' || registrationRoot.text === 'it') &&
        statement !== undefined &&
        ts.isBlock(statement.parent) &&
        statement.parent.statements.at(-1) === statement &&
        statement.parent.parent === nearest
      ) {
        return;
      }
    }
    report(node);
  });
  return violations;
}

/**
 * `real-timer-double`: a timer stand-in that runs the callback it is given on a REAL zero-delay
 * timer: `setTimeout: (callback, ms) => { requested.push(ms); return setTimeout(callback, 0); }`.
 * Such a double makes time pass "at once", but at the next macrotask, so a test that waits for the
 * double to be ASKED for a timer (`requested.length >= 3`) and then acts races the callback: on a
 * loaded host the action lands first and the follower sees a different order (the fire-review
 * follower flake: a subscription "stayed up for the cap" before the cap's callback had run). The
 * test must wait on the callback having RUN (a count of fired timers, an empty set of pending
 * handles) and says so in `// load-proof: <reason>` above the double. A double that takes only the
 * callback (`(callback) => setTimeout(callback, 0)`) is read the same way. A double that forwards to an
 * injected manual runtime is virtual and is not read.
 */
function findRealTimerDoubles(
  sourceFile: ts.SourceFile,
  constants: ReadonlyMap<string, ts.Expression>,
): DeadlineViolation[] {
  const violations: DeadlineViolation[] = [];
  walk(sourceFile, (node) => {
    if (!(
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node)
    ))
      return;
    if (ts.isNewExpression(node.parent) || node.body === undefined) return;
    const callback = node.parameters[0]?.name;
    if (callback === undefined || !ts.isIdentifier(callback)) return;
    let found: ts.CallExpression | undefined;
    walk(node.body, (child) => {
      if (!ts.isCallExpression(child)) return;
      if (!/^(globalThis\.)?setTimeout$/.test(unwrap(child.expression).getText())) return;
      const [handler, delay] = child.arguments;
      if (handler === undefined || delay === undefined) return;
      const value = resolveNumber(delay, constants);
      if (value === null || value > 1) return;
      let mentionsCallback = false;
      walk(handler, (inner) => {
        if (ts.isIdentifier(inner) && inner.text === callback.text) mentionsCallback = true;
      });
      if (mentionsCallback) found = child;
    });
    if (found === undefined || isUnderFakeTimers(node) || isLoadProof(sourceFile, node)) return;
    violations.push(violation(sourceFile, node, 'real-timer-double'));
  });
  return violations;
}

const SETTLE_HELPER_NAME =
  /^(flush|settle|tick|yield|macrotask|drain|pause|nextTurn|waitOneTurn)\w*$|^sleepForTesting$/i;

/** Whether a loop body does nothing but yield: every statement is `await <a yield or settle call>`. */
function isYieldOnlyBody(body: ts.Statement): boolean {
  const statements = ts.isBlock(body) ? body.statements : [body];
  if (statements.length === 0) return false;
  return statements.every((statement) => {
    if (!ts.isExpressionStatement(statement)) return false;
    const awaited = unwrap(statement.expression);
    if (!ts.isAwaitExpression(awaited)) return false;
    const operand = unwrap(awaited.expression);
    if (isYield(operand)) return true;
    if (!ts.isCallExpression(operand)) return false;
    const name = calleeName(operand);
    return (
      name !== null && (SETTLE_HELPER_NAME.test(name) || EXPORTED_SINGLE_TURN_YIELDS.has(name))
    );
  });
}

/**
 * `fixed-count-yield-loop`: `for (let turn = 0; turn < 30; turn++) await flush();` with no exit but
 * the count. `iteration-cap-wait` reads a loop that leaves early and is capped; this one never
 * looks at the state at all, so it is a settle written as a loop: it passes when 30 turns happened
 * to be enough, and the host decides how much work 30 turns hold. Wait for the state with
 * `waitUntil` or `awakeTurns`, or carry `// load-proof: <reason>` where the turns are not load
 * (the work is a fixed number of microtask or immediate hops, or it is a negative window).
 */
export function findFixedCountYieldLoops(
  sourceFile: ts.SourceFile,
  constants: ReadonlyMap<string, ts.Expression>,
): DeadlineViolation[] {
  const violations: DeadlineViolation[] = [];
  walk(sourceFile, (node) => {
    if (!ts.isForStatement(node) || node.condition === undefined) return;
    if (!capsAtNumber(node.condition, constants) || hasConditionalExit(node.statement)) return;
    const { condition } = node;
    if (
      ts.isBinaryExpression(unwrap(condition)) &&
      (unwrap(condition) as ts.BinaryExpression).operatorToken.kind ===
        ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      return;
    }
    let breaks = false;
    walk(node.statement, (child) => {
      if (ts.isBreakStatement(child) || ts.isReturnStatement(child)) breaks = true;
    });
    if (breaks || !isYieldOnlyBody(node.statement)) return;
    if (isUnderFakeTimers(node) || isLoadProof(sourceFile, node)) return;
    violations.push(violation(sourceFile, node, 'fixed-count-yield-loop'));
  });
  return violations;
}

const SPAWN_CALLEES = new Set([
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
]);

/**
 * `direct-bun-spawn`: a test, test-support or fixture module that starts `bun` (`process.execPath`,
 * `'bun'`, `Bun.which('bun')`) with `Bun.spawn`, `Bun.spawnSync` or a `child_process` function
 * instead of `spawnWithHangGuard`/`runWithHangGuard`, whether the command is an array, the `cmd`
 * of an options object, a `const` the file declares, or a Bun Shell template tagged `Bun.$` (or `$`)
 * that starts with `bun`. The guarded spawns put `--no-install` in front of the child, so a module written outside the workspace cannot install what it imports from the
 * registry; a direct spawn does not. Pass `--no-install` in the call itself, or carry
 * `// load-proof: <reason>` where the child cannot reach the registry (it installs on purpose, or only
 * runs a package-manager command). The hang guard modules that do the injecting are not read.
 */
function findDirectBunSpawns(sourceFile: ts.SourceFile): DeadlineViolation[] {
  if (basename(sourceFile.fileName) === 'hang-guard.ts') return [];
  const violations: DeadlineViolation[] = [];
  const constants = collectConstants(sourceFile);
  const isBun = (head: ts.Node | undefined) =>
    head !== undefined &&
    /^(process\.execPath|'bun'|"bun"|`bun`|Bun\.which\(['"]bun['"]\))/.test(head.getText());
  // The command of a spawn: the array's first element, a `cmd` property's, or either of them behind
  // a `const` the file declares.
  const commandHead = (argument: ts.Expression | undefined, depth = 0): ts.Node | undefined => {
    if (argument === undefined || depth > 3) return undefined;
    const operand = unwrap(argument);
    if (ts.isArrayLiteralExpression(operand)) return operand.elements[0];
    if (ts.isObjectLiteralExpression(operand)) {
      for (const member of operand.properties) {
        if (member.name?.getText() !== 'cmd') continue;
        if (ts.isPropertyAssignment(member)) return commandHead(member.initializer, depth + 1);
        if (ts.isShorthandPropertyAssignment(member)) return commandHead(member.name, depth + 1);
      }
      return undefined;
    }
    if (ts.isIdentifier(operand)) {
      const initializer = constants.get(operand.text);
      return initializer === undefined ? operand : commandHead(initializer, depth + 1);
    }
    return operand;
  };
  walk(sourceFile, (node) => {
    // Bun Shell: Bun.$`bun script.ts` or $`${process.execPath} script.ts`.
    if (ts.isTaggedTemplateExpression(node)) {
      if (!/^(Bun\.\$|\$)$/.test(unwrap(node.tag).getText())) return;
      const text = node.template.getText();
      const startsBun = /^`\s*(bun\b|\$\{\s*process\.execPath\s*\})/.test(text);
      if (!startsBun || text.includes('--no-install') || isLoadProof(sourceFile, node)) return;
      violations.push(violation(sourceFile, node, 'direct-bun-spawn'));
      return;
    }
    if (!ts.isCallExpression(node)) return;
    const name = calleeName(node);
    if (name === null || !SPAWN_CALLEES.has(name)) return;
    const callee = unwrap(node.expression).getText();
    if (name === 'spawn' && !/^(Bun\.spawn|spawn|cp\.spawn|childProcess\.spawn)$/.test(callee))
      return;
    if (!isBun(commandHead(node.arguments[0]))) return;
    // The flag may sit in the call or in the `const` that holds the command.
    const [argument] = node.arguments;
    const held =
      argument !== undefined && ts.isIdentifier(unwrap(argument))
        ? (constants.get((unwrap(argument) as ts.Identifier).text)?.getText() ?? '')
        : '';
    if (
      node.getText().includes('--no-install') ||
      held.includes('--no-install') ||
      isLoadProof(sourceFile, node)
    ) {
      return;
    }
    violations.push(violation(sourceFile, node, 'direct-bun-spawn'));
  });
  return violations;
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
    // A loop whose failure is a `throw` after it ("gave up after N tries") is a poll whatever it
    // awaits: the helper that yields may have any name (`settle`, `nextTurn`), so the shape decides.
    const givesUp = nextStatementThrows(node);
    if (!containsYieldingAwait(body) && !(givesUp && awaitsMoreThanMicrotasks(body))) return;
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

/** Whether the statement right after `loop` in its block is a `throw`. */
function nextStatementThrows(loop: ts.Node): boolean {
  const parent = loop.parent;
  if (!ts.isBlock(parent) && !ts.isSourceFile(parent)) return false;
  const siblings = parent.statements;
  const next = siblings[siblings.indexOf(loop as ts.Statement) + 1];
  return next !== undefined && ts.isThrowStatement(next);
}

const MICROTASK_ONLY = /^(resolve|tick|flushSync|flushMicrotasks?|\w*[Mm]icrotasks?\w*)$/;

/** Whether `node` awaits anything but a microtask turn (outside nested functions). */
function awaitsMoreThanMicrotasks(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (ts.isFunctionLike(child)) return;
    if (ts.isAwaitExpression(child)) {
      const operand = unwrap(child.expression);
      const name = ts.isCallExpression(operand) ? calleeName(operand) : null;
      if (name === null || !MICROTASK_ONLY.test(name)) found = true;
    }
    child.forEachChild(visit);
  };
  node.forEachChild(visit);
  return found;
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
    if (!(ts.isBindingElement(node) || ts.isParameter(node)) || !ts.isIdentifier(node.name)) return;
    const name = node.name.text;
    const initializer = node.initializer;
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

// Names that mean "do nothing for n milliseconds": `sleep`, `delay`, `pause`, `nap`, `wait`, the test
// helper that waits for real timers, and `sleepForTesting`, which under real timers yields ONE
// scheduler turn whatever `n` is (see `SINGLE_TURN_SLEEP`).
const SLEEP_NAME =
  /^(sleep|delay|pause|nap)(ForReal|Real|Ms|Milliseconds|ForTesting)?$|^wait$|^waitForRealTimersForTesting$/;
// Sleeps that Bun's fake timers advance. Everything else (`Bun.sleep`, `node:timers/promises`, the
// real-timer helper) keeps real time under `useFakeTimers`.
const VIRTUAL_SLEEP = new Set<string>(['sleepForTesting']);
// `sleepForTesting(n)` does not wait n milliseconds under real timers: it yields one scheduler turn.
// A step that needs real work (a socket, a child process, a storage round trip) to finish inside that
// one turn is load-sensitive, so it is read only before an assertion that something happened.
const SINGLE_TURN_SLEEP = new Set(['sleepForTesting']);

/** What a promise that settles on a real timer is waiting for, and whether fake timers advance it. */
type TimerPromise = { delay: ts.Expression; virtual: boolean; singleTurn?: boolean };

/** The facts about a file that decide which `sleep` is the real one. */
type TimerContext = {
  /** Names bound to the promise form of `setTimeout` in `node:timers/promises`. */
  aliases: ReadonlySet<string>;
  /** Names destructured from an object (`const { sleep } = runtime`): an injected clock, not a global. */
  injected: ReadonlySet<string>;
  /** Local names bound by an import to one of the exported one-turn yields (`EXPORTED_SINGLE_TURN_YIELDS`). */
  importedYields: ReadonlyMap<string, string>;
  /** Local names of namespace imports (`import * as loop from ...`), whose members may be those yields. */
  namespaceImports: ReadonlySet<string>;
  constants: ReadonlyMap<string, ts.Expression>;
};

function timerContext(
  sourceFile: ts.SourceFile,
  constants: ReadonlyMap<string, ts.Expression>,
): TimerContext {
  const aliases = new Set<string>();
  const injected = new Set<string>();
  const importedYields = new Map<string, string>();
  const namespaceImports = new Set<string>();
  walk(sourceFile, (node) => {
    if (ts.isImportDeclaration(node)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (EXPORTED_SINGLE_TURN_YIELDS.has(imported))
            importedYields.set(element.name.text, imported);
        }
      } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        namespaceImports.add(bindings.name.text);
      }
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /^(node:)?timers\/promises$/.test(node.moduleSpecifier.text)
    ) {
      const bindings = node.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text === 'setTimeout') {
            aliases.add(element.name.text);
          }
        }
      }
    }
    if (
      ts.isBindingElement(node) &&
      ts.isObjectBindingPattern(node.parent) &&
      ts.isIdentifier(node.name)
    ) {
      injected.add(node.name.text);
    }
  });
  return { aliases, injected, importedYields, namespaceImports, constants };
}

/** The `new Promise` executor that `node` is inside of, when it is the executor's own body. */
function enclosingExecutor(node: ts.Node): ts.FunctionLikeDeclaration | null {
  const executor = ts.findAncestor(node, ts.isFunctionLike);
  if (
    executor === undefined ||
    !(ts.isArrowFunction(executor) || ts.isFunctionExpression(executor)) ||
    !ts.isNewExpression(executor.parent) ||
    executor.parent.expression.getText() !== 'Promise'
  ) {
    return null;
  }
  return executor;
}

/** Whether `callback` settles an executor's promise: it throws, or calls one of the executor's parameters. */
function settlesExecutor(
  callback: ts.Node,
  executor: ts.FunctionLikeDeclaration,
): { resolves: boolean; rejects: boolean } {
  const [resolveParameter, rejectParameter] = executor.parameters.map((parameter) =>
    ts.isIdentifier(parameter.name) ? parameter.name.text : null,
  );
  let resolves = false;
  let rejects = false;
  walk(callback, (child) => {
    if (ts.isThrowStatement(child)) rejects = true;
    if (!ts.isCallExpression(child)) return;
    const name = unwrap(child.expression).getText();
    if (rejectParameter !== undefined && rejectParameter !== null && name === rejectParameter) {
      rejects = true;
    }
    if (resolveParameter !== undefined && resolveParameter !== null && name === resolveParameter) {
      resolves = true;
    }
    if (/^(reject|rejectPromise|fail)$/.test(name)) rejects = true;
  });
  return { resolves, rejects };
}

/**
 * The timer a promise settles on, when its settlement is a pause: `sleep(n)`, `Bun.sleep(n)`, the
 * promise `setTimeout` of `node:timers/promises`, `new Promise((r) => setTimeout(r, n))` and its
 * wrapped-callback forms, any of them followed by `.then`/`.catch`/`.finally`, or a `const` holding one.
 */
function timerPromiseOf(
  expression: ts.Expression,
  context: TimerContext,
  depth = 0,
): TimerPromise | null {
  const operand = unwrap(expression);
  if (ts.isIdentifier(operand)) {
    const initializer = context.constants.get(operand.text);
    return initializer === undefined || depth > 3
      ? null
      : timerPromiseOf(initializer, context, depth + 1);
  }
  if (ts.isCallExpression(operand)) {
    const callee = unwrap(operand.expression);
    if (ts.isPropertyAccessExpression(callee) && /^(then|catch|finally)$/.test(callee.name.text)) {
      return timerPromiseOf(callee.expression, context, depth);
    }
    const delay = operand.arguments[0];
    if (delay === undefined) return null;
    if (ts.isIdentifier(callee)) {
      if (context.aliases.has(callee.text)) return { delay, virtual: false };
      // `sleep(10, runtime.timers)` hands its clock in: that is an injected timer, not a real wait.
      if (
        SLEEP_NAME.test(callee.text) &&
        !context.injected.has(callee.text) &&
        operand.arguments.length <= 1
      ) {
        return {
          delay,
          virtual: VIRTUAL_SLEEP.has(callee.text),
          singleTurn: SINGLE_TURN_SLEEP.has(callee.text),
        };
      }
      return null;
    }
    if (ts.isPropertyAccessExpression(callee) && callee.expression.getText() === 'Bun') {
      return /^sleep$/.test(callee.name.text) ? { delay, virtual: false } : null;
    }
    return null;
  }
  if (ts.isNewExpression(operand) && operand.expression.getText() === 'Promise') {
    const executor = operand.arguments?.[0];
    if (
      executor === undefined ||
      !(ts.isArrowFunction(executor) || ts.isFunctionExpression(executor))
    ) {
      return null;
    }
    let found: TimerPromise | null = null;
    walk(executor, (node) => {
      if (
        !ts.isCallExpression(node) ||
        !/^(globalThis\.)?setTimeout$/.test(unwrap(node.expression).getText()) ||
        node.arguments.length < 2
      ) {
        return;
      }
      const [callback, delay] = node.arguments;
      if (callback === undefined || delay === undefined) return;
      const parameter = executor.parameters[0]?.name.getText();
      const settles =
        ts.isIdentifier(unwrap(callback)) && (unwrap(callback) as ts.Identifier).text === parameter
          ? true
          : (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
            (() => {
              const result = settlesExecutor(callback.body, executor);
              return result.resolves || result.rejects;
            })();
      if (settles) found = { delay, virtual: true };
    });
    return found;
  }
  return null;
}

function pausesBeforeAssertion(
  registration: ts.CallExpression,
  body: ts.Node,
  node: ts.Node,
): boolean {
  // A hook runs before every test it covers, so a pause in `beforeEach`/`beforeAll` is a setup wait;
  // one in `afterEach`/`afterAll` closes what the test opened and checks nothing.
  const hook = chainRoot(registration.expression);
  if (ts.isIdentifier(hook) && hook.text.startsWith('before')) return true;
  if (ts.isIdentifier(hook) && hook.text.startsWith('after')) return false;
  return assertsAfter(body, node);
}

function assertsAfter(body: ts.Node, node: ts.Node): boolean {
  let found = false;
  walk(body, (child) => {
    if (
      child.getStart() >= node.getEnd() &&
      ts.isCallExpression(child) &&
      /^(expect|assert)(\.\w+)*$/.test(unwrap(child.expression).getText())
    ) {
      found = true;
    }
  });
  return found;
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
  const context = timerContext(sourceFile, constants);
  walk(sourceFile, (node) => {
    if (!ts.isExpressionStatement(node) || !ts.isAwaitExpression(node.expression)) return;
    const timer = timerPromiseOf(node.expression.expression, context);
    if (timer === null) return;
    const value = resolveNumber(timer.delay, constants);
    if (value !== null && value <= 0) return;
    // A sleep inside a loop is a poll, which the loop rules cover. Only a bare pause in the body of a
    // test or hook is read here: the nearest enclosing function is the registered callback.
    const nearest = ts.findAncestor(
      node,
      (ancestor) => ts.isIterationStatement(ancestor, false) || ts.isFunctionLike(ancestor),
    );
    if (nearest !== undefined && ts.isIterationStatement(nearest, false)) return;
    const body = ts.findAncestor(node, ts.isFunctionLike);
    if (
      body === undefined ||
      !ts.isCallExpression(body.parent) ||
      !isRegistration(body.parent) ||
      (timer.virtual && isUnderFakeTimers(node)) ||
      isLoadProof(sourceFile, node) ||
      timer.singleTurn === true ||
      !pausesBeforeAssertion(body.parent, body, node)
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
    const executor = enclosingExecutor(node);
    const settled =
      executor === null
        ? { resolves: false, rejects: false }
        : settlesExecutor(callback.body, executor);
    let rejects = settled.rejects;
    walk(callback.body, (child) => {
      if (ts.isThrowStatement(child)) rejects = true;
    });
    // A timer that RESOLVES a promise something else can also settle is the same race: the other
    // source loses to the timer when the host is slow. (A promise that only waits for its timer is a
    // sleep, which the sleep rule reads.)
    const racesOtherSource =
      executor !== null &&
      settled.resolves &&
      !rejects &&
      executor.body !== undefined &&
      ts.isBlock(executor.body) &&
      executor.body.statements.some((statement) => !statement.getText().includes('setTimeout('));
    if (
      (!rejects && !racesOtherSource) ||
      isUnderFakeTimers(node) ||
      isLoadProof(sourceFile, node)
    ) {
      return;
    }
    if (!isShort(delay, constants, { unresolvedIsShort: false, allowZero: true })) return;
    violations.push(violation(sourceFile, node, rejects ? 'timer-rejection' : 'timer-race'));
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
  const context = timerContext(sourceFile, constants);
  walk(sourceFile, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !/^Promise\.(race|any)$/.test(unwrap(node.expression).getText())
    )
      return;
    const [racers] = node.arguments;
    if (racers === undefined || !ts.isArrayLiteralExpression(unwrap(racers))) return;
    for (const racer of (unwrap(racers) as ts.ArrayLiteralExpression).elements) {
      const timer = timerPromiseOf(racer, context);
      if (timer === null) continue;
      const value = resolveNumber(timer.delay, constants);
      if (value === null || value <= 0 || value >= HANG_GUARD_MILLISECONDS) continue;
      if ((timer.virtual && isUnderFakeTimers(node)) || isLoadProof(sourceFile, node)) continue;
      violations.push(violation(sourceFile, node, 'timer-race'));
      break;
    }
  });
  return violations;
}

// An assertion that something HAPPENED: after a `quietFor` window it can only pass by luck of timing.
// Counts (`toHaveLength(1)`) are not here: after a quiet window they read "still one", an absence.
const POSITIVE_ASSERTION =
  /\.(toBe\(\s*true\s*\)|toBeTruthy\(|toBeDefined\(|toContain\(|toBeGreaterThan|toHaveBeenCalled\(\s*\)|toMatch\(|toBeInstanceOf)/;

/**
 * `await quietFor(n)` followed by an assertion that something happened. `quietFor` is the window for
 * something that must NOT happen: load can only delay an event, so a pass through it proves the
 * absence. Placed before a positive assertion it is a fixed pause in disguise, and passes the sleep
 * rule by name alone. The first `expect` after it, in the same block, must not read as positive; wait
 * for the event instead (`waitUntil`, an awaited promise), or assert the absence.
 */
function findPositiveQuietWindows(sourceFile: ts.SourceFile): DeadlineViolation[] {
  const violations: DeadlineViolation[] = [];
  walk(sourceFile, (node) => {
    if (
      !ts.isExpressionStatement(node) ||
      !ts.isAwaitExpression(node.expression) ||
      !ts.isCallExpression(node.expression.expression) ||
      calleeName(node.expression.expression) !== 'quietFor' ||
      !(ts.isBlock(node.parent) || ts.isCaseClause(node.parent))
    ) {
      return;
    }
    const siblings = node.parent.statements;
    for (const next of siblings.slice(siblings.indexOf(node) + 1)) {
      const text = next.getText(sourceFile);
      if (!/\bexpect\(/.test(text)) {
        // Another await ends the window's meaning; keep looking only through plain statements.
        if (containsAwait(next)) return;
        continue;
      }
      if (
        POSITIVE_ASSERTION.test(text) &&
        !/\.not\./.test(text) &&
        !isLoadProof(sourceFile, node)
      ) {
        violations.push(violation(sourceFile, node, 'quiet-window'));
      }
      return;
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
      if (relative(root, path) === PLAYWRIGHT_LANE_DIRECTORY) continue;
      collectFiles(path, tests, runners);
    } else if (entry.isFile() && isTestFile(entry.name, relative(root, directory))) {
      tests.push(path);
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.bench.ts')
    ) {
      runners.push(path);
    }
  }
}

// One-turn yields exported by a helper module. The file that calls one cannot see the yield, so
// `isExportedSingleTurnYieldCall` resolves the call through the file's imports and
// `single-turn-settle` reads it like a same-file yield: the next step must wait on the state, or the
// call carries `// load-proof: <reason>` directly above it.
const EXPORTED_SINGLE_TURN_YIELDS = new Set([
  'yieldToEventLoop',
  'yieldToPortableEventLoop',
  'yieldEventLoopTurn',
]);
const FIXED_COUNT_LOOP_ALLOWLIST = join(import.meta.dir, 'fixed-count-yield-loop-allowlist.json');

/** The same arithmetic for the fixed-count yield loops of one file. */
export function fixedCountLoopAllowlistFindings(
  file: string,
  counted: number,
  allowed: number,
): string[] {
  if (counted > allowed) {
    return [
      `${file} — fixed-count-yield-loop — ${counted - allowed} new loop(s) that yield a fixed number of times and look at nothing: wait on the state with waitUntil or awakeTurns, or add \`// load-proof: <reason>\` above the loop; never raise scripts/fixed-count-yield-loop-allowlist.json`,
    ];
  }
  if (counted < allowed) {
    return [
      `${file} — fixed-count-yield-loop-allowlist — the allowlist says ${allowed} but the file has ${counted}: lower the entry in scripts/fixed-count-yield-loop-allowlist.json to ${counted}${counted === 0 ? ' (delete it)' : ''}`,
    ];
  }
  return [];
}

/**
 * The entries of an allowlist that are higher than the same allowlist on `origin/main`. A ratchet
 * that only compares the file with itself lets a reviewed edit raise a count; this one refuses any
 * count above the baseline. A baseline that is missing (the file is new, or there is no
 * `origin/main`) refuses nothing.
 */
export function allowlistRaises(
  name: string,
  current: Record<string, number>,
  baseline: Record<string, number> | null,
): string[] {
  if (baseline === null) return [];
  return Object.entries(current)
    .filter(([file, count]) => count > (baseline[file] ?? 0))
    .map(
      ([file, count]) =>
        `${file} — ${name}-raise — the allowlist now allows ${count} where origin/main allows ${baseline[file] ?? 0}: an allowlist only shrinks; wait on the state or mark the site instead`,
    );
}

function baselineAllowlist(path: string): Record<string, number> | null {
  const shown = Bun.spawnSync(['git', 'show', `origin/main:${path}`], { cwd: root });
  if (shown.exitCode !== 0) return null;
  try {
    return JSON.parse(shown.stdout.toString()) as Record<string, number>;
  } catch {
    return null;
  }
}

// Real-browser smoke tests run only when this flag is set; none of `check`, `validate` or the
// dev container sets it, so their Playwright launch and wait budgets are not blocking deadlines.
const OPT_IN_BROWSER_GATE = /WEFT_BROWSER_SMOKE/;

async function scan(): Promise<string[]> {
  const findings: string[] = [];
  const tests: string[] = [];
  const runners: string[] = [];
  for (const directory of SCANNED_DIRECTORIES) collectFiles(join(root, directory), tests, runners);

  const parsed: Array<{ path: string; sourceFile: ts.SourceFile }> = [];
  const helperBudgets = new Map<string, number[]>();
  for (const path of tests.toSorted()) {
    const source = await Bun.file(path).text();
    if (OPT_IN_BROWSER_GATE.test(source)) continue;
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    parsed.push({ path, sourceFile });
    for (const [name, positions] of collectPositionalBudgets(sourceFile)) {
      helperBudgets.set(name, [...new Set([...(helperBudgets.get(name) ?? []), ...positions])]);
    }
  }
  const countedLoops = new Map<string, number>();
  const loopAllowlist = (await Bun.file(FIXED_COUNT_LOOP_ALLOWLIST).json()) as Record<
    string,
    number
  >;
  for (const { path, sourceFile } of parsed) {
    for (const found of findDeadlineViolations(sourceFile, helperBudgets)) {
      findings.push(`${relative(root, path)}:${found.line} — ${found.rule} — ${found.text}`);
    }
    const loops = findFixedCountYieldLoops(sourceFile, collectConstants(sourceFile)).length;
    if (loops > 0) countedLoops.set(relative(root, path), loops);
  }
  for (const file of [
    ...new Set([...countedLoops.keys(), ...Object.keys(loopAllowlist)]),
  ].toSorted()) {
    findings.push(
      ...fixedCountLoopAllowlistFindings(
        file,
        countedLoops.get(file) ?? 0,
        loopAllowlist[file] ?? 0,
      ),
    );
  }
  findings.push(
    ...allowlistRaises(
      'fixed-count-yield-loop-allowlist',
      loopAllowlist,
      baselineAllowlist('scripts/fixed-count-yield-loop-allowlist.json'),
    ),
  );

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
