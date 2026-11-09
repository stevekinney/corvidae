/**
 * COR-1877 — the guardrails and interceptors plugins contribute, which an agent file chooses by id.
 *
 * Operative's default guardrail preset guards every agent. An agent file's `guardrails: [ids]` adds
 * plugin guardrails to it, and its `interceptors: [ids]` adds plugin interceptors. An id is `plugin:name`,
 * the form Armorer's `formatToolId` writes, and a file writes it without a version: a file floats
 * with the plugin that contributes it. An id the contributions do not hold makes the agent invalid
 * with `reference-unresolved`.
 *
 * A guardrail is one input detector, one output validator or one tool-call validator, named by its
 * own `name`; an input or output entry may carry an action of its own, which travels with it. A
 * plugin may contribute a factory of one instead (COR-2118): a file entry `{ id, configuration }`
 * configures it, the factory's schema parses that configuration (`{}` for a bare id), and each
 * agent that chooses it runs the guardrail its `create` builds for it, under the entry's action. An
 * interceptor is one `PluginInterceptor`, named by its own `name`. Every run hook it registers carries
 * `source: <plugin>`, which survives `mergeHookRegistries`, so the run's hook plan says which
 * plugin each entry came from.
 *
 * COR-2127 — an interceptor that declares `appliesTo: 'every-agent'` needs no file to choose it: it
 * registers for every run Bureau composes, in the `plugin` tier ({@link everyAgentInterceptorsOf}).
 * A file that lists it anyway gets it in its own agent tier instead, and that run's plugin tier
 * leaves it out, so it registers once and refuses, as a chosen interceptor does, while its plugin
 * needs setup.
 *
 * @module agent-contributions
 */

import {
  isGuardrailFactory,
  type PluginGuardrailFactory,
  type PluginGuardrails,
  type PluginInputGuardrailEntry,
  type PluginInterceptor,
  type PluginOutputGuardrailEntry,
  type PluginToolGuardrailEntry,
} from '@lostgradient/interborough-plugin';
import { HOOK_TIER_BAND_WIDTH, HookRegistry } from '@lostgradient/lifecycle';
import {
  AGENT_POLICY_PINNED_LAST_PRIORITY,
  type GuardrailAdditions,
  type GuardrailEntry,
  guardrailOf,
  type InputDetector,
  type HookRegistrationOptions,
  type InputGuardrailEntry,
  type OperativeHookMap,
  type OutputGuardrailEntry,
  type OutputValidator,
  type ToolCallValidator,
} from '@lostgradient/operative';
import { formatToolId } from 'armorer';
import type { z } from 'zod';

import {
  type AgentFileDefinition,
  type AgentFileIssue,
  type AgentGuardrailSelection,
  guardrailIdOf,
} from './agent-file';

/** What one plugin contributes that an agent file can choose. */
export interface AgentContributionSource {
  /** The plugin's name; the first half of each id and the `source` of each run hook an interceptor registers. */
  readonly plugin: string;
  /** The plugin's guardrails, each selectable by its own name. */
  readonly guardrails?: PluginGuardrails | undefined;
  /** The plugin's interceptors, each selectable by its own name. */
  readonly interceptors?: readonly PluginInterceptor[] | undefined;
}

/**
 * The guardrails a plugin contributes under one name: an input detector, an output validator, a
 * tool-call validator, or more than one, since names are claimed per family.
 */
