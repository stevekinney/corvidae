import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import ts from 'typescript';
import { HANG_GUARD_MILLISECONDS } from '../testing/testing/src/hang-guard.ts';
import {
  allowlistRaises,
  collectPositionalBudgets,
  findDeadlineViolations,
  findPackageScriptViolations,
  findTestRunnerSpawnViolations,
} from './check-load-sensitive-deadlines.ts';

function inspect(source: string): string[] {
  const parsed = ts.createSourceFile('fixture.test.ts', source, ts.ScriptTarget.Latest, true);
  return findDeadlineViolations(parsed).map((violation) => violation.rule);
}

describe('a Bun per-test or hook timeout below the hang guard', () => {
  test.each([
    ['a numeric third argument', "test('a', async () => {}, 10_000);"],
    ['a numeric third argument on it', "it('a', async () => {}, 5_000);"],
    ['an options object', "test('a', async () => {}, { timeout: 30_000 });"],
    ['a test.each timeout', "test.each([[1]])('a %s', async () => {}, 60_000);"],
    ['a modifier chain', "test.skipIf(flag)('a', async () => {}, 60_000);"],
    ['a describe timeout', "describe('a', () => {}, { timeout: 1_000 });"],
    ['a hook timeout', 'beforeAll(async () => {}, 20_000);'],
    ['a product of literals', "test('a', async () => {}, 30 * 1000);"],
    ['a file-level constant', "const BUDGET = 8_000;\ntest('a', async () => {}, BUDGET);"],
    ['setDefaultTimeout', 'setDefaultTimeout(15_000);'],
    ['jest.setTimeout', 'jest.setTimeout(15_000);'],
    ['a timeout it cannot resolve', "test('a', async () => {}, someBudget);"],
  ])('reports %s', (_name, source) => {
    expect(inspect(source)).toEqual(['bun-test-timeout']);
  });

  test.each([
    ['the hang guard itself', `test('a', async () => {}, ${HANG_GUARD_MILLISECONDS});`],
    ['a larger literal', "test('a', async () => {}, 300_000);"],
    [
      'the hang guard constant',
      "test('a', async () => {}, HANG_GUARD_MILLISECONDS);\ntest('b', async () => {}, 2 * HANG_GUARD_MILLISECONDS);",
    ],
    ['no timeout', "test('a', async () => {});\ntest.each([[1], [2]])('a %s', async () => {});"],
    ['a describe without one', "describe('a', () => { test('a', () => {}); });"],
    [
      'a different callee with a numeric argument',
      'expect(count).toBe(5_000);\nsetThing(1, 2_000);',
    ],
  ])('accepts %s', (_name, source) => {
    expect(inspect(source)).toEqual([]);
  });
});

describe('a Testing Library wait below the hang guard', () => {
  test.each([
    ['waitFor', 'await waitFor(() => expect(x).toBe(1), { timeout: 2_000 });'],
    ['findByRole', "await screen.findByRole('button', {}, { timeout: 3_000 });"],
    ['findAllByText', "await view.findAllByText('a', { timeout: 500 });"],
    [
      'waitForElementToBeRemoved',
      'await waitForElementToBeRemoved(() => query(), { timeout: 4_000 });',
    ],
    ['configure', 'configure({ asyncUtilTimeout: 2_000 });'],
    ['a constant', 'const SHORT = 750;\nawait waitFor(check, { timeout: SHORT });'],
  ])('reports %s', (_name, source) => {
    expect(inspect(source)).toEqual(['testing-library-timeout']);
  });

  test.each([
    ['no options', "await screen.findByRole('button');"],
    ['a long timeout', `await waitFor(check, { timeout: ${HANG_GUARD_MILLISECONDS} });`],
    ['an interval only', 'await waitFor(check, { interval: 5 });'],
    ['configure with the hang guard', 'configure({ asyncUtilTimeout: HANG_GUARD_MILLISECONDS });'],
  ])('accepts %s', (_name, source) => {
    expect(inspect(source)).toEqual([]);
  });
});

describe('a wait budget below the hang guard handed to a waiting call', () => {
  test.each([
    ['waitForCondition timeoutMs', 'await waitForCondition(() => ready, { timeoutMs: 1_000 });'],
    ['readFrames', 'await readFrames(socket, 3, { timeoutMs: 5_000 });'],
    ['a spawn hang guard', "spawnWithHangGuard(['x'], { hangGuardMilliseconds: 4_500 });"],
    ['a method', 'await harness.nextServerMessage({ timeoutMs: 2_000 });'],
    ['timeoutMilliseconds', 'await harness.resolveWithin({ timeoutMilliseconds: 3_000 });'],
    [
      'a constant',
      'const GATE = 4_500;\nawait runWithHangGuard(cmd, { hangGuardMilliseconds: GATE });',
    ],
  ])('reports %s', (_name, source) => {
    expect(inspect(source)).toEqual(['wait-budget']);
  });

  test.each([
    ['the hang guard', 'await waitForCondition(check, { timeoutMs: HANG_GUARD_MILLISECONDS });'],
    ['zero', 'await frames.readFrames({ timeoutMs: 0 });'],
    ['an unrelated callee', 'createThing({ timeoutMs: 50 });'],
    ['the default', 'await waitForCondition(check);'],
  ])('accepts %s', (_name, source) => {
    expect(inspect(source)).toEqual([]);
  });
});

