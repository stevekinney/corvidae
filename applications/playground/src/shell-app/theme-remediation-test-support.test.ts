/**
 * The warm-up helper's guards (COR-1571): a warm-up that collects nothing, and a scenario
 * declared after the warm-up ran, must fail loudly instead of leaving the tests cold.
 */

import { describe, expect, test } from 'bun:test';

import { warmedTests, type ScenarioRegistrar } from './theme-remediation-test-support.ts';

/** A registrar that records what would have been registered, so no real test is declared. */
function recordingRegistrar() {
  const registered: string[] = [];
  const registrar: ScenarioRegistrar = {
    describe(name, define) {
      registered.push(`describe:${name}`);
      define();
    },
    test(name) {
      registered.push(`test:${name}`);
    },
  };
  return { registered, registrar };
}

describe('warmedTests', () => {
  test('warms every body collected by a group once, then registers them under a describe', async () => {
    const { registered, registrar } = recordingRegistrar();
    const events: string[] = [];
    const { group, scenario, warmScenarios } = warmedTests(
      { before: () => events.push('before'), after: () => events.push('after') },
      registrar,
    );
    group('a group', () => {
      scenario('first', async () => void events.push('first'));
      scenario('second', async () => void events.push('second'));
    });
    expect(events).toEqual([]);
    await warmScenarios();
    expect(events).toEqual(['before', 'first', 'after', 'before', 'second', 'after']);
    expect(registered).toEqual(['describe:a group', 'test:first', 'test:second']);
  });

  test('a warm-up that collected nothing throws', async () => {
    const { registrar } = recordingRegistrar();
    const { warmScenarios } = warmedTests({}, registrar);
    expect(
      await warmScenarios().then(
        () => null,
        (error: Error) => error.message,
      ),
    ).toContain('found no scenarios to warm');
  });

  test('a scenario declared after the warm-up ran throws instead of staying cold', async () => {
    const { registrar } = recordingRegistrar();
    const { group, scenario, warmScenarios } = warmedTests({}, registrar);
    group('early', () => scenario('early scenario', async () => {}));
    await warmScenarios();
    // This is what a scenario inside a plain `describe` does: Bun runs the callback later.
    expect(() => scenario('late scenario', async () => {})).toThrow(
      'declared after warmScenarios()',
    );
  });

  test('a failing body is left for the registered test and does not stop the warm-up', async () => {
    const { registrar } = recordingRegistrar();
    const warmed: string[] = [];
    const { group, scenario, warmScenarios } = warmedTests({}, registrar);
    group('g', () => {
      scenario('fails', async () => {
        throw new Error('boom');
      });
      scenario('runs', async () => void warmed.push('runs'));
    });
    await warmScenarios();
    expect(warmed).toEqual(['runs']);
  });

  test('a group declared inside another group throws', () => {
    const { registrar } = recordingRegistrar();
    const { group, scenario } = warmedTests({}, registrar);
    expect(() =>
      group('outer', () => {
        scenario('before', async () => {});
        group('inner', () => {});
      }),
    ).toThrow('Groups do not nest');
    // The failed outer group leaves the helper usable.
    expect(() => group('next', () => {})).not.toThrow();
  });

  test('a plain test or test.each inside a group throws, and outside one it registers', () => {
    const { registered, registrar } = recordingRegistrar();
    const { group, test: guarded } = warmedTests({}, registrar);
    expect(() => group('g', () => guarded('stray', async () => {}))).toThrow(
      'test() was called inside group()',
    );
    expect(() => group('g', () => guarded.each([1])('stray %s', async () => {}))).toThrow(
      'test.each() was called inside group()',
    );
    guarded('plain', async () => {});
    expect(registered).toEqual(['test:plain']);
  });
});
