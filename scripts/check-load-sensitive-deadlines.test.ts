import { describe, expect, test } from 'bun:test';
import ts from 'typescript';
import {
  findDeadlineViolations,
  findPackageScriptViolations,
  findTestRunnerSpawnViolations,
} from './check-load-sensitive-deadlines.ts';
import { HANG_GUARD_MILLISECONDS } from './hang-guard.ts';

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
  ])('reports %s', (_name, source) => {
    expect(inspect(source)).toEqual(['iteration-cap-wait']);
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
      "test('a', async () => {\n  await new Promise((resolve) => setTimeout(resolve, 50));\n});",
    ],
    ['a hook', 'beforeEach(async () => {\n  await Bun.sleep(5);\n});'],
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
      'a sleep under fake timers',
      "test('a', async () => {\n  useFakeTimers();\n  await Bun.sleep(50);\n});",
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
    ['a zero delay, a single turn', 'await Promise.race([write, Bun.sleep(0)]);'],
    ['two pieces of work', 'await Promise.race([first, second]);'],
    [
      'a race that checks the work is still pending',
      '// load-proof: the promise waits on a resolver that never arrives, so load only keeps it pending\nawait Promise.race([work, sleep(20)]);',
    ],
  ])('accepts %s', (_name, source) => {
    expect(inspect(source)).toEqual([]);
  });
});
