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
import { HookRegistry } from '@lostgradient/lifecycle';
import {
  type GuardrailAdditions,
  type GuardrailEntry,
  guardrailOf,
  type InputDetector,
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
 * when two guardrails share an id, or two interceptors do: a file names a contribution by id
 * alone, so an id that means two things would run whichever came first. Throws too for a guardrail
 * without a non-empty `description` (COR-2118), which a listing could not tell apart.
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
      const { description } = guardrailOf(entry[family] as Parameters<typeof guardrailOf>[0]) as {
        readonly description?: unknown;
      };
      if (typeof description !== 'string' || description.trim() === '') {
        throw new TypeError(`The guardrail "${id}" has no description.`);
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

const INTERCEPTOR_HOOK_NAMES = [
  'prepareStep',
  'beforeToolExecution',
  'afterToolExecution',
  'onStep',
  'validateResponse',
] as const;

/**
 * The agent-tier hook registry for the interceptors `definition` chooses, or `undefined` when it
 * chooses none. Each entry carries `source: <plugin>` and the id `<plugin>:<name>:<hook>`. Every id
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
    for (const hookName of INTERCEPTOR_HOOK_NAMES) {
      const handler = contributed.interceptor[hookName];
      if (handler === undefined) continue;
      registry.on(hookName, handler, {
        id: `${id}:${hookName}`,
        source: contributed.plugin,
      });
    }
  }
  return registry.getHookNames().length === 0 ? undefined : registry;
}
