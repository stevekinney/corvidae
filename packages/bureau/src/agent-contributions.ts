/**
 * COR-1877 — the guardrails and interceptors plugins contribute, which an agent file chooses by id.
 *
 * Operative's default guardrail preset guards every agent. An agent file's `guardrails: [ids]` adds
 * plugin guardrails to it, and its `interceptors: [ids]` adds plugin interceptors. An id is `plugin:name`,
 * the form Armorer's `formatToolId` writes, and a file writes it without a version: a file floats
 * with the plugin that contributes it. An id the contributions do not hold makes the agent invalid
 * with `reference-unresolved`.
 *
 * A guardrail is one input detector or one output validator, named by its own `name`. An
 * interceptor is one `PluginInterceptor`, named by its own `name`. Every run hook it registers carries
 * `source: <plugin>`, which survives `mergeHookRegistries`, so the run's hook plan says which
 * plugin each entry came from.
 *
 * @module agent-contributions
 */

import type { PluginGuardrails, PluginInterceptor } from '@lostgradient/interborough-plugin';
import { HookRegistry } from '@lostgradient/lifecycle';
import {
  AGENT_POLICY_PINNED_LAST_PRIORITY,
  type GuardrailAdditions,
  type HookRegistrationOptions,
  type OperativeHookMap,
  type OutputValidator,
} from '@lostgradient/operative';
import { formatToolId, type InputDetector } from 'armorer';

import type { AgentFileDefinition, AgentFileIssue } from './agent-file';

/** What one plugin contributes that an agent file can choose. */
export interface AgentContributionSource {
  /** The plugin's name; the first half of each id and the `source` of each run hook an interceptor registers. */
  readonly plugin: string;
  /** The plugin's guardrails, each selectable by its own name. */
  readonly guardrails?: PluginGuardrails | undefined;
  /** The plugin's interceptors, each selectable by its own name. */
  readonly interceptors?: readonly PluginInterceptor[] | undefined;
}

/** One guardrail a plugin contributes: a detector or a validator. */
export interface ContributedGuardrail {
  /** `plugin:name`, as an agent file writes it. */
  readonly id: string;
  /** The contributing plugin. */
  readonly plugin: string;
  /** Set for an input detector. */
  readonly inputDetector?: InputDetector | undefined;
  /** Set for an output validator. */
  readonly outputValidator?: OutputValidator | undefined;
}

/** One interceptor a plugin contributes. */
export interface ContributedInterceptor {
  /** `plugin:name`, as an agent file writes it. */
  readonly id: string;
  /** The contributing plugin. */
  readonly plugin: string;
  /** The interceptor itself. */
  readonly interceptor: PluginInterceptor;
}

/** The guardrails and interceptors an agent file may choose, by id. */
export interface AgentContributions {
  /** Every contributed guardrail, by id. */
  readonly guardrails: ReadonlyMap<string, ContributedGuardrail>;
  /** Every contributed interceptor, by id. */
  readonly interceptors: ReadonlyMap<string, ContributedInterceptor>;
}

/** No contributions: an agent file that lists any is invalid. */
export const NO_AGENT_CONTRIBUTIONS: AgentContributions = Object.freeze({
  guardrails: new Map<string, ContributedGuardrail>(),
  interceptors: new Map<string, ContributedInterceptor>(),
});

/**
 * Collects what plugins contribute into the lookup agent files resolve against. Throws `TypeError`
 * when two guardrails share an id, or two interceptors do (a file names a contribution by id
 * alone, so an id that means two things would run whichever came first), and when an interceptor
 * declares a hook that is neither a function nor a well-formed `{ handler, ... }` object.
 */
