import { describe, expect, test } from 'bun:test';
import {
  createScenarios,
  lateRegistrationMessage,
  type ScenarioRegistrar,
} from './scenario.test-support.ts';

/** Records what a scenario set registers instead of handing it to Bun, and spawns nothing. */
function recordingRegistrar() {
  const registered: string[] = [];
  const registrar: ScenarioRegistrar = {
    test: (name) => void registered.push(name),
    describe: (name, body) => {
      registered.push(`describe ${name}`);
      body();
    },
  };
  return { registered, registrar };
}

describe('createScenarios', () => {
  test('runs a scenario at registration and registers its test', async () => {
    const { registered, registrar } = recordingRegistrar();
    const scenarios = createScenarios({}, registrar);
    const ran: string[] = [];
    scenarios.scenario('first', () => ran.push('first'));
    scenarios.scenario('second', () => ran.push('second'));
    await scenarios.settled();
    expect(ran).toEqual(['first', 'second']);
    expect(registered).toEqual(['first', 'second']);
  });

  test('refuses a scenario registered after settled() was called, naming the rule', async () => {
    const { registrar } = recordingRegistrar();
    const scenarios = createScenarios({}, registrar);
    scenarios.scenario('early', () => undefined);
    await scenarios.settled();
    let ran = false;
    expect(() =>
      scenarios.scenario('late', () => {
        ran = true;
      }),
    ).toThrow(lateRegistrationMessage('late'));
    expect(lateRegistrationMessage('late')).toContain('module scope');
    expect(lateRegistrationMessage('late')).toContain('describe');
    expect(ran).toBe(false);
  });

  test('refuses a scenario registered from a callback that runs after settled()', async () => {
    // The shape of the defect: Bun invokes a `describe` callback after module evaluation.
    const { registrar } = recordingRegistrar();
    const scenarios = createScenarios({}, registrar);
    const lateDescribe = () => scenarios.scenario('inside describe', () => undefined);
    await scenarios.settled();
    expect(lateDescribe).toThrow('registered after settled()');
  });

  test('scenarios.describe starts its scenarios now and registers tests inside the describe', async () => {
    const { registered, registrar } = recordingRegistrar();
    const scenarios = createScenarios({}, registrar);
    const ran: string[] = [];
    scenarios.describe('group', () => {
      scenarios.scenario('inner', () => ran.push('inner'));
      scenarios.describe('nested', () => {
        scenarios.scenario('deep', () => ran.push('deep'));
      });
    });
    scenarios.scenario('outer', () => ran.push('outer'));
    await scenarios.settled();
    expect(ran).toEqual(['inner', 'deep', 'outer']);
    expect(registered).toEqual(['describe group', 'inner', 'describe nested', 'deep', 'outer']);
  });

  test('a failing scenario fails only its own test and later scenarios still run', async () => {
    const { registrar } = recordingRegistrar();
    const registeredBodies: Array<() => Promise<void>> = [];
    const scenarios = createScenarios(
      {},
      { ...registrar, test: (_name, body) => void registeredBodies.push(body) },
    );
    scenarios.scenario('fails', () => {
      throw new Error('boom');
    });
    scenarios.scenario('passes', () => undefined);
    await scenarios.settled();
    const failure = await registeredBodies[0]!().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((failure as Error).message).toBe('boom');
    await registeredBodies[1]!();
  });

  test('brackets every scenario with setUp and tearDown, even when it throws', async () => {
    const { registrar } = recordingRegistrar();
    const events: string[] = [];
    const scenarios = createScenarios(
      {
        setUp: () => void events.push('up'),
        tearDown: () => void events.push('down'),
      },
      registrar,
    );
    scenarios.scenario('a', () => void events.push('a'));
    scenarios.scenario('b', () => {
      events.push('b');
      throw new Error('x');
    });
    await scenarios.settled();
    expect(events).toEqual(['up', 'a', 'down', 'up', 'b', 'down']);
  });
});
