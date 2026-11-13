import {
  type BackendDescriptor,
  createModelCatalog,
  type DecisionKind,
  type DecisionModel,
} from '@lostgradient/operative';
import type { DecisionScenario } from '@lostgradient/operative/decision-testing';
import { describe, expect, test } from 'bun:test';

import type { PluginInterceptor } from '../contributions.ts';
import { definePlugin } from '../define-plugin.ts';
import { PLUGIN_CONTRACT_UNCHECKED_HOOK_POINTS } from './hook-observation.ts';
import {
  checkPluginContract,
  type CreatePluginTestHost,
  type PluginDecisionModelRequest,
  type PluginTestHost,
  type PluginTestHostListing,
} from './plugin-contract.ts';

const plugin = definePlugin({
  name: 'example',
  version: '1.0.0',
  description: 'An example plugin.',
});

/** A host double that reports `listing` and records that it was disposed. */
function hostReporting(
  listing: PluginTestHostListing | undefined,
  agents: readonly {
    id: string;
    state: 'ready' | 'invalid';
    plugin?: string;
    problem?: { code: string; message: string };
  }[] = [],
) {
  const state = { disposed: 0 };
  const createHost: CreatePluginTestHost = async () => ({
    plugins: {
      list: async () => (listing === undefined ? [] : [listing]),
      ready: async () => {},
    },
    agents: { list: () => agents },
    scriptedRun: async () => ({ finishReason: 'stop-condition' }),
    dispose: async () => {
      state.disposed += 1;
    },
  });
  return { createHost, state };
}

const running: PluginTestHostListing = {
  descriptor: { name: 'example' },
  status: 'running',
  problems: [],
};

describe('checkPluginContract', () => {
  test('passes a plugin the host runs without problems, and disposes the host', async () => {
    const { createHost, state } = hostReporting(running);
    expect(await checkPluginContract(plugin, { createHost })).toEqual([]);
    expect(state.disposed).toBe(1);
  });

  test('fails a plugin with an unresolved reference, naming the file and the id', async () => {
    const { createHost } = hostReporting({
      ...running,
      problems: [
        { code: 'reference-unresolved', file: 'example:triager', id: 'example:absent' },
      ] as never,
    });
    const failures = await checkPluginContract(plugin, { createHost });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.check).toBe('reports no problems');
    expect(failures[0]?.message).toContain('reference-unresolved');
    expect(failures[0]?.message).toContain('example:absent');
  });

  test('fails a plugin whose shipped agent is invalid, but not one another plugin ships', async () => {
    const invalid = {
      id: 'example:triager',
      state: 'invalid',
      plugin: 'example',
      problem: { code: 'invalid-frontmatter', message: 'model must be a string' },
    } as const;
    const { createHost } = hostReporting(running, [
      invalid,
      { ...invalid, id: 'other:triager', plugin: 'other' },
      { id: 'example:ready', state: 'ready', plugin: 'example' },
    ]);
    const failures = await checkPluginContract(plugin, { createHost });
    expect(failures).toEqual([
      {
        check: 'ships only valid agent files',
        message:
          'The agent "example:triager" is invalid: invalid-frontmatter (model must be a string).',
      },
    ]);
  });

  test('leaves an unresolved reference to the check that names it', async () => {
    const { createHost } = hostReporting(running, [
      {
        id: 'example:triager',
        state: 'invalid',
        plugin: 'example',
        problem: { code: 'reference-unresolved', message: 'absent' },
      },
    ]);
    expect(await checkPluginContract(plugin, { createHost })).toEqual([]);
  });

  test('fails a plugin the host does not run', async () => {
    const { createHost } = hostReporting({ ...running, status: 'skipped' });
    const failures = await checkPluginContract(plugin, { createHost });
    expect(failures.map(({ check }) => check)).toEqual(['loads into a host and runs']);
  });

  test('fails when the host does not list the plugin', async () => {
    const { createHost } = hostReporting(undefined);
    const failures = await checkPluginContract(plugin, { createHost });
    expect(failures.map(({ check }) => check)).toEqual([
      'loads into a host and runs',
      'reports no problems',
    ]);
  });

  test('reports a host that cannot start as a failure instead of throwing', async () => {
    const createHost: CreatePluginTestHost = async () => {
      throw new Error('no storage');
    };
    const failures = await checkPluginContract(plugin, { createHost });
    expect(failures.map(({ message }) => message)).toEqual([
      'no storage',
      'no storage',
      'no storage',
    ]);
  });
});