export interface ContributedGuardrail {
  /** `plugin:name`, as an agent file writes it. */
  readonly id: string;
  /** The contributing plugin. */
  readonly plugin: string;
  /** Set for an input detector or a factory of one, with the action it carries, if any. */
  readonly inputDetector?: PluginInputGuardrailEntry | undefined;
  /** Set for an output validator or a factory of one, with the action it carries, if any. */
  readonly outputValidator?: PluginOutputGuardrailEntry | undefined;
  /** Set for a tool-call validator (COR-2104) or a factory of one (COR-2118). */
  readonly toolValidator?: PluginToolGuardrailEntry | undefined;
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

/**
 * What is wrong with a guardrail's own contract (COR-2118), or `undefined` when nothing is: it has
 * no non-empty `description`, or it carries a `create` function but no Zod `configuration` schema
 * to parse an agent's configuration with (or a `create` that is not a function). Plugin composition
 * and {@link createAgentContributions} both ask this, so a plugin and the host are held to one rule.
 */
export function guardrailContractFault(guardrail: unknown): 'description' | 'factory' | undefined {
  const { description, configuration, create } = guardrail as {
    readonly description?: unknown;
    readonly configuration?: unknown;
    readonly create?: unknown;
  };
  if (typeof description !== 'string' || description.trim() === '') return 'description';
  if (
    create !== undefined &&
    (typeof create !== 'function' ||
      typeof (configuration as { readonly safeParse?: unknown } | null | undefined)?.safeParse !==
        'function')
  ) {
    return 'factory';
  }
  return undefined;
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
 * alone, so an id that means two things would run whichever came first), when an interceptor
 * declares a hook that is neither a function nor a well-formed `{ handler, ... }` object, and for a
 * guardrail without a non-empty `description` (COR-2118), which a listing could not tell apart, and
 * for a factory without a Zod `configuration` and a function `create` ({@link guardrailContractFault}).
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
    // An agent file names a guardrail as `plugin:name`; a name is claimed per family, so one name
    // may carry an input detector, an output validator and a tool-call validator, which a file that
    // lists it applies all of.
    const guardrail = (
      name: string,
      family: 'inputDetector' | 'outputValidator' | 'toolValidator',
      entry: Pick<ContributedGuardrail, 'inputDetector' | 'outputValidator' | 'toolValidator'>,
    ) => {
      const id = formatToolId({ namespace: plugin, name });
      const fault = guardrailContractFault(
        guardrailOf(entry[family] as Parameters<typeof guardrailOf>[0]),
      );
      if (fault === 'description') {
        throw new TypeError(`The guardrail "${id}" has no description.`);
      }
      if (fault === 'factory') {
        throw new TypeError(
          `The guardrail "${id}" is a factory without a configuration schema and a create function.`,
        );
      }
      const held = guardrails.get(id);
      if (held?.[family] !== undefined) {
        throw new TypeError(`The guardrail "${id}" is contributed more than once.`);
      }
      guardrails.set(id, { ...held, id, plugin, ...entry });
    };
    for (const detector of contributed?.input ?? []) {
      guardrail(guardrailOf(detector).name, 'inputDetector', { inputDetector: detector });
    }
    for (const validator of contributed?.output ?? []) {
      guardrail(guardrailOf(validator).name, 'outputValidator', { outputValidator: validator });
    }
    for (const validator of contributed?.tools ?? []) {
      guardrail(validator.name, 'toolValidator', { toolValidator: validator });
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
 * `reference-unresolved` problem: each names the key and the position in it. A `guardrails` entry
 * is an id or `{ id, configuration }`; either names its guardrail by `id`.
 */
export function unresolvedContributions(
  definition: Pick<AgentFileDefinition, 'guardrails' | 'interceptors'>,
  contributions: AgentContributions,
): AgentFileIssue[] {
  const issues: AgentFileIssue[] = [];
  (definition.guardrails ?? []).forEach((selection, index) => {
    const id = guardrailIdOf(selection);
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

/** The contributed families of `contributed`, each its entry's guardrail, which may be a factory. */
function familiesOf(contributed: ContributedGuardrail): readonly unknown[] {
  return [contributed.inputDetector, contributed.outputValidator, contributed.toolValidator]
    .filter((entry) => entry !== undefined)
    .map((entry) => guardrailOf(entry));
}

/** The configuration an entry gives its guardrail: its own, or `{}` for a bare id. */
function configurationOf(selection: AgentGuardrailSelection): unknown {
  return typeof selection === 'string' ? {} : selection.configuration;
}

/** `configuration` parsed with `factory`'s schema, or the issues it refuses it with. */
function parsedConfiguration(
  factory: PluginGuardrailFactory<unknown>,
  configuration: unknown,
):
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false; readonly error: z.ZodError } {
  return factory.configuration.safeParse(configuration);
}

/**
 * The configurations `definition` gives its guardrails that their schemas refuse (COR-2118), as
 * the issues of an `invalid-guardrail-configuration` problem. Each issue's path names the entry and
 * the field, `guardrails.<index>.configuration.<field>`, and its `reference` the guardrail. A bare
 * id is configured with `{}`, so a factory whose schema needs a field refuses it. An entry that
 * configures a guardrail no factory builds is refused at `guardrails.<index>.configuration`, since
 * nothing would read what it says. An id `contributions` does not hold is left to
 * {@link unresolvedContributions}.
 */
export function refusedGuardrailConfigurations(
  definition: { readonly guardrails?: readonly AgentGuardrailSelection[] | undefined },
  contributions: AgentContributions,
): AgentFileIssue[] {
  const issues: AgentFileIssue[] = [];
  (definition.guardrails ?? []).forEach((selection, index) => {
    const id = guardrailIdOf(selection);
    const contributed = contributions.guardrails.get(id);
    if (contributed === undefined) return;
    const factories = familiesOf(contributed).filter((guardrail) => isGuardrailFactory(guardrail));
    const at = `guardrails.${index}.configuration`;
    if (factories.length === 0) {
      if (typeof selection !== 'string') {
        issues.push({ path: at, message: `"${id}" takes no configuration`, reference: id });
      }
      return;
    }
    const seen = new Set<string>();
    for (const factory of factories) {
      const parsed = parsedConfiguration(factory, configurationOf(selection));
      if (parsed.success) continue;
      for (const issue of parsed.error.issues) {
        const field = issue.path.map(String).join('.');
        const path = field === '' ? at : `${at}.${field}`;
        const message = `"${id}" refuses ${field === '' ? 'its configuration' : `\`${field}\``}: ${issue.message}`;
        // One name may build an input and an output guardrail from one schema; say it once.
        if (seen.has(`${path}\u0000${message}`)) continue;
        seen.add(`${path}\u0000${message}`);
        issues.push({ path, message, reference: id });
      }
    }
  });
  return issues;
}

/**
 * What `factory` builds for one agent from `configuration`. Throws `TypeError` naming the guardrail
 * when the schema refuses it, which a checked definition never does (see
 * {@link refusedGuardrailConfigurations}): a run must not go on without a guardrail it chose.
 */
function created<T>(id: string, factory: PluginGuardrailFactory<T>, configuration: unknown): T {
  const parsed = parsedConfiguration(factory, configuration);
  if (!parsed.success) {
    throw new TypeError(
      `The configuration of the guardrail "${id}" is refused: ${parsed.error.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`).join('; ')}.`,
    );
  }
  return factory.create(parsed.data);
}

/**
 * The guardrail an entry stands for, with the action it carries: itself when it is a detector or a
 * validator, or what its factory builds from `configuration`, named by the factory, when it is one.
 */
function resolvedEntry<T extends { readonly name: string }, A extends string>(
  id: string,
  entry: GuardrailEntry<T | PluginGuardrailFactory<T>, A>,
  configuration: unknown,
  named: (guardrail: T, name: string) => T,
): GuardrailEntry<T, A> {
  const guardrail = guardrailOf(entry);
  if (!isGuardrailFactory(guardrail)) return entry as GuardrailEntry<T, A>;
  const built = named(created(id, guardrail, configuration), guardrail.name);
  return guardrail === entry ? built : { ...(entry as object), guardrail: built };
}

/** `detector` under `name`, its own methods called on it. */
function namedDetector(detector: InputDetector, name: string): InputDetector {
  return { name, detect: (input, context) => detector.detect(input, context) };
}

/** `validator` under `name`, its own methods called on it. */
function namedValidator(validator: OutputValidator, name: string): OutputValidator {
  return { name, validate: (output, context) => validator.validate(output, context) };
}

/** `validator` under `name`, with its own description, or else `description`, and its own action. */
function namedToolValidator(
  validator: ToolCallValidator,
  name: string,
  description: string,
): ToolCallValidator {
  return {
    name,
    description: validator.description ?? description,
    ...(validator.action === undefined ? {} : { action: validator.action }),
    validate: (call, context) => validator.validate(call, context),
  };
}

/**
 * The guardrails `definition` chooses, to add to Operative's default preset, or `undefined` when it
 * chooses none. Every id must resolve (see {@link unresolvedContributions}); one that does not is
 * skipped. An id listed more than once (a definition stored before COR-2118 may repeat one) applies
 * once, as its first entry says. A factory builds its guardrail anew from the entry's
 * configuration on every call, so two agents, or two runs, never share one; it throws `TypeError`
 * for a configuration the factory's schema refuses (see {@link refusedGuardrailConfigurations}).
 */
export function guardrailAdditionsOf(
  definition: Pick<AgentFileDefinition, 'guardrails'>,
  contributions: AgentContributions,
): GuardrailAdditions | undefined {
  const inputDetectors: InputGuardrailEntry[] = [];
  const outputValidators: OutputGuardrailEntry[] = [];
  const toolValidators: ToolCallValidator[] = [];
  const applied = new Set<string>();
  for (const selection of definition.guardrails ?? []) {
    const id = guardrailIdOf(selection);
    if (applied.has(id)) continue;
    applied.add(id);
    const contributed = contributions.guardrails.get(id);
    if (contributed === undefined) continue;
    const configuration = configurationOf(selection);
    if (contributed.inputDetector !== undefined) {
      inputDetectors.push(
        resolvedEntry(id, contributed.inputDetector, configuration, namedDetector),
      );
    }
    if (contributed.outputValidator !== undefined) {
      outputValidators.push(
        resolvedEntry(id, contributed.outputValidator, configuration, namedValidator),
      );
    }
    if (contributed.toolValidator !== undefined) {
      const validator = contributed.toolValidator;
      toolValidators.push(
        isGuardrailFactory(validator)
          ? namedToolValidator(
              created(id, validator, configuration),
              validator.name,
              validator.description,
            )
          : validator,
      );
    }
  }
  if (inputDetectors.length === 0 && outputValidators.length === 0 && toolValidators.length === 0) {
    return undefined;
  }
  return {
    inputDetectors,
    outputValidators,
    ...(toolValidators.length === 0 ? {} : { toolValidators }),
  };
}

/**
 * Every point a {@link PluginInterceptor} can hook, as the run-time list its two consumers (the
 * registry {@link interceptorsOf} builds and the secret gate) iterate. The record is keyed by
 * `PluginInterceptor`'s own members, so the compiler fails here when one is added or removed, and
 * `contributions.test-d.ts` in `@lostgradient/interborough-plugin` fails when that interface and
 * Operative's hook map disagree.
 */
const INTERCEPTOR_POINT_SET: Record<
  Exclude<keyof PluginInterceptor, 'name' | 'appliesTo'>,
  true
> = {
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
  Exclude<keyof PluginInterceptor, 'name' | 'appliesTo'>
>;

/** One hook of an interceptor, as either of its two written forms. */
type InterceptorHook = NonNullable<PluginInterceptor[(typeof INTERCEPTOR_POINTS)[number]]>;

/**
 * The lowest priority an interceptor hook can sort at. Operative's guardrail registrations sit at
 * {@link AGENT_POLICY_PINNED_LAST_PRIORITY}, behind every other agent hook, and a plugin's hook
 * stays in front of them: a lower number a plugin asks for is raised to this one.
 */
export const INTERCEPTOR_PRIORITY_FLOOR = AGENT_POLICY_PINNED_LAST_PRIORITY + 1;

/**
 * The highest priority an interceptor hook can sort at: one below the distance between two tiers'
 * bands ({@link HOOK_TIER_BAND_WIDTH}). A declared priority is added to its tier's band, so a plugin
 * hook declaring this or less stays in its own band, and the plugin tier sorts between Bureau's
 * tier and the agent's whatever a plugin asks for.
 */
export const INTERCEPTOR_PRIORITY_CEILING = HOOK_TIER_BAND_WIDTH - 1;

/** `priority` held to the range `[INTERCEPTOR_PRIORITY_FLOOR, INTERCEPTOR_PRIORITY_CEILING]`. */
function clampInterceptorPriority(priority: number): number {
  return Math.min(Math.max(priority, INTERCEPTOR_PRIORITY_FLOOR), INTERCEPTOR_PRIORITY_CEILING);
}

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
      ...(hook.priority === undefined ? {} : { priority: clampInterceptorPriority(hook.priority) }),
    },
  };
}

/**
 * Throws `TypeError` unless `interceptor`'s `appliesTo` is absent or `'every-agent'`, and every hook
 * it declares is a function or an object with a `handler` function, a known `replay`, an `onError`
 * function and a finite `priority`, where those are given. The type says so, but a plugin is code
 * the host loads, so a wrong shape would otherwise fail in the middle of a run, sort as `NaN`, or
 * quietly apply to fewer agents than its author meant.
 */
export function assertInterceptorHooks(id: string, interceptor: PluginInterceptor): void {
  const appliesTo: unknown = interceptor.appliesTo;
  if (appliesTo !== undefined && appliesTo !== 'every-agent') {
    throw new TypeError(`The interceptor "${id}" has an \`appliesTo\` that is not "every-agent".`);
  }
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

/** Registers every hook `contributed` declares on `registry`, as {@link interceptorsOf} describes. */
function registerInterceptor(
  registry: HookRegistry<OperativeHookMap>,
  contributed: ContributedInterceptor,
): void {
  for (const point of INTERCEPTOR_POINTS) {
    const handler = contributed.interceptor[point];
    if (handler === undefined) continue;
    const { handler: hook, options } = interceptorHookParts(handler);
    registry.on(point, hook, {
      id: `${contributed.id}:${point}`,
      source: contributed.plugin,
      ...options,
    });
  }
}

/**
 * The agent-tier hook registry for the interceptors `definition` chooses, or `undefined` when it
 * chooses none. Each entry carries `source: <plugin>` and the id `<plugin>:<name>:<hook>`, and the
 * `replay`, `onError` and `priority` its hook declares, the priority held between
 * {@link INTERCEPTOR_PRIORITY_FLOOR} and {@link INTERCEPTOR_PRIORITY_CEILING}. Every id
 * must resolve (see {@link unresolvedContributions}); one that does not is skipped. One that applies to
 * every agent is registered here too, and Bureau leaves it out of that run's plugin tier (COR-2127).
 */
export function interceptorsOf(
  definition: Pick<AgentFileDefinition, 'interceptors'>,
  contributions: AgentContributions,
): HookRegistry<OperativeHookMap> | undefined {
  const registry = new HookRegistry<OperativeHookMap>();
  for (const id of new Set(definition.interceptors ?? [])) {
    const contributed = contributions.interceptors.get(id);
    if (contributed === undefined) continue;
    registerInterceptor(registry, contributed);
  }
  return registry.getHookNames().length === 0 ? undefined : registry;
}

/**
 * The plugin-tier hook registry (COR-2127): every interceptor `contributions` holds that declares
 * `appliesTo: 'every-agent'`, registered as {@link interceptorsOf} registers a chosen one, or
 * `undefined` when there is none. A fresh registry per call, which Bureau composes between its own
 * tier and the agent's for every run it starts, resumes or dispatches.
 */
export function everyAgentInterceptorsOf(
  contributions: AgentContributions,
): HookRegistry<OperativeHookMap> | undefined {
  const registry = new HookRegistry<OperativeHookMap>();
  for (const contributed of contributions.interceptors.values()) {
    if (contributed.interceptor.appliesTo === 'every-agent') {
      registerInterceptor(registry, contributed);
    }
  }
  return registry.getHookNames().length === 0 ? undefined : registry;
}