describe('the hang-guard self-test exemption', () => {
  const reason = '// hang-guard-self-test: the child never exits, so no load can end it early';

  test('exempts a short guard on a spawn, directly above the statement', () => {
    expect(
      inspect(
        `${reason}\nconst child = spawnWithHangGuard(['sleep', '1000'], { hangGuardMilliseconds: 50 });`,
      ),
    ).toEqual([]);
  });

  test('accepts the comment inside the expression that holds the call', () => {
    expect(
      inspect(
        `expect(\n  await rejectionOf(\n    ${reason}\n    spawnWithHangGuard(['sleep'], { hangGuardMilliseconds: 50 }),\n  ),\n).toThrow();`,
      ),
    ).toEqual([]);
  });

  test('exempts afterAwakeTime', () => {
    expect(inspect(`${reason}\nafterAwakeTime(10, onElapsed);`)).toEqual([]);
  });

  test('requires a reason of at least twenty characters', () => {
    expect(
      inspect(
        "// hang-guard-self-test: never exits\nspawnWithHangGuard(['sleep'], { hangGuardMilliseconds: 50 });",
      ),
    ).toEqual(['wait-budget']);
  });

  test('does not cover a waiting call that is not a hang guard', () => {
    expect(inspect(`${reason}\nawait readFrames(response, { timeoutMs: 50 });`)).toEqual([
      'wait-budget',
    ]);
  });

  test('does not cover a Bun test timeout', () => {
    expect(inspect(`${reason}\ntest('a', async () => {}, 5_000);`)).toEqual(['bun-test-timeout']);
  });

  test('does not carry past the next statement', () => {
    expect(
      inspect(
        `${reason}\nconst first = 1;\nspawnWithHangGuard(['sleep'], { hangGuardMilliseconds: 50 });`,
      ),
    ).toEqual(['wait-budget']);
  });

  test('a call without a short budget needs no exemption', () => {
    expect(
      inspect("spawnWithHangGuard(['x']);\nafterAwakeTime(HANG_GUARD_MILLISECONDS, fn);"),
    ).toEqual([]);
  });

  test('reports afterAwakeTime below the hang guard when it is not exempt', () => {
    expect(inspect('afterAwakeTime(10, onElapsed);')).toEqual(['wait-budget']);
  });
});

describe('a wait helper whose own test proves it gives up', () => {
  const reason = '// hang-guard-self-test: the predicate never holds, so no load can satisfy it';

  test('exempts waitForCondition under the marker', () => {
    expect(
      inspect(`${reason}\nawait waitForCondition(() => false, { timeoutMs: 5, label: 'never' });`),
    ).toEqual([]);
  });

  test('reports waitForCondition without the marker', () => {
    expect(inspect('await waitForCondition(() => false, { timeoutMs: 5 });')).toEqual([
      'wait-budget',
    ]);
  });
});

describe('a wait helper spelled with hangGuardMilliseconds', () => {
  const reason =
    '// hang-guard-self-test: the workflow never reaches the status, so no load can end the wait';

  test('is exempt under the marker, whatever the helper is called', () => {
    expect(
      inspect(
        `${reason}\nawait waitForStatus(engine, 'id', 'done', { hangGuardMilliseconds: 20 });`,
      ),
    ).toEqual([]);
  });

  test('is reported without the marker', () => {
    expect(
      inspect("await waitForStatus(engine, 'id', 'done', { hangGuardMilliseconds: 20 });"),
    ).toEqual(['wait-budget']);
  });
});

describe('a wait budget under fake timers is virtual time', () => {
  test.each([
    [
      'a test body that installs them',
      "test('a', async () => {\n  useFakeTimers();\n  await harness.nextServerMessage({ timeoutMs: 150 });\n});",
    ],
    [
      'jest.useFakeTimers in the body',
      "it('a', async () => {\n  jest.useFakeTimers();\n  await waitForCondition(check, { timeoutMs: 10 });\n});",
    ],
    [
      'a beforeEach in the suite',
      "describe('a', () => {\n  beforeEach(() => { useFakeTimers(); });\n  it('b', async () => {\n    await frames.readFrames({ timeoutMs: 100 });\n  });\n});",
    ],
    [
      'a beforeEach that is the installer itself',
      "describe('a', () => {\n  beforeEach(useFakeTimers);\n  it('b', async () => {\n    await frames.readFrames({ timeoutMs: 100 });\n  });\n});",
    ],
    [
      'a hook at the top of the file',
      "beforeEach(() => { jest.useFakeTimers(); });\nit('b', async () => {\n  await frames.readFrames({ timeoutMs: 100 });\n});",
    ],
  ])('accepts %s', (_name, source) => {
    expect(inspect(source)).toEqual([]);
  });

  test('reports the same call in a test that does not install them', () => {
    expect(
      inspect(
        "describe('a', () => {\n  it('b', async () => {\n    await frames.readFrames({ timeoutMs: 100 });\n  });\n});",
      ),
    ).toEqual(['wait-budget']);
  });

  test('does not excuse a Bun test timeout', () => {
    expect(inspect("test('a', async () => {\n  useFakeTimers();\n}, 5_000);")).toEqual([
      'bun-test-timeout',
    ]);
  });

  test('does not excuse a hang-guarded child', () => {
    expect(
      inspect(
        "test('a', async () => {\n  useFakeTimers();\n  spawnWithHangGuard(['x'], { hangGuardMilliseconds: 50 });\n});",
      ),
    ).toEqual(['wait-budget']);
  });
});