/** The check that runs each declared hook point, whose name the failures below are read by. */
const HOOK_CHECK = 'runs every declared hook point without throwing';

/** A plugin with no secret whose one interceptor declares `onStep` (and, when given, `onRunAbort`). */
function pluginWithInterceptor(interceptor: Partial<PluginInterceptor>) {
  return definePlugin({
    name: 'example',
    version: '1.0.0',
    description: 'An example plugin.',
    setup: () => ({ interceptors: [{ name: 'audit', ...interceptor }] }),
  });
}

/**
 * A host double whose scripted run calls every handler of the interceptors the observed plugin
 * contributes at the point the scenario reaches, as the real host's run would, and counts the runs.
 */
function hostRunningHooks(runs: string[]): CreatePluginTestHost {
  return async (descriptor) => {
    const host: PluginTestHost = {
      plugins: {
        list: async () => [running],
        ready: async () => {},
      },
      agents: { list: () => [] },
      scriptedRun: async ({ scenario }) => {
        runs.push(scenario);
        const contributions = await descriptor.setup?.({
          configuration: undefined,
          secrets: { get: async () => undefined },
          storage: undefined as never,
          host: undefined as never,
          approvals: () => ({}),
        });
        const [onStep] = (contributions?.interceptors ?? []).map(({ onStep: hook }) => hook);
        const handler = typeof onStep === 'function' ? onStep : onStep?.handler;
        // A throw fails the run, as it does in a Bureau; the observed handler has recorded it.
        if (scenario === 'answer') {
          try {
            await handler?.({} as never);
          } catch {
            return { finishReason: 'error' };
          }
        }
        return { finishReason: 'stop-condition' };
      },
      dispose: async () => {},
    };
    return host;
  };
}

describe('the hook points the contract runs', () => {
  test('runs one scripted run for each declared point it can reach, and passes a hook that returns', async () => {
    const runs: string[] = [];
    const conforming = pluginWithInterceptor({
      onStep: { handler: async () => {}, replay: 'safe' },
    });
    const failures = await checkPluginContract(conforming, { createHost: hostRunningHooks(runs) });
    expect(failures).toEqual([]);
    expect(runs).toEqual(['answer']);
  });

  test('fails a plugin whose declared onStep throws, naming the point and the error', async () => {
    const runs: string[] = [];
    const throwing = pluginWithInterceptor({
      onStep: {
        handler: async () => {
          throw new Error('storage unavailable');
        },
        onError: () => 'continue',
      },
    });
    const failures = await checkPluginContract(throwing, { createHost: hostRunningHooks(runs) });
    expect(failures).toEqual([
      {
        check: HOOK_CHECK,
        message: 'The onStep hook of "audit" threw: storage unavailable',
      },
    ]);
  });

  test('fails a declared hook the scripted run never reached', async () => {
    const failures = await checkPluginContract(
      pluginWithInterceptor({ onRunError: async () => {} }),
      { createHost: hostRunningHooks([]) },
    );
    expect(failures).toEqual([
      {
        check: HOOK_CHECK,
        message: 'The onRunError hook of "audit" did not run in the failure scripted run.',
      },
    ]);
  });

  test('starts no run for a point the scripted host cannot reach, which stays unchecked', async () => {
    const runs: string[] = [];
    const failures = await checkPluginContract(
      pluginWithInterceptor({ onRunAbort: async () => {}, afterCompaction: async () => {} }),
      { createHost: hostRunningHooks(runs) },
    );
    expect(failures).toEqual([]);
    expect(runs).toEqual([]);
  });

  test('lists the unchecked points', () => {
    expect([...PLUGIN_CONTRACT_UNCHECKED_HOOK_POINTS].toSorted()).toEqual([
      'afterCompaction',
      'beforeBackgroundCompaction',
      'beforeCompaction',
      'onRunAbort',
    ]);
  });
});

