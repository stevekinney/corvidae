import type { z } from 'zod';

import type { PluginInterceptor } from '../contributions.ts';
import type { PluginDescriptor } from '../plugin-descriptor.ts';
import type { PluginScriptedScenario } from './plugin-contract.ts';

/** The hook points of an interceptor: every member but its name and its scope. */
export type PluginHookPoint = Exclude<keyof PluginInterceptor, 'name' | 'appliesTo'>;

/**
 * The scripted run that reaches each hook point, or `undefined` for a point no scripted run the
 * host can script reaches. The contract checks the first kind and documents the second as
 * unchecked.
 */
const POINT_SCENARIOS = {
  prepareStep: 'answer',
  selectTools: 'answer',
  selectToolChoice: 'answer',
  validateResponse: 'answer',
  beforeGenerate: 'answer',
  afterGenerate: 'answer',
  onLLMInput: 'answer',
  onLLMOutput: 'answer',
  onStep: 'answer',
  onRunStart: 'answer',
  onRunComplete: 'answer',
  beforeToolExecution: 'tool',
  afterToolExecution: 'tool',
  validateToolResult: 'tool',
  onError: 'failure',
  onRunError: 'failure',
  beforeCompaction: undefined,
  beforeBackgroundCompaction: undefined,
  afterCompaction: undefined,
  onRunAbort: undefined,
} as const satisfies Record<PluginHookPoint, PluginScriptedScenario | undefined>;

/**
 * The hook points the conformance suite cannot check, because the scripted host runs no
 * conversation long enough to compact and never aborts a run: a hook declared at one of these is
 * not run by {@link pluginContract}, and nothing in the suite says whether it works.
 */
export const PLUGIN_CONTRACT_UNCHECKED_HOOK_POINTS: readonly PluginHookPoint[] = (
  Object.keys(POINT_SCENARIOS) as PluginHookPoint[]
).filter((point) => POINT_SCENARIOS[point] === undefined);

/** The scripted run that reaches `point`, or `undefined` when the suite cannot reach it. */
export function scenarioOf(point: PluginHookPoint): PluginScriptedScenario | undefined {
  return POINT_SCENARIOS[point];
}

/** What one scripted run saw the plugin's hooks do. */
export interface HookObservations {
  /** The `<interceptor>:<point>` of every hook that ran its handler. */
  readonly ran: Set<string>;
  /** Every handler that threw, with what it threw. */
  readonly threw: { readonly key: string; readonly message: string }[];
}

/** The key an observation of `interceptor`'s `point` is recorded under. */
export function observationKey(interceptor: string, point: PluginHookPoint): string {
  return `${interceptor}:${point}`;
}

type Handler = (...input: unknown[]) => unknown;

function observed(handler: Handler, key: string, observations: HookObservations): Handler {
  return async (...input) => {
    observations.ran.add(key);
    try {
      return await handler(...input);
    } catch (error) {
      observations.threw.push({
        key,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}

/** `interceptor` with each handler recording into `observations`; every other option is untouched. */
function observeInterceptor(
  interceptor: PluginInterceptor,
  observations: HookObservations,
): PluginInterceptor {
  const copy: Record<string, unknown> = { ...interceptor };
  for (const point of Object.keys(POINT_SCENARIOS) as PluginHookPoint[]) {
    const hook: unknown = interceptor[point];
    if (hook === undefined) continue;
    const key = observationKey(interceptor.name, point);
    copy[point] =
      typeof hook === 'function'
        ? observed(hook as Handler, key, observations)
        : {
            ...(hook as { handler: Handler }),
            handler: observed((hook as { handler: Handler }).handler, key, observations),
          };
  }
  return copy as unknown as PluginInterceptor;
}

/**
 * `plugin` with every interceptor handler it contributes wrapped to record that it ran and what
 * it threw, so the contract can tell a hook that was reached from one that was not, and a hook
 * that failed from one an `onError: 'continue'` or an observing point settled. Nothing else about
 * the plugin changes.
 */
export function observePlugin(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each plugin declares its own configuration schema.
  plugin: PluginDescriptor<z.ZodType<any>>,
  observations: HookObservations,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each plugin declares its own configuration schema.
): PluginDescriptor<z.ZodType<any>> {
  if (plugin.setup === undefined) return plugin;
  return {
    ...plugin,
    async setup(context) {
      // `setup` is a method of the descriptor, so it is called as one.
      const contributions = await plugin.setup!(context);
      return {
        ...contributions,
        ...(contributions.interceptors === undefined
          ? {}
          : {
              interceptors: contributions.interceptors.map((interceptor) =>
                observeInterceptor(interceptor, observations),
              ),
            }),
      };
    },
  };
}