describe('package scripts that start bun test', () => {
  test.each([
    ['a bare bun test', 'bun test src'],
    ['an environment prefix', 'TZ=UTC bun test --parallel=4 src'],
    ['a chained command', 'bun run build && bun test src'],
    ['a config flag', 'bun --config=./bunfig.ui.toml test src'],
  ])('reports %s', (_name, command) => {
    expect(findPackageScriptViolations(command)).toHaveLength(1);
  });

  test.each([
    ['the wrapper', 'bun ../../scripts/bun-test.ts --parallel=4 src'],
    ['the junit wrapper', 'bun ../../scripts/bun-test-junit.ts src'],
    ['the root wrapper', 'bun scripts/bun-test.ts ./scripts/*.test.ts'],
    ['an unrelated bun command', 'bun run build'],
    ['a different script', 'bun scripts/check-coverage.ts'],
  ])('accepts %s', (_name, command) => {
    expect(findPackageScriptViolations(command)).toEqual([]);
  });

  test('accepts an explicit timeout at least as long as the test timeout', () => {
    expect(findPackageScriptViolations('bun test --timeout=240000 src')).toEqual([]);
  });

  test('reports an explicit timeout shorter than the test timeout', () => {
    expect(findPackageScriptViolations('bun test --timeout=30000 src')).toHaveLength(1);
  });
});

describe('scripts that start bun test themselves', () => {
  function inspectScript(source: string): number {
    const parsed = ts.createSourceFile('runner.ts', source, ts.ScriptTarget.Latest, true);
    return findTestRunnerSpawnViolations(parsed).length;
  }

  test.each([
    ['a bun array', "Bun.spawn(['bun', 'test', '--parallel=4', path]);"],
    ['an execPath array', "Bun.spawn([process.execPath, 'test', path]);"],
    ['a shell template', 'await $`bun test ${path}`;'],
    ['a shell template with a flag between', 'await $`bun --config=./a.toml test ${path}`;'],
    [
      'a stale timeout constant',
      "const LIMIT = 30_000;\nBun.spawn(['bun', 'test', '--timeout', `${LIMIT}`, path]);",
    ],
  ])('reports %s', (_name, source) => {
    expect(inspectScript(source)).toBe(1);
  });

  test.each([
    ['the shared argument in an array', "Bun.spawn(['bun', 'test', TEST_TIMEOUT_ARGUMENT, path]);"],
    ['the shared argument in a template', 'await $`bun test ${TEST_TIMEOUT_ARGUMENT} ${path}`;'],
    ['an unrelated spawn', "Bun.spawn(['bun', 'run', 'build']);"],
    ['a mention in prose', "const note = 'run bun test to see it';"],
  ])('accepts %s', (_name, source) => {
    expect(inspectScript(source)).toBe(0);
  });
});

describe('a loop that waits by counting turns', () => {
  test.each([
    [
      'a for loop with a numeric cap and an early exit',
      'async function f() {\n  for (let i = 0; i < 50; i++) {\n    if (done()) return;\n    await yieldToPortableEventLoop();\n  }\n}',
    ],
    [
      'a while loop with a counter cap',
      'async function f() {\n  let attempt = 0;\n  while (!done() && attempt < 400) {\n    attempt += 1;\n    await Bun.sleep(5);\n  }\n}',
    ],
    [
      'a cap named by an identifier',
      'async function f(maximumAttempts: number) {\n  for (let attempt = 0; attempt < maximumAttempts; attempt++) {\n    if (done()) return;\n    await sleep(1);\n  }\n}',
    ],
    [
      'a cap checked inside the body',
      'async function f() {\n  let attempt = 0;\n  while (true) {\n    if (attempt++ > 100) throw new Error("never");\n    await sleep(5);\n  }\n}',
    ],
    [
      'a constant cap',
      'const LIMIT = 200;\nasync function f() {\n  for (let turn = 0; turn < LIMIT && !done(); turn++) await setImmediateTurn();\n}',
    ],
    [
      'a loop that yields through a helper of any name and then throws',
      'async function pollUntil<T>(check: () => Promise<T | undefined>, what: string, attempts = 600) {\n  for (let attempt = 0; attempt < attempts; attempt += 1) {\n    const value = await check();\n    if (value !== undefined) return value;\n    await nextTurnOfSomething();\n  }\n  throw new Error(`Condition was not met: ${what}`);\n}',
    ],
  ])('reports %s', (_name, source) => {
    expect(inspect(source).filter((rule) => rule === 'iteration-cap-wait')).toEqual([
      'iteration-cap-wait',
    ]);
  });

  test.each([
    [
      'a microtask-only loop, whose turn count belongs to the code',
      'async function f() {\n  for (let i = 0; i < 1000; i++) {\n    if (done()) return;\n    await Promise.resolve();\n  }\n}',
    ],
    [
      'a loop ended by the hang guard',
      'async function f() {\n  for await (const _turn of awakeTurns()) {\n    if (done()) return;\n  }\n}',
    ],
    [
      'a loop with no early exit, which samples a fixed number of turns',
      'async function f() {\n  for (let i = 0; i < 5; i++) await yieldToPortableEventLoop();\n}',
    ],
    [
      'a loop under a load-proof marker',
      'async function f() {\n  // load-proof: the descriptor is held, so it is never released\n  for (let i = 0; i < 3; i++) {\n    if (released()) break;\n    await Bun.sleep(0);\n  }\n}',
    ],
  ])('accepts %s', (_name, source) => {
    expect(inspect(source)).toEqual([]);
  });

  test('rejects a load-proof marker without a reason', () => {
    expect(
      inspect(
        'async function f() {\n  // load-proof: held\n  for (let i = 0; i < 3; i++) {\n    if (released()) break;\n    await Bun.sleep(1);\n  }\n}',
      ),
    ).toEqual(['iteration-cap-wait']);
  });
});

