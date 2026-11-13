import {
  createModelCatalog,
  type BackendDescriptor,
  type DecisionModel,
} from '@lostgradient/operative';
import {
  decisionContractFailure,
  decisionScenarios,
  type DecisionScenario,
} from '@lostgradient/operative/decision-testing';
import { afterAll, describe, expect, test } from 'bun:test';
import type { z } from 'zod';

import type { PluginProvider } from '../contributions.ts';
import { definePlugin } from '../define-plugin.ts';
import type { PluginDescriptor } from '../plugin-descriptor.ts';
import {
  observationKey,
  observePlugin,
  scenarioOf,
  type HookObservations,
  type PluginHookPoint,
} from './hook-observation.ts';
import { pluginContributions, pluginIdentities } from './plugin-identities.ts';

/** One thing wrong with a plugin, as the contract found it. */
export interface PluginContractFailure {
  /** The name of the check that failed. */
  readonly check: string;
  /** What is wrong. */
  readonly message: string;
}

/** The part of one plugin's listing the contract reads; Bureau's `PluginListing` satisfies it. */
export interface PluginTestHostListing {
  /** The plugin's descriptor as the host reports it. */
  readonly descriptor: { readonly name: string };
  /** What the plugin is now; the contract expects `running`. */
  readonly status: string;
  /** What is wrong with it; the contract expects none. */
  readonly problems: readonly { readonly code: string }[];
}

/** One agent in the host's agent listing, as far as the contract reads it; Bureau's `AgentListing` satisfies it. */
export interface PluginTestHostAgent {
  /** The agent's identifier; a file a plugin ships is `plugin:name`. */
  readonly id: string;
  /**
   * Whether the agent can run: `ready` does, `invalid` is a file that cannot be used, and
   * `unavailable` is a code agent of a disabled plugin, which the host lists but never runs.
   */
  readonly state: 'ready' | 'invalid' | 'unavailable';
  /** The plugin that ships the agent, for a file of a plugin's read-only layer or a disabled plugin's code. */
  readonly plugin?: string | undefined;
  /** Why an `invalid` agent cannot run. */
  readonly problem?: { readonly code: string; readonly message: string } | undefined;
}

/**
 * What a scripted run does, which decides the hook points it reaches: `answer` is one model reply
 * with no tool call, `tool` is a reply that calls a read-only tool and then answers, and `failure`
 * is a model that throws, which ends the run in an error.
 */
export type PluginScriptedScenario = 'answer' | 'tool' | 'failure';

/** What {@link PluginTestHost.scriptedRun} is asked to run. */
export interface PluginScriptedRunRequest {
  /** What the scripted model does. */
  readonly scenario: PluginScriptedScenario;
  /**
   * The names of the interceptors the plugin declares, which the run's agent chooses, so a set that
   * does not apply to every agent runs too.
   */
  readonly interceptors: readonly string[];
}

/** How a scripted run ended. */
export interface PluginScriptedRunOutcome {
  /** The run's finish reason: `error` for a run that failed, whatever the cause. */
  readonly finishReason: string;
}

/** A host with one plugin loaded, as far as the contract reads it; Bureau's `Bureau` satisfies it. */
export interface PluginTestHost {
  /** The plugins the host was given. */
  readonly plugins: {
    /** Every plugin, as it stands now. */
    list(): Promise<readonly PluginTestHostListing[]>;
    /** Settles once every running plugin's `start` has settled. */
    ready(): Promise<void>;
  };
  /** The agents the host lists, including every file the plugin ships. */
  readonly agents: {
    /** Every agent, code-defined and file-based, ready or invalid. */
    list(): readonly PluginTestHostAgent[];
  };
  /**
   * Runs one agent that chooses `request.interceptors` through the scripted model, and settles when
   * the run has ended and every hook has been awaited. A run that fails settles with an `error`
   * finish reason rather than rejecting.
   */
  scriptedRun(request: PluginScriptedRunRequest): Promise<PluginScriptedRunOutcome>;
  /** Stops the host and removes whatever it created. */
  dispose(): Promise<void>;
}

/**
 * Starts a host that loads only `plugin`, with a value for every secret it declares and the files
 * its `content` ships. The package never builds one itself so that it never imports Bureau; Bureau
 * supplies `createPluginTestHost` from `@lostgradient/bureau/testing`.
 */
export type CreatePluginTestHost = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each plugin declares its own configuration schema.
  plugin: PluginDescriptor<z.ZodType<any>>,
) => Promise<PluginTestHost>;

/** What {@link PluginContractOptions.createDecisionModel} is asked to build. */
export interface PluginDecisionModelRequest {
  /** The provider whose native `decide` the model comes from. */
  readonly provider: PluginProvider;
  /** The catalog row the model answers for. */
  readonly row: BackendDescriptor;
  /**
   * The scenario about to be asked, so a scripted or replayed model can queue its answer; absent
   * when the model is only read for the kinds it declares.
   */
  readonly scenario?: DecisionScenario;
}