describe('the native decision scenarios (COR-2159)', () => {
  const DECISION_CHECK = 'answers the decision scenarios of every row with native decision kinds';
  const [seed] = createModelCatalog().descriptors;
  if (seed === undefined) throw new Error('Expected the seed catalog to hold rows.');
  const row: BackendDescriptor = {
    ...seed,
    provider: 'judge',
    model: 'oracle',
    aliases: [],
    decisions: { kinds: ['boolean'], only: true },
  };

  function judgePlugin(options: { readonly rows?: readonly BackendDescriptor[] } = {}) {
    return definePlugin({
      name: 'example',
      version: '1.0.0',
      description: 'An example plugin.',
      setup: () => ({
        providers: [
          {
            name: 'judge',
            decide: () => ({ name: 'judge', kinds: new Set(), decide: async () => ({}) as never }),
            rows: options.rows ?? [row],
          },
        ],
      }),
    });
  }

  /** A native model that serves `kinds` and answers each scenario with `answer(scenario)`. */
  function modelServing(
    kinds: readonly DecisionKind[],
    answer: (scenario: DecisionScenario | undefined) => unknown = (scenario) => scenario?.expected,
  ) {
    return ({ scenario }: PluginDecisionModelRequest): DecisionModel => ({
      name: 'judge',
      kinds: new Set(kinds),
      decide: async () => ({
        value: answer(scenario) as never,
        provider: 'judge',
        model: 'oracle',
      }),
    });
  }

  const { createHost } = hostReporting({
    descriptor: { name: 'example' },
    status: 'running',
    problems: [],
  });

  test('passes a provider whose native model serves the declared kinds and answers every scenario of them', async () => {
    const failures = await checkPluginContract(judgePlugin(), {
      createHost,
      createDecisionModel: modelServing(['boolean']),
    });
    expect(failures).toEqual([]);
  });

  test('fails a provider whose native model serves a kind its row did not declare', async () => {
    const failures = await checkPluginContract(judgePlugin(), {
      createHost,
      createDecisionModel: modelServing(['boolean', 'scale']),
    });
    expect(failures).toEqual([
      {
        check: DECISION_CHECK,
        message:
          'The native model of "judge/oracle" serves "scale", which its row does not declare (boolean).',
      },
    ]);
  });

  test('fails a provider whose native model omits a kind its row declares', async () => {
    const failures = await checkPluginContract(judgePlugin(), {
      createHost,
      createDecisionModel: modelServing(['scale']),
    });
    expect(failures[0]?.message).toContain(
      'The native model of "judge/oracle" does not serve "boolean", which its row declares.',
    );
  });

  test('fails a provider whose native model answers a scenario wrongly, naming the scenario', async () => {
    const failures = await checkPluginContract(judgePlugin(), {
      createHost,
      createDecisionModel: modelServing(['boolean'], () => 'maybe'),
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain(
      '"judge/oracle" did not answer the scenario "boolean-true"',
    );
  });

  test('fails a row with native kinds when the contract is given no way to build its model, or its provider cannot decide', async () => {
    const unbuilt = await checkPluginContract(judgePlugin(), { createHost });
    expect(unbuilt[0]?.message).toContain('needs the createDecisionModel option');
    const mute = definePlugin({
      name: 'example',
      version: '1.0.0',
      description: 'An example plugin.',
      setup: () => ({
        providers: [{ name: 'judge', generate: () => async () => ({}) as never, rows: [row] }],
      }),
    });
    const failures = await checkPluginContract(mute, { createHost });
    expect(failures[0]?.message).toContain('its provider has no decide');
  });

  test('asks nothing of a row that declares no native kinds', async () => {
    const generating = { ...row, decisions: undefined };
    const failures = await checkPluginContract(judgePlugin({ rows: [generating] }), { createHost });
    expect(failures).toEqual([]);
  });
});