describe('a poll that ends on a wall-clock deadline', () => {
  test.each([
    [
      'a clock in the loop condition',
      'async function f(deadline: number) {\n  while (Date.now() < deadline) {\n    if (done()) return;\n    await Bun.sleep(5);\n  }\n}',
    ],
    [
      'a clock compared inside an if that throws',
      'async function f(deadline: number) {\n  for (;;) {\n    if (done()) return;\n    if (Date.now() > deadline) throw new Error("late");\n    await Bun.sleep(5);\n  }\n}',
    ],
    [
      'performance.now',
      'async function f(start: number, budget: number) {\n  while (performance.now() - start < budget) await Bun.sleep(5);\n}',
    ],
  ])('reports %s', (_name, source) => {
    expect(inspect(source)).toEqual(['wall-clock-poll']);
  });

  test('accepts a loop that reads no clock', () => {
    expect(inspect('async function f() {\n  while (!done()) await Bun.sleep(5);\n}')).toEqual([]);
  });
});

describe('a helper whose default budget is below the hang guard', () => {
  test.each([
    ['a destructured timeout', 'async function wait({ timeoutMs = 2_000 } = {}) {}'],
    [
      'a timeout parameter',
      'async function wait(check: () => boolean, timeoutMilliseconds = 500) {}',
    ],
    ['an attempt cap parameter', 'async function wait(check: () => boolean, attempts = 50) {}'],
    [
      'a hang guard parameter',
      'function spawn(command: string[], hangGuardMilliseconds = 4_500) {}',
    ],
  ])('reports %s', (_name, source) => {
    expect(inspect(source)).toEqual(['wait-budget-default']);
  });

  test.each([
    ['the hang guard', 'async function wait({ timeoutMs = HANG_GUARD_MILLISECONDS } = {}) {}'],
    ['no deadline at all', 'async function wait({ timeoutMs }: { timeoutMs?: number } = {}) {}'],
    ['zero', 'async function wait({ timeoutMs = 0 } = {}) {}'],
    ['a count of one', 'async function wait(check: () => boolean, attempts = 1) {}'],
  ])('accepts %s', (_name, source) => {
    expect(inspect(source)).toEqual([]);
  });
});

describe('a sleep used to let something settle', () => {
  test.each([
    [
      'Bun.sleep',
      "test('a', async () => {\n  start();\n  await Bun.sleep(50);\n  expect(done()).toBe(true);\n});",
    ],
    ['sleep', "it('a', async () => {\n  await sleep(10);\n  expect(1).toBe(1);\n});"],
    [
      'a promise around setTimeout',
      "test('a', async () => {\n  await new Promise((resolve) => setTimeout(resolve, 50));\n  expect(done()).toBe(true);\n});",
    ],
    ['a hook', 'beforeEach(async () => {\n  await Bun.sleep(5);\n});'],
    [
      'the sleep of node:timers/promises',
      "import { setTimeout as pause } from 'node:timers/promises';\ntest('a', async () => {\n  await pause(100);\n  expect(done()).toBe(true);\n});",
    ],
    [
      'Bun.sleep under fake timers, which do not advance it',
      "test('a', async () => {\n  useFakeTimers();\n  await Bun.sleep(50);\n  expect(done()).toBe(true);\n});",
    ],
    [
      'Bun.sleep beside manual runtime services, which leave the real clock alone',
      "test('a', async () => {\n  const runtime = createManualRuntimeServices({});\n  start(runtime);\n  await Bun.sleep(50);\n  expect(done()).toBe(true);\n});",
    ],
    [
      'the real-timer test helper',
      "test('a', async () => {\n  await waitForRealTimersForTesting(50);\n  expect(done()).toBe(true);\n});",
    ],
    [
      'a promise around a wrapped setTimeout callback',
      "test('a', async () => {\n  await new Promise((resolve) => setTimeout(() => resolve(1), 50));\n  expect(done()).toBe(true);\n});",
    ],
  ])('reports %s in a test body', (_name, source) => {
    expect(inspect(source)).toEqual(['sleep-synchronization']);
  });

  test.each([
    [
      'quietFor, which names a negative window',
      "test('a', async () => {\n  await quietFor(50);\n});",
    ],
    ['a zero delay', "test('a', async () => {\n  await Bun.sleep(0);\n});"],
    [
      'a sleep inside a polling loop',
      "test('a', async () => {\n  while (!done()) await Bun.sleep(5);\n});",
    ],
    ['a sleep in a helper', 'async function settle() {\n  await Bun.sleep(50);\n}'],
    [
      'a promise around setTimeout under fake timers, which advance it',
      "test('a', async () => {\n  useFakeTimers();\n  await new Promise((resolve) => setTimeout(resolve, 50));\n  expect(done()).toBe(true);\n});",
    ],
    [
      'a pause that checks nothing afterwards',
      "test('a', async () => {\n  ws.close();\n  await Bun.sleep(50);\n});",
    ],
    ['a pause in a teardown hook', 'afterEach(async () => {\n  await Bun.sleep(50);\n});'],
    [
      'a sleep the injected services own',
      "test('a', async () => {\n  const { sleep } = createManualRuntimeServices();\n  await sleep(50);\n  expect(done()).toBe(true);\n});",
    ],
    [
      'a member call on the injected runtime',
      "test('a', async () => {\n  const runtime = createManualRuntimeServices();\n  await runtime.sleep(50);\n  expect(done()).toBe(true);\n});",
    ],
    [
      'a sleep under a load-proof marker',
      "test('a', async () => {\n  // load-proof: the test asserts only a lower bound on the elapsed time\n  await Bun.sleep(50);\n});",
    ],
  ])('accepts %s', (_name, source) => {
    expect(inspect(source)).toEqual([]);
  });
});

