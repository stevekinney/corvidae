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
