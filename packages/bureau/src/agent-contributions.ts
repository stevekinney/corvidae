/**
 * COR-1877 — the guardrails and run hooks plugins contribute, which an agent file chooses by id.
 *
 * Operative's default guardrail preset guards every agent. An agent file's `guardrails: [ids]` adds
 * plugin guardrails to it, and its `hooks: [ids]` adds plugin run hooks. An id is `plugin:name`,
 * the form Armorer's `formatToolId` writes, and a file writes it without a version: a file floats
 * with the plugin that contributes it. An id the contributions do not hold makes the agent invalid
 * with `reference-unresolved`.
 *
 * A guardrail is one input detector or one output validator, named by its own `name`. A run hook
 * set is one `PluginRunHooks`, named by its own `name`. Every run hook the set registers carries
 * `source: <plugin>`, which survives `mergeHookRegistries`, so the run's hook plan says which
 * plugin each entry came from.
 *
 * @module agent-contributions
 */

import type { PluginGuardrails, PluginRunHooks } from '@lostgradient/interborough-plugin';
import { HookRegistry } from '@lostgradient/lifecycle';
import type {
  GuardrailAdditions,
  OperativeHookMap,
  OutputValidator,
} from '@lostgradient/operative';
import { formatToolId, type InputDetector } from 'armorer';

import type { AgentFileDefinition, AgentFileIssue } from './agent-file';

/** What one plugin contributes that an agent file can choose. */
export interface AgentContributionSource {
  /** The plugin's name; the first half of each id and the `source` of each run hook. */
  readonly plugin: string;
  /** The plugin's guardrails, each selectable by its own name. */
  readonly guardrails?: PluginGuardrails | undefined;
  /** The plugin's run hook sets, each selectable by its own name. */
  readonly runHooks?: readonly PluginRunHooks[] | undefined;
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

/** One run hook set a plugin contributes. */
export interface ContributedRunHooks {
  /** `plugin:name`, as an agent file writes it. */
  readonly id: string;
  /** The contributing plugin. */
  readonly plugin: string;
  /** The hooks themselves. */
  readonly hooks: PluginRunHooks;
}

/** The guardrails and run hooks an agent file may choose, by id. */
export interface AgentContributions {
  /** Every contributed guardrail, by id. */
  readonly guardrails: ReadonlyMap<string, ContributedGuardrail>;
  /** Every contributed run hook set, by id. */
  readonly runHooks: ReadonlyMap<string, ContributedRunHooks>;
}

/** No contributions: an agent file that lists any is invalid. */
export const NO_AGENT_CONTRIBUTIONS: AgentContributions = Object.freeze({
  guardrails: new Map<string, ContributedGuardrail>(),
  runHooks: new Map<string, ContributedRunHooks>(),
});

/**
 * Collects what plugins contribute into the lookup agent files resolve against. Throws `TypeError`
 * when two guardrails share an id, or two run hook sets do: a file names a contribution by id
 * alone, so an id that means two things would run whichever came first.
 */
export function createAgentContributions(
  sources: readonly AgentContributionSource[],
): AgentContributions {
  const guardrails = new Map<string, ContributedGuardrail>();
  const runHooks = new Map<string, ContributedRunHooks>();
  for (const { plugin, guardrails: contributed, runHooks: hookSets } of sources) {
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
    for (const hooks of hookSets ?? []) {
      const id = formatToolId({ namespace: plugin, name: hooks.name });
      if (runHooks.has(id)) {
        throw new TypeError(`The run hooks "${id}" are contributed more than once.`);
      }
      runHooks.set(id, { id, plugin, hooks });
    }
  }
  return { guardrails, runHooks };
}

/**
 * The ids `definition` lists that `contributions` does not hold, as the issues of a
 * `reference-unresolved` problem: each names the key and the position in it.
 */
export function unresolvedContributions(
  definition: Pick<AgentFileDefinition, 'guardrails' | 'hooks'>,
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
  (definition.hooks ?? []).forEach((id, index) => {
    if (!contributions.runHooks.has(id)) {
      issues.push({
        path: `hooks.${index}`,
        message: `"${id}" is not a contributed run hook set`,
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

const RUN_HOOK_NAMES = [
  'prepareStep',
  'beforeToolExecution',
  'afterToolExecution',
  'onStep',
  'validateResponse',
] as const;

/**
 * The agent-tier hook registry for the run hooks `definition` chooses, or `undefined` when it
 * chooses none. Each entry carries `source: <plugin>` and the id `<plugin>:<name>:<hook>`. Every id
 * must resolve (see {@link unresolvedContributions}); one that does not is skipped.
 */
export function runHooksOf(
  definition: Pick<AgentFileDefinition, 'hooks'>,
  contributions: AgentContributions,
): HookRegistry<OperativeHookMap> | undefined {
  const registry = new HookRegistry<OperativeHookMap>();
  for (const id of new Set(definition.hooks ?? [])) {
    const contributed = contributions.runHooks.get(id);
    if (contributed === undefined) continue;
    for (const hookName of RUN_HOOK_NAMES) {
      const handler = contributed.hooks[hookName];
      if (handler === undefined) continue;
      registry.on(hookName, handler, {
        id: `${id}:${hookName}`,
        source: contributed.plugin,
      });
    }
  }
  return registry.getHookNames().length === 0 ? undefined : registry;
}