describe('a timer that rejects after a short delay', () => {
  test.each([
    [
      'setTimeout calling reject',
      "const p = new Promise((resolve, reject) => {\n  setTimeout(() => reject(new Error('t')), 3_000);\n});",
    ],
    ['setTimeout throwing', "setTimeout(() => {\n  throw new Error('late');\n}, 500);"],
    ['AbortSignal.timeout', 'const signal = AbortSignal.timeout(5_000);'],
  ])('reports %s', (_name, source) => {
    expect(inspect(source)).toEqual(['timer-rejection']);
  });

  test.each([
    [
      'a delay at the hang guard',
      "setTimeout(() => reject(new Error('t')), HANG_GUARD_MILLISECONDS);",
    ],
    ['a callback that does not reject', 'setTimeout(() => resolve(1), 500);'],
    [
      'a stand-in under a load-proof marker',
      "// load-proof: a double that fails after a delay, which nothing waits out as a deadline\nsetTimeout(() => reject(new Error('t')), 30);",
    ],
  ])('accepts %s', (_name, source) => {
    expect(inspect(source)).toEqual([]);
  });
});

describe('work raced against a timer', () => {
  test('reports Promise.race against sleep', () => {
    expect(inspect('await Promise.race([work, sleep(3000)]);')).toEqual(['timer-race']);
  });

  test('reports Promise.race against a promise around setTimeout', () => {
    expect(
      inspect('await Promise.race([work, new Promise((resolve) => setTimeout(resolve, 3000))]);'),
    ).toEqual(['timer-race']);
  });

  test.each([
    [
      'a sleep chained into a label',
      "await Promise.race([p, Bun.sleep(1000).then(() => 'TIMEOUT')]);",
    ],
    [
      'a timer promise that resolves',
      'await Promise.race([p, new Promise((resolve) => setTimeout(() => resolve(false), 250))]);',
    ],
    [
      'a timer promise that rejects through a renamed parameter',
      "await Promise.race([p, new Promise((_, fail) => setTimeout(() => fail(new Error('t')), 500))]);",
    ],
    [
      'a timer held in a constant',
      'const timeout = sleep(1000);\nawait Promise.race([p, timeout]);',
    ],
    [
      'the promise sleep of node:timers/promises',
      "import { setTimeout as delayFor } from 'node:timers/promises';\nawait Promise.race([p, delayFor(500)]);",
    ],
    [
      'a race beside manual runtime services, which leave the real clock alone',
      'const runtime = createManualRuntimeServices({});\nawait Promise.race([p, Bun.sleep(250)]);',
    ],
    ['Promise.any', 'await Promise.any([p, sleep(500)]);'],
  ])('reports %s', (_name, source) => {
    expect(inspect(source)).toContain('timer-race');
  });

  test('reports a promise that also resolves on a timeout', () => {
    expect(
      inspect(
        "test('a', async () => {\n  const opened = await new Promise((resolve) => {\n    ws.on('open', () => resolve(true));\n    setTimeout(() => resolve(false), 2000);\n  });\n});",
      ),
    ).toContain('timer-race');
  });

  test.each([
    ['a zero delay, a single turn', 'await Promise.race([write, Bun.sleep(0)]);'],
    ['a sleep through an injected clock', 'await Promise.race([work, runtime.sleep(500)]);'],
    ['two pieces of work', 'await Promise.race([first, second]);'],
    [
      'a race that checks the work is still pending',
      '// load-proof: the promise waits on a resolver that never arrives, so load only keeps it pending\nawait Promise.race([work, sleep(20)]);',
    ],
  ])('accepts %s', (_name, source) => {
    expect(inspect(source)).toEqual([]);
  });
});

describe('a quiet window placed before an assertion that something happened', () => {
  test.each([
    [
      'toBe(true)',
      "test('a', async () => {\n  start();\n  await quietFor(100);\n  expect(done()).toBe(true);\n});",
    ],
    [
      'toContain',
      "test('a', async () => {\n  start();\n  await quietFor(100);\n  expect(seen).toContain('x');\n});",
    ],
    [
      'toBeDefined',
      "test('a', async () => {\n  start();\n  await quietFor(100);\n  expect(value).toBeDefined();\n});",
    ],
  ])('reports %s', (_name, source) => {
    expect(inspect(source)).toEqual(['quiet-window']);
  });

  test.each([
    [
      'an absence',
      "test('a', async () => {\n  await quietFor(100);\n  expect(seen).toEqual([]);\n});",
    ],
    [
      'a count that did not grow',
      "test('a', async () => {\n  await quietFor(100);\n  expect(calls).toHaveLength(1);\n});",
    ],
    [
      'a negated matcher',
      "test('a', async () => {\n  await quietFor(100);\n  expect(spy).not.toHaveBeenCalled();\n});",
    ],
    [
      'a boolean that stays false',
      "test('a', async () => {\n  await quietFor(100);\n  expect(settled).toBe(false);\n});",
    ],
    [
      'a window under a load-proof marker',
      "test('a', async () => {\n  // load-proof: focus must stay put; a slow host can only delay a move\n  await quietFor(100);\n  expect(focused).toBe(true);\n});",
    ],
  ])('accepts %s', (_name, source) => {
    expect(inspect(source)).toEqual([]);
  });
});