export function createAgentContributions(
  sources: readonly AgentContributionSource[],
): AgentContributions {
  const guardrails = new Map<string, ContributedGuardrail>();
  const interceptors = new Map<string, ContributedInterceptor>();
  for (const {
    plugin,
    guardrails: contributed,
    interceptors: contributedInterceptors,
  } of sources) {
    const guardrail = (entry: Omit<ContributedGuardrail, 'id' | 'plugin'> & { name: string }) => {
      const id = formatToolId({ namespace: plugin, name: entry.name });
      if (guardrails.has(id)) {
        throw new TypeError(`The guardrail "${id}" is contributed more than once.`);
      }
      const { name: _name, ...rest } = entry;
      guardrails.set(id, { id, plugin, ...rest });
    };
    for (const detector of contributed?.inputDetectors ?? []) {
      guardrail({ name: detector.name, inputDetector: detector });
    }
    for (const validator of contributed?.outputValidators ?? []) {
      guardrail({ name: validator.name, outputValidator: validator });
    }
    for (const interceptor of contributedInterceptors ?? []) {
      const id = formatToolId({ namespace: plugin, name: interceptor.name });
      if (interceptors.has(id)) {
        throw new TypeError(`The interceptor "${id}" is contributed more than once.`);
      }
      assertInterceptorHooks(id, interceptor);
      interceptors.set(id, { id, plugin, interceptor });
    }
  }
  return { guardrails, interceptors };
}

/**
 * The ids `definition` lists that `contributions` does not hold, as the issues of a
 * `reference-unresolved` problem: each names the key and the position in it.
 */
export function unresolvedContributions(
  definition: Pick<AgentFileDefinition, 'guardrails' | 'interceptors'>,
  contributions: AgentContributions,
): AgentFileIssue[] {
  const issues: AgentFileIssue[] = [];
  (definition.guardrails ?? []).forEach((id, index) => {
    if (!contributions.guardrails.has(id)) {
      issues.push({
        path: `guardrails.${index}`,
        message: `"${id}" is not a contributed guardrail`,
        reference: id,
      });
    }
  });
  (definition.interceptors ?? []).forEach((id, index) => {
    if (!contributions.interceptors.has(id)) {
      issues.push({
        path: `interceptors.${index}`,
        message: `"${id}" is not a contributed interceptor`,
        reference: id,
      });
    }
  });
  return issues;
}

/**
 * The guardrails `definition` chooses, to add to Operative's default preset, or `undefined` when it
 * chooses none. Every id must resolve (see {@link unresolvedContributions}); one that does not is
 * skipped.
 */
export function guardrailAdditionsOf(
  definition: Pick<AgentFileDefinition, 'guardrails'>,
  contributions: AgentContributions,
): GuardrailAdditions | undefined {
  const inputDetectors: InputDetector[] = [];
  const outputValidators: OutputValidator[] = [];
  for (const id of new Set(definition.guardrails ?? [])) {
    const contributed = contributions.guardrails.get(id);
    if (contributed?.inputDetector !== undefined) inputDetectors.push(contributed.inputDetector);
    if (contributed?.outputValidator !== undefined) {
      outputValidators.push(contributed.outputValidator);
    }
  }
  if (inputDetectors.length === 0 && outputValidators.length === 0) return undefined;
  return { inputDetectors, outputValidators };
}

/**
 * Every point a {@link PluginInterceptor} can hook, as the run-time list its two consumers (the
 * registry {@link interceptorsOf} builds and the secret gate) iterate. The record is keyed by
 * `PluginInterceptor`'s own members, so the compiler fails here when one is added or removed, and
 * `contributions.test-d.ts` in `@lostgradient/interborough-plugin` fails when that interface and
 * Operative's hook map disagree.
 */
const INTERCEPTOR_POINT_SET: Record<Exclude<keyof PluginInterceptor, 'name'>, true> = {
  prepareStep: true,
  beforeToolExecution: true,
  afterToolExecution: true,
  onStep: true,
  selectTools: true,
  validateResponse: true,
  validateToolResult: true,
  beforeCompaction: true,
  beforeBackgroundCompaction: true,
  afterCompaction: true,
  selectToolChoice: true,
  beforeGenerate: true,
  afterGenerate: true,
  onLLMInput: true,
  onLLMOutput: true,
  onRunStart: true,
  onRunComplete: true,
  onRunError: true,
  onRunAbort: true,
  onError: true,
};

/** The hook points of a {@link PluginInterceptor}: one per point of Operative's hook map. */
export const INTERCEPTOR_POINTS = Object.keys(INTERCEPTOR_POINT_SET) as ReadonlyArray<
  Exclude<keyof PluginInterceptor, 'name'>
>;