/** What {@link pluginContract} and {@link checkPluginContract} need beside the plugin. */
export interface PluginContractOptions {
  /** Starts the host the plugin is loaded into. */
  readonly createHost: CreatePluginTestHost;
  /**
   * Builds the native decision model of a catalog row that declares `decisions`, through the
   * provider's own `decide`, with the scenario's answer scripted or replayed so nothing reaches the
   * network (COR-2159). Required by a plugin with such a row: the contract refuses to guess a key
   * and call a real provider.
   */
  readonly createDecisionModel?: (
    request: PluginDecisionModelRequest,
  ) => DecisionModel | Promise<DecisionModel>;
}

/** What the contract reads once the host is up: the plugin's listing and the agents the host lists. */
interface StartedHost {
  readonly found: PluginTestHostListing;
  readonly agents: readonly PluginTestHostAgent[];
}

interface ContractCheck {
  readonly name: string;
  /** The problem the check found, or `undefined` when the plugin passes it. */
  run(): Promise<string | undefined>;
}

function problemText(problem: { readonly code: string }): string {
  return JSON.stringify(problem);
}

/**
 * The problems of one catalog row that declares native decision kinds: its provider has to decide,
 * the model it builds serves exactly the kinds the row declares, and it answers every
 * {@link decisionScenarios} case of those kinds as the decision-model contract requires.
 */
async function nativeDecisionProblems(
  provider: PluginProvider,
  row: BackendDescriptor,
  options: PluginContractOptions,
): Promise<string[]> {
  const declared = row.decisions?.kinds ?? [];
  const label = `${row.provider}/${row.model}`;
  if (declared.length === 0) return [];
  if (provider.decide === undefined) {
    return [`The row "${label}" declares native decision kinds, but its provider has no decide.`];
  }
  const { createDecisionModel } = options;
  if (createDecisionModel === undefined) {
    return [
      `The row "${label}" answers decisions natively, so the contract needs the createDecisionModel option to build it with each scenario's answer scripted.`,
    ];
  }
  const problems: string[] = [];
  const model = await createDecisionModel({ provider, row });
  for (const kind of model.kinds) {
    if (!declared.includes(kind)) {
      problems.push(
        `The native model of "${label}" serves "${kind}", which its row does not declare (${declared.join(', ')}).`,
      );
    }
  }
  for (const kind of declared) {
    if (!model.kinds.has(kind)) {
      problems.push(
        `The native model of "${label}" does not serve "${kind}", which its row declares.`,
      );
    }
  }
  for (const scenario of decisionScenarios) {
    if (!declared.includes(scenario.request.kind)) continue;
    const failure = await decisionContractFailure(
      await createDecisionModel({ provider, row, scenario }),
      scenario,
    );
    if (failure !== undefined) {
      problems.push(`"${label}" did not answer the scenario "${scenario.name}": ${failure}`);
    }
  }
  return problems;
}