describe('a wait helper imported under the name waitFor', () => {
  test("is read for its timeoutMs budget as well as Testing Library's timeout", () => {
    expect(
      inspect("test('a', async () => {\n  await waitFor(() => ready, { timeoutMs: 1000 });\n});"),
    ).toEqual(['wait-budget']);
  });
});

describe('a budget handed to a wait helper by position', () => {
  const helper =
    'async function waitForMessage(ws: unknown, matches: unknown, timeoutMs = 120_000) {}\n';

  test.each([
    ['a function declaration', `${helper}await waitForMessage(ws, matches, 1_000);`],
    [
      'an arrow function',
      'const waitForLine = (lines, matches, timeoutMs) => {};\nawait waitForLine(lines, matches, 200);',
    ],
    [
      'a constant budget',
      `${helper}const WINDOW = 500;\nawait waitForMessage(ws, matches, WINDOW);`,
    ],
  ])('reports %s', (_name, source) => {
    expect(inspect(source)).toContain('wait-budget');
  });

  test.each([
    ['no budget, so the default applies', `${helper}await waitForMessage(ws, matches);`],
    ['the hang guard', `${helper}await waitForMessage(ws, matches, HANG_GUARD_MILLISECONDS);`],
    [
      'a window that must pass without a match, under a load-proof marker',
      `${helper}// load-proof: nothing may arrive after the unsubscribe, and a loaded host can only delay it\nawait waitForMessage(ws, matches, 200);`,
    ],
    [
      'a self-test of the helper, under its marker',
      `${helper}// hang-guard-self-test: nothing ever matches, so no load can satisfy the wait before it gives up\nawait waitForMessage(ws, () => false, 10);`,
    ],
    [
      'a helper whose name is not a wait',
      'function shiftBy(value: number, offsetMs: number) {}\nshiftBy(1, 10);',
    ],
  ])('accepts %s', (_name, source) => {
    expect(inspect(source)).toEqual([]);
  });

  test('reads a helper declared in another file through the shared table', () => {
    const declaring = ts.createSourceFile(
      'support.test-support.ts',
      'export function waitForFrames(ws, count, timeoutMs) {}',
      ts.ScriptTarget.Latest,
      true,
    );
    const calling = ts.createSourceFile(
      'use.test.ts',
      'await waitForFrames(ws, 2, 750);',
      ts.ScriptTarget.Latest,
      true,
    );

    expect(
      findDeadlineViolations(calling, collectPositionalBudgets(declaring)).map(
        (violation) => violation.rule,
      ),
    ).toEqual(['wait-budget']);
  });
});

describe('a single-turn yield used to let real work finish', () => {
  test.each([
    [
      'sleepForTesting before an assertion that something happened',
      "test('a', async () => {\n  start();\n  await sleepForTesting(10);\n  expect(worker.postMessage).toHaveBeenCalled();\n});",
    ],
    [
      'sleepForTesting before an action, which no assertion reads',
      "test('a', async () => {\n  start();\n  await sleepForTesting(10);\n  socket.send('go');\n});",
    ],
    [
      'sleepForTesting in a setup hook',
      'beforeEach(async () => {\n  start();\n  await sleepForTesting(10);\n});',
    ],
    [
      'a setImmediate promise',
      "test('a', async () => {\n  start();\n  await new Promise((resolve) => setImmediate(resolve));\n  socket.send('go');\n});",
    ],
    [
      'a zero-delay setTimeout promise',
      "test('a', async () => {\n  start();\n  await new Promise<void>((resolve) => setTimeout(resolve, 0));\n  socket.send('go');\n});",
    ],
    [
      'Bun.sleep(0)',
      "test('a', async () => {\n  start();\n  await Bun.sleep(0);\n  socket.send('go');\n});",
    ],
    [
      'a same-file helper, at its definition',
      "const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));\ntest('a', async () => {\n  await settle();\n  socket.send('go');\n});",
    ],
    [
      'an exported helper whose body awaits the yield',
      'export async function flush(): Promise<void> {\n  await sleepForTesting(10);\n}',
    ],
  ])('reports %s', (_name, source) => {
    expect(inspect(source)).toEqual(['single-turn-settle']);
  });

  test.each([
    [
      'an assertion of absence after a marked window',
      "test('a', async () => {\n  // load-proof: microtask-only work, nothing real to wait for here\n  await sleepForTesting(10);\n  expect(calls).toEqual([]);\n});",
    ],
    [
      'fake timers, which advance it',
      "test('a', async () => {\n  useFakeTimers();\n  await sleepForTesting(10);\n  socket.send('go');\n});",
    ],
    [
      'a microtask drain, sleepForTesting(0)',
      "test('a', async () => {\n  await sleepForTesting(0);\n  socket.send('go');\n});",
    ],
    [
      'the last statement of a test',
      "test('a', async () => {\n  start();\n  await sleepForTesting(10);\n});",
    ],
    [
      'a teardown hook',
      'afterEach(async () => {\n  server.stop();\n  await sleepForTesting(10);\n  cleanup();\n});',
    ],
    [
      'a poll loop, which the loop rules read',
      "test('a', async () => {\n  while (!ready()) {\n    await sleepForTesting(10);\n  }\n  socket.send('go');\n});",
    ],
    [
      'a race, which timer-race reads',
      "test('a', async () => {\n  await Promise.race([work(), new Promise((resolve) => setTimeout(resolve, 0))]);\n  socket.send('go');\n});",
    ],
    [
      'a real wait of more than a turn, which the sleep rule reads',
      "test('a', async () => {\n  const pending = work();\n  await Bun.sleep(5_000);\n  await pending;\n});",
    ],
    [
      'a following wait',
      "test('a', async () => {\n  // load-proof: only orders the wait below, which carries the assertion\n  await sleepForTesting(10);\n  await waitFor(ready);\n  expect(done()).toBe(true);\n});",
    ],
  ])('accepts %s', (_name, source) => {
    expect(inspect(source)).toEqual([]);
  });

  test('reads a marker on the exact statement only', () => {
    expect(
      inspect(
        "test('a', async () => {\n  // load-proof: microtask-only work, nothing real to wait for here\n  await sleepForTesting(10);\n  await sleepForTesting(10);\n  socket.send('go');\n});",
      ),
    ).toEqual(['single-turn-settle']);
  });
});