/** One hook of an interceptor, as either of its two written forms. */
type InterceptorHook = NonNullable<PluginInterceptor[(typeof INTERCEPTOR_POINTS)[number]]>;

/**
 * The lowest priority an interceptor hook can sort at. Operative's guardrail registrations sit at
 * {@link AGENT_POLICY_PINNED_LAST_PRIORITY}, behind every other agent hook, and a plugin's hook
 * stays in front of them: a lower number a plugin asks for is raised to this one.
 */
export const INTERCEPTOR_PRIORITY_FLOOR = AGENT_POLICY_PINNED_LAST_PRIORITY + 1;

/** `hook` as its handler and the registration options it declares. */
function interceptorHookParts(hook: InterceptorHook): {
  readonly handler: OperativeHookMap[(typeof INTERCEPTOR_POINTS)[number]];
  readonly options: Pick<HookRegistrationOptions, 'replay' | 'onError' | 'priority'>;
} {
  if (typeof hook === 'function') return { handler: hook, options: {} };
  return {
    handler: hook.handler,
    options: {
      ...(hook.replay === undefined ? {} : { replay: hook.replay }),
      ...(hook.onError === undefined ? {} : { onError: hook.onError }),
      ...(hook.priority === undefined
        ? {}
        : { priority: Math.max(hook.priority, INTERCEPTOR_PRIORITY_FLOOR) }),
    },
  };
}

/**
 * Throws `TypeError` unless every hook `interceptor` declares is a function or an object with a
 * `handler` function, a known `replay`, an `onError` function and a finite `priority`, where those
 * are given. The type says so, but a plugin is code the host loads, so a wrong shape would otherwise
 * fail in the middle of a run, or sort as `NaN`.
 */
function assertInterceptorHooks(id: string, interceptor: PluginInterceptor): void {
  for (const point of INTERCEPTOR_POINTS) {
    const hook: unknown = interceptor[point];
    if (hook === undefined || typeof hook === 'function') continue;
    const where = `The hook "${point}" of the interceptor "${id}"`;
    if (
      typeof hook !== 'object' ||
      hook === null ||
      typeof Reflect.get(hook, 'handler') !== 'function'
    ) {
      throw new TypeError(`${where} must be a function or an object with a \`handler\` function.`);
    }
    const replay: unknown = Reflect.get(hook, 'replay');
    if (replay !== undefined && replay !== 'safe' && replay !== 'effectful') {
      throw new TypeError(`${where} has a \`replay\` that is neither "safe" nor "effectful".`);
    }
    const onError: unknown = Reflect.get(hook, 'onError');
    if (onError !== undefined && typeof onError !== 'function') {
      throw new TypeError(`${where} has an \`onError\` that is not a function.`);
    }
    const priority: unknown = Reflect.get(hook, 'priority');
    if (priority !== undefined && !Number.isFinite(priority)) {
      throw new TypeError(`${where} has a \`priority\` that is not a finite number.`);
    }
  }
}

/**
 * The agent-tier hook registry for the interceptors `definition` chooses, or `undefined` when it
 * chooses none. Each entry carries `source: <plugin>` and the id `<plugin>:<name>:<hook>`, and the
 * `replay`, `onError` and `priority` its hook declares, the priority raised to
 * {@link INTERCEPTOR_PRIORITY_FLOOR} when it is lower. Every id
 * must resolve (see {@link unresolvedContributions}); one that does not is skipped.
 */
export function interceptorsOf(
  definition: Pick<AgentFileDefinition, 'interceptors'>,
  contributions: AgentContributions,
): HookRegistry<OperativeHookMap> | undefined {
  const registry = new HookRegistry<OperativeHookMap>();
  for (const id of new Set(definition.interceptors ?? [])) {
    const contributed = contributions.interceptors.get(id);
    if (contributed === undefined) continue;
    for (const point of INTERCEPTOR_POINTS) {
      const handler = contributed.interceptor[point];
      if (handler === undefined) continue;
      const { handler: hook, options } = interceptorHookParts(handler);
      registry.on(point, hook, {
        id: `${id}:${point}`,
        source: contributed.plugin,
        ...options,
      });
    }
  }
  return registry.getHookNames().length === 0 ? undefined : registry;
}