function contractRun(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each plugin declares its own configuration schema.
  plugin: PluginDescriptor<z.ZodType<any>>,
  options: PluginContractOptions,
): { checks: readonly ContractCheck[]; dispose(): Promise<void> } {
  let host: Promise<PluginTestHost> | undefined;
  let hookHost: Promise<PluginTestHost> | undefined;
  const observations: HookObservations = { ran: new Set(), threw: [] };
  let listing: Promise<StartedHost | string> | undefined;
  const started = (): Promise<StartedHost | string> => {
    listing ??= (async () => {
      host = options.createHost(plugin);
      const running = await host;
      await running.plugins.ready();
      const listed = await running.plugins.list();
      const found = listed.find((candidate) => candidate.descriptor.name === plugin.name);
      return found === undefined
        ? `The host does not list a plugin named "${plugin.name}".`
        : { found, agents: running.agents.list() };
    })();
    return listing;
  };
  const checks: ContractCheck[] = [
    {
      name: 'declares a valid descriptor',
      run: async () => {
        try {
          definePlugin(plugin);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    },
    {
      name: 'holds identities that read without a host and never repeat',
      run: async () => {
        try {
          const { entries } = await pluginIdentities(plugin);
          const seen = new Set<string>();
          for (const { kind, id } of entries) {
            const key = `${kind} ${id}`;
            if (seen.has(key)) return `The ${kind} "${id}" is contributed twice.`;
            seen.add(key);
          }
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    },
    {
      name: 'answers the decision scenarios of every row with native decision kinds',
      run: async () => {
        const contributions = await pluginContributions(plugin);
        const problems: string[] = [];
        for (const provider of contributions.providers ?? []) {
          const rows =
            provider.rows ??
            createModelCatalog().descriptors.filter((row) => row.provider === provider.name);
          for (const row of rows) {
            problems.push(...(await nativeDecisionProblems(provider, row, options)));
          }
        }
        return problems.length === 0 ? undefined : problems.join(' ');
      },
    },
    {
      name: 'loads into a host and runs',
      run: async () => {
        const result = await started();
        if (typeof result === 'string') return result;
        const { status } = result.found;
        return status === 'running' ? undefined : `The plugin is "${status}", not "running".`;
      },
    },
    {
      name: 'reports no problems',
      run: async () => {
        const result = await started();
        if (typeof result === 'string') return result;
        const { problems } = result.found;
        return problems.length === 0 ? undefined : problems.map(problemText).join('; ');
      },
    },
    {
      name: 'ships only valid agent files',
      run: async () => {
        const result = await started();
        if (typeof result === 'string') return undefined;
        // An unknown tool or an unresolved reference is already reported, by name, as a plugin
        // problem; every other way a file can be invalid is reported here.
        const invalid = result.agents.filter(
          ({ plugin: shippedBy, state, problem }) =>
            shippedBy === plugin.name &&
            state === 'invalid' &&
            problem?.code !== 'unknown-tool' &&
            problem?.code !== 'reference-unresolved',
        );
        return invalid.length === 0
          ? undefined
          : invalid
              .map(
                ({ id, problem }) =>
                  `The agent "${id}" is invalid: ${problem?.code ?? 'unknown'} (${problem?.message ?? 'no reason given'}).`,
              )
              .join(' ');
      },
    },
    {
      name: 'runs every declared hook point without throwing',
      run: async () => {
        const contributions = await pluginContributions(plugin);
        const declared = new Map<PluginHookPoint, string[]>();
        for (const interceptor of contributions.interceptors ?? []) {
          for (const key of Object.keys(interceptor)) {
            if (key === 'name' || key === 'appliesTo') continue;
            const point = key as PluginHookPoint;
            if (interceptor[point] === undefined) continue;
            declared.set(point, [...(declared.get(point) ?? []), interceptor.name]);
          }
        }
        const reachable = [...declared.keys()].filter((point) => scenarioOf(point) !== undefined);
        if (reachable.length === 0) return undefined;
        // One host that loads the plugin with its handlers observed; its runs are one at a time.
        hookHost ??= options.createHost(observePlugin(plugin, observations));
        const running = await hookHost;
        await running.plugins.ready();
        const interceptors = (contributions.interceptors ?? []).map(({ name }) => name);
        const problems: string[] = [];
        for (const point of reachable) {
          const scenario = scenarioOf(point)!;
          observations.ran.clear();
          observations.threw.length = 0;
          await running.scriptedRun({ scenario, interceptors });
          for (const name of declared.get(point) ?? []) {
            const key = observationKey(name, point);
            const failure = observations.threw.find((thrown) => thrown.key === key);
            if (failure !== undefined) {
              problems.push(`The ${point} hook of "${name}" threw: ${failure.message}`);
            } else if (!observations.ran.has(key)) {
              problems.push(
                `The ${point} hook of "${name}" did not run in the ${scenario} scripted run.`,
              );
            }
          }
        }
        return problems.length === 0 ? undefined : problems.join(' ');
      },
    },
  ];
  return {
    checks,
    dispose: async () => {
      // A host that failed to start has nothing to dispose; the check already reported why.
      for (const loaded of [host, hookHost]) {
        if (loaded !== undefined)
          await loaded.then(
            (running) => running.dispose(),
            () => undefined,
          );
      }
    },
  };
}

/**
 * Runs every conformance check against `plugin` and returns what failed, without registering a
 * test, so a script can report the failures and a test can assert on them. An empty list means the
 * plugin conforms. A check that throws is reported as a failure of that check.
 */
export async function checkPluginContract(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each plugin declares its own configuration schema.
  plugin: PluginDescriptor<z.ZodType<any>>,
  options: PluginContractOptions,
): Promise<PluginContractFailure[]> {
  const run = contractRun(plugin, options);
  const failures: PluginContractFailure[] = [];
  try {
    for (const check of run.checks) {
      try {
        const message = await check.run();
        if (message !== undefined) failures.push({ check: check.name, message });
      } catch (error) {
        failures.push({
          check: check.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await run.dispose();
  }
  return failures;
}

/**
 * Registers the conformance suite for `plugin` with `bun:test`, one test per check: the descriptor
 * is valid, its identities read without a host and never repeat, and a host that loads only this
 * plugin reports it `running` with no problems, which includes every file the plugin ships
 * resolving the contributions it names.
 *
 * @example
 * ```ts
 * import { definePlugin } from '@lostgradient/interborough-plugin';
 * import { pluginContract } from '@lostgradient/interborough-plugin/testing';
 * import { createPluginTestHost } from '@lostgradient/bureau/testing';
 *
 * const plugin = definePlugin({ name: 'example', version: '1.0.0', description: 'An example.' });
 * pluginContract(plugin, { createHost: createPluginTestHost });
 * ```
 */
export function pluginContract(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each plugin declares its own configuration schema.
  plugin: PluginDescriptor<z.ZodType<any>>,
  options: PluginContractOptions,
): void {
  describe(`plugin contract: ${plugin.name}`, () => {
    const run = contractRun(plugin, options);
    afterAll(() => run.dispose());
    for (const check of run.checks) {
      test(check.name, async () => {
        expect(await check.run()).toBeUndefined();
      });
    }
  });
}