describe('an exported one-turn yield helper, resolved through the file imports', () => {
  const IMPORT_EVENT_LOOP = "import { yieldToEventLoop } from './fake-timers.test-support.ts';\n";

  test.each([
    [
      'yieldToEventLoop before a positive assertion',
      `${IMPORT_EVENT_LOOP}test('a', async () => {\n  start();\n  await yieldToEventLoop();\n  expect(done()).toBe(true);\n});`,
    ],
    [
      'yieldToPortableEventLoop before an action',
      "import { yieldToPortableEventLoop } from '@lostgradient/weft';\ntest('a', async () => {\n  await yieldToPortableEventLoop();\n  go();\n});",
    ],
    [
      'yieldEventLoopTurn before an action',
      "import { yieldEventLoopTurn } from '@lostgradient/testing/wait-until';\ntest('a', async () => {\n  await yieldEventLoopTurn();\n  go();\n});",
    ],
    [
      'a call under another local name',
      "import { yieldToEventLoop as turn } from './fake-timers.test-support.ts';\ntest('a', async () => {\n  await turn();\n  expect(done()).toBe(true);\n});",
    ],
    [
      'a member of a namespace import',
      "import * as loop from './fake-timers.test-support.ts';\ntest('a', async () => {\n  await loop.yieldToEventLoop();\n  expect(done()).toBe(true);\n});",
    ],
    [
      'a call in a before hook',
      `${IMPORT_EVENT_LOOP}beforeEach(async () => {\n  await yieldToEventLoop();\n  go();\n});`,
    ],
    [
      'a call in a helper another test calls',
      `${IMPORT_EVENT_LOOP}async function settle() {\n  await yieldToEventLoop();\n  go();\n}`,
    ],
  ])('reports %s', (_name, source) => {
    expect(inspect(source)).toEqual(['single-turn-settle']);
  });

  test.each([
    [
      'a marked call',
      `${IMPORT_EVENT_LOOP}test('a', async () => {\n  // load-proof: only microtasks are pending after the awaited start\n  await yieldToEventLoop();\n  go();\n});`,
    ],
    [
      'a poll loop',
      `${IMPORT_EVENT_LOOP}test('a', async () => {\n  while (!ready()) await yieldToEventLoop();\n  go();\n});`,
    ],
    [
      'fake timers',
      `${IMPORT_EVENT_LOOP}test('a', async () => {\n  jest.useFakeTimers();\n  await yieldToEventLoop();\n  go();\n});`,
    ],
    [
      'the last statement of a test',
      `${IMPORT_EVENT_LOOP}test('a', async () => {\n  go();\n  await yieldToEventLoop();\n});`,
    ],
    [
      'a teardown hook',
      `${IMPORT_EVENT_LOOP}afterEach(async () => {\n  await yieldToEventLoop();\n});`,
    ],
    [
      'another helper',
      "import { settleInlineLaunches } from './settle.test-support.ts';\ntest('a', async () => {\n  await settleInlineLaunches();\n  go();\n});",
    ],
    [
      'a name the file does not import',
      "test('a', async () => {\n  await yieldToEventLoop();\n  go();\n});",
    ],
    [
      'a member of an object that is not a namespace import',
      `test('a', async () => {\n  await engine.yieldToEventLoop();\n  go();\n});`,
    ],
  ])('does not report %s', (_name, source) => {
    expect(inspect(source)).toEqual([]);
  });

  test.each([
    [
      'a chained action',
      "import { yieldToPortableEventLoop } from '@lostgradient/weft';\ntest('a', async () => {\n  void yieldToPortableEventLoop().then(() => controller.abort('x'));\n  await run();\n});",
    ],
    [
      'a chained action on a same-file timer promise',
      "test('a', async () => {\n  void new Promise((r) => setTimeout(r, 0)).then(() => controller.abort('x'));\n  await run();\n});",
    ],
  ])('reports %s that is not awaited', (_name, source) => {
    expect(inspect(source)).toEqual(['single-turn-settle']);
  });

  test('accepts a marked chained action and a chain on something else', () => {
    expect(
      inspect(
        "import { yieldToPortableEventLoop } from '@lostgradient/weft';\ntest('a', async () => {\n  // load-proof: the action only closes a handle nothing is waiting on\n  void yieldToPortableEventLoop().then(() => handle.close());\n  void other().then(() => handle.close());\n  await run();\n});",
      ),
    ).toEqual([]);
  });

  test('a message-port yield is a real turn even under fake timers', () => {
    expect(
      inspect(
        "import { yieldToPortableEventLoop } from '@lostgradient/weft';\ntest('a', async () => {\n  jest.useFakeTimers();\n  await yieldToPortableEventLoop();\n  go();\n});",
      ),
    ).toEqual(['single-turn-settle']);
  });

  test('a marker covers only the call directly below it', () => {
    expect(
      inspect(
        `${IMPORT_EVENT_LOOP}test('a', async () => {\n  // load-proof: only microtasks are pending after the awaited start\n  await yieldToEventLoop();\n  await yieldToEventLoop();\n  go();\n});`,
      ),
    ).toEqual(['single-turn-settle']);
  });

  test('the old per-file allowlist is gone', () => {
    expect(existsSync(new URL('./single-turn-yield-allowlist.json', import.meta.url))).toBe(false);
  });
});

