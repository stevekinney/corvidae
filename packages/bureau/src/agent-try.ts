/**
 * Trying an unsaved agent definition (COR-1911): `bureau.agents.try` builds an agent from a
 * definition a person is still editing, with no file and no catalog entry, and starts a throwaway
 * context with it.
 *
 * A tried agent is a name in this module's registry and nowhere else. It is held in memory for the
 * life of the context it started: the catalog never lists it, no file or snapshot records it, a
 * schedule, goal, workflow or child cannot name it (each looks the name up in the catalog and finds
 * nothing), and deleting its context drops it. Its name starts with {@link TRY_AGENT_NAME_START},
 * which is not a valid agent identifier, so no agent file or catalog key can ever be it.
 *
 * What a tried run may not do is enforced in three places, not one. The definition may not list a
 * tool that writes memory, schedules work, or delegates ({@link tryToolProblem}); the run is built
 * without memory hooks and without the `scheduleWakeup` and `decide` tools; and Bureau refuses a
 * child whose parent is a tried run. The tool list is by name, because a tool is only a name in
 * the host's catalog; the other two hold whatever a host calls its tools.
 *
 * @module agent-try
 */

import type { AgentFileDefinitionInput, AgentFileProblem } from './agent-file';
import type { AnyRunnableAgent } from './agent-catalog';

/**
 * The start of every tried agent's name. A colon is not in `AGENT_IDENTIFIER_PATTERN`, so the name
 * of an agent file never starts with it.
 */
export const TRY_AGENT_NAME_START = 'try:';

/** Whether `agentName` is the name of a tried agent: one that is held in memory for a context. */
export function isTryAgentName(agentName: string): boolean {
  return agentName.startsWith(TRY_AGENT_NAME_START);
}

/**
 * Why a tool may not be named by a definition that is being tried, by the tool's name in the
 * deployment's tool catalog: what it would let a throwaway chat leave behind.
 */
const REFUSED_TOOLS: Readonly<Record<string, string>> = Object.freeze({
  memory_store: 'writes memory',
  memory_forget: 'writes memory',
  scheduleSelf: 'schedules work',
  scheduleWakeup: 'schedules work',
  'bureau:workflows-create': 'creates workflows, which run on schedules',
  'bureau:workflows-update': 'changes workflows, which run on schedules',
  'bureau:workflows-pause': 'changes workflows, which run on schedules',
  'bureau:workflows-resume': 'changes workflows, which run on schedules',
  'settings-update': 'changes the deployment’s settings',
});

/** The name of the tool `createHandoffTool` makes when it is not given one: a delegation. */
const HANDOFF_TOOL_START = 'transfer_to_';

/**
 * The first tool of `definition` that a tried agent may not have, as the problem a refused file
 * reports (field-named: each issue's `path` is `tools.<index>`), or `undefined` when none is.
 * Every refused tool is reported, not only the first.
 */
export function tryToolProblem(definition: AgentFileDefinitionInput): AgentFileProblem | undefined {
  const issues: { path: string; message: string }[] = [];
  (definition.tools ?? []).forEach((name, index) => {
    const reason = Object.hasOwn(REFUSED_TOOLS, name)
      ? REFUSED_TOOLS[name]
      : name.startsWith(HANDOFF_TOOL_START)
        ? 'hands the conversation to another agent'
        : undefined;
    if (reason !== undefined) {
      issues.push({
        path: `tools.${index}`,
        message: `"${name}" ${reason}, which a definition that is being tried cannot do. Remove it, or save the agent first.`,
      });
    }
  });
  if (issues.length === 0) return undefined;
  return {
    code: 'invalid-frontmatter',
    message: `The definition cannot be tried: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
    issues,
  };
}

/** One tried agent, held for the context that started it. */
export interface TryAgentEntry {
  /** The agent's name, which starts with {@link TRY_AGENT_NAME_START}. */
  readonly name: string;
  readonly agent: AnyRunnableAgent;
  /**
   * The definition `agent` was built from. A tried agent has no file to read back, so this is where
   * a check that weighs its tools (whether a remembered grant loosens one, COR-1990) reads them.
   */
  readonly definition: AgentFileDefinitionInput;
  /** The owner of record of the context, who alone may run the agent. */
  readonly owner: string;
  /** The one context the agent belongs to. */
  readonly contextId: string;
}

/** The tried agents of a Bureau. */
export interface TryAgents {
  /** Holds `entry` until {@link release}. */
  hold(entry: TryAgentEntry): void;
  /** The agent named `name`, for its owner only. */
  find(name: string, owner: string): AnyRunnableAgent | undefined;
  /** The agent named `name`, for whoever asks: what a check of its models reads, not a run. */
  peek(name: string): AnyRunnableAgent | undefined;
  /**
   * The definition the agent named `name` was built from, for whoever asks, or `undefined` when no
   * such agent is held.
   */
  definitionOf(name: string): AgentFileDefinitionInput | undefined;
  /** The context the agent named `name` belongs to, or `undefined` when no such agent is held. */
  contextOf(name: string): string | undefined;
  /** Drops the agent named `name`, if `contextId` is the context it belongs to. */
  release(name: string, contextId: string): void;
  /**
   * Drops the agent named `name` as {@link release} does, and returns the entry it dropped, so a
   * deletion that fails after it can {@link hold} the agent again. `undefined` when `contextId`
   * is not the context the agent belongs to.
   */
  take(name: string, contextId: string): TryAgentEntry | undefined;
  /** How many agents are held. */
  readonly size: number;
}

/** A registry with nothing in it. */
export function createTryAgents(): TryAgents {
  const held = new Map<string, TryAgentEntry>();
  return {
    hold: (entry) => {
      held.set(entry.name, entry);
    },
    find: (name, owner) => {
      const entry = held.get(name);
      return entry !== undefined && entry.owner === owner ? entry.agent : undefined;
    },
    peek: (name) => held.get(name)?.agent,
    definitionOf: (name) => held.get(name)?.definition,
    contextOf: (name) => held.get(name)?.contextId,
    release: (name, contextId) => {
      if (held.get(name)?.contextId === contextId) held.delete(name);
    },
    take: (name, contextId) => {
      const entry = held.get(name);
      if (entry?.contextId !== contextId) return undefined;
      held.delete(name);
      return entry;
    },
    get size() {
      return held.size;
    },
  };
}