describe('a sleep that is handed its clock', () => {
  test('is an injected timer, not a real single-turn yield', () => {
    expect(
      inspect(
        "test('a', async () => {\n  const pending = sleep(0, runtime.timers);\n  await runtime.advance(0);\n  await pending;\n  expect(done()).toBe(true);\n});",
      ),
    ).toEqual([]);
  });
});

describe('a timer double that fires on a real zero-delay timer', () => {
  test('is reported, because a test that waits to be asked races the callback', () => {
    expect(
      inspect(
        'const timers = {\n  setTimeout: (callback: () => void, ms?: number) => {\n    requested.push(ms ?? 0);\n    return setTimeout(callback, 0);\n  },\n};',
      ),
    ).toEqual(['real-timer-double']);
  });

  test('is reported when it takes only the callback', () => {
    expect(
      inspect(
        'const timers = {\n  setTimeout: (callback: () => void) => setTimeout(callback, 0),\n};',
      ),
    ).toEqual(['real-timer-double']);
  });

  test.each([
    [
      'a marked double',
      'const timers = {\n  // load-proof: tests wait for the pending set to empty, not for the ask\n  setTimeout: (callback: () => void, ms?: number) => setTimeout(callback, 0),\n};',
    ],
    [
      'a double that forwards to a manual runtime',
      'const timers = {\n  setTimeout: (callback: () => void, ms?: number) => runtime.timers.setTimeout(callback, 0),\n};',
    ],
    [
      'a promise executor',
      'const turn = new Promise((resolve, reject) => setTimeout(resolve, 0));',
    ],
    [
      'a real delay',
      'const timers = {\n  setTimeout: (callback: () => void, ms?: number) => setTimeout(callback, ms),\n};',
    ],
  ])('accepts %s', (_name, source) => {
    expect(inspect(source)).toEqual([]);
  });
});

describe('a Bun child started outside the hang guard', () => {
  test.each([
    ['Bun.spawn', "Bun.spawn([process.execPath, 'script.ts']);"],
    ['Bun.spawnSync', "Bun.spawnSync(['bun', 'script.ts']);"],
    [
      'child_process spawn',
      "import { spawn } from 'node:child_process';\nspawn(process.execPath, ['a.ts']);",
    ],
    ['an options object with cmd', "Bun.spawn({ cmd: [process.execPath, 'script.ts'] });"],
    [
      'a command held in a variable',
      "const command = [process.execPath, 'script.ts'];\nBun.spawn(command, { stdout: 'pipe' });",
    ],
    [
      'a cmd held in a variable inside options',
      "const cmd = ['bun', 'script.ts'];\nBun.spawnSync({ cmd });",
    ],
    ['Bun Shell', 'await Bun.$`bun script.ts`;'],
    ['Bun Shell with the executable path', 'await $`${process.execPath} script.ts`;'],
  ])('is reported for %s', (_name, source) => {
    expect(inspect(source)).toEqual(['direct-bun-spawn']);
  });

  test.each([
    [
      'a call that passes --no-install',
      "Bun.spawn([process.execPath, '--no-install', 'script.ts']);",
    ],
    ['the guarded spawn', "spawnWithHangGuard([process.execPath, 'script.ts']);"],
    ['a command that is not Bun', "Bun.spawn(['git', 'status']);"],
    [
      'a variable command that passes --no-install',
      "const command = [process.execPath, '--no-install', 'script.ts'];\nBun.spawn(command);",
    ],
    [
      'an options object that passes --no-install',
      "Bun.spawn({ cmd: ['bun', '--no-install', 'a.ts'] });",
    ],
    ['Bun Shell that passes --no-install', 'await Bun.$`bun --no-install script.ts`;'],
    ['Bun Shell that is not Bun', 'await Bun.$`git status`;'],
    [
      'a marked call',
      "// load-proof: only runs the package manager, which installs on purpose\nBun.spawn([process.execPath, 'install']);",
    ],
  ])('accepts %s', (_name, source) => {
    expect(inspect(source)).toEqual([]);
  });
});

describe('an allowlist ratchet against origin/main', () => {
  test('refuses a count above the baseline and a new file, and allows equal or lower', () => {
    const baseline = { 'a.test.ts': 3, 'b.test.ts': 1 };
    expect(allowlistRaises('x', { 'a.test.ts': 3, 'b.test.ts': 0 }, baseline)).toEqual([]);
    expect(allowlistRaises('x', { 'a.test.ts': 4 }, baseline)).toHaveLength(1);
    expect(allowlistRaises('x', { 'c.test.ts': 1 }, baseline)).toHaveLength(1);
  });

  test('refuses nothing without a baseline', () => {
    expect(allowlistRaises('x', { 'a.test.ts': 9 }, null)).toEqual([]);
  });
});
