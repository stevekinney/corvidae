import { AGENTS_COPY, MEMORY_COPY } from '../../app/copy.ts';
import type { AgentDetail } from '../../lib/agent-definitions.ts';
import type { AgentModels, AgentSummary, ChatContext } from '../../lib/bureau-client.ts';
import { formatRelativeTime } from '../../lib/format/index.ts';

/** The path that opens a new chat with `agent`. */
export function newChatPath(agent: string): string {
  return `/chats/new?agent=${encodeURIComponent(agent)}`;
}

/** What the chats an agent has had say of its use: how many, and when the latest was last active. */
export type AgentChatUsage = {
  readonly count: number;
  readonly lastChatAt: number | null;
  /** How many of the chats wait on the person: the Bureau's `awaiting-input` activity. */
  readonly waiting: number;
};

/**
 * The chat count and last-chat time of each agent, from the sessions the Bureau lists. Both are the
 * Bureau's own figures grouped by the agent each session names: a count is the sessions, and the
 * last-chat time is the latest `updatedAt` among them (a session that is still being talked in
 * counts as used now). `waiting` counts the sessions that wait on the person. A session read twice counts once. An agent with no session has no entry.
 */
export function chatUsageByAgent(
  contexts: readonly Pick<ChatContext, 'id' | 'agentName' | 'updatedAt' | 'activity'>[],
): ReadonlyMap<string, AgentChatUsage> {
  const usage = new Map<string, AgentChatUsage>();
  // The Bureau pages by offset, and a list that shifts while it is read gives the next page a
  // session the last one already gave: a session is one chat, so it counts once.
  const counted = new Set<string>();
  for (const context of contexts) {
    if (counted.has(context.id)) continue;
    counted.add(context.id);
    const updated = Date.parse(context.updatedAt);
    const known = usage.get(context.agentName);
    const latest = Number.isNaN(updated) ? null : updated;
    usage.set(context.agentName, {
      count: (known?.count ?? 0) + 1,
      waiting: (known?.waiting ?? 0) + (context.activity === 'awaiting-input' ? 1 : 0),
      lastChatAt:
        latest === null
          ? (known?.lastChatAt ?? null)
          : Math.max(latest, known?.lastChatAt ?? latest),
    });
  }
  return usage;
}

/** The words for how many chats an agent has had, whatever the usage says (none when it has no entry). */
export function chatCountText(usage: AgentChatUsage | undefined): string {
  return usage === undefined ? AGENTS_COPY.noChats : AGENTS_COPY.chatCount(usage.count);
}

/** "Last chat 3m ago", or `undefined` when the agent has had no chat whose time is known. */
export function lastChatText(
  usage: AgentChatUsage | undefined,
  now: number = Date.now(),
): string | undefined {
  if (usage === undefined || usage.lastChatAt === null) return undefined;
  return AGENTS_COPY.lastChat(formatRelativeTime(usage.lastChatAt, now));
}

/**
 * What the Bureau lets the browser know of an agent's model, tools, and skills, put as the views
 * show them. `model` is a name for an agent that names one, and `unknown` while it is being read or
 * when it cannot be told: a routed agent, a file the Bureau has not answered for, or an agent
 * defined in code whose generator the Bureau cannot look inside (`media` is `null`). Such a
 * generator may be a script or a model call; the listing does not say which, so no model is shown
 * for it rather than a guess. `tools` is
 * `null` when the tools cannot be known (an agent whose listing carries no tools, such as one that
 * is not a `createAgent` result), and an unknown list is never shown as an empty one.
 */
export type AgentFacts = {
  readonly model: { readonly kind: 'model'; readonly name: string } | { readonly kind: 'unknown' };
  readonly tools: readonly string[] | null;
  /** Each skill by its identifier, the only thing about it that is unique, and the name it shows as. */
  readonly skills: readonly { readonly id: string; readonly name: string }[];
};

export function agentFacts(
  agent: Pick<AgentSummary, 'kind' | 'media'> & { readonly tools?: readonly string[] | undefined },
  definition: AgentDetail['definition'] | undefined,
  models: AgentModels | undefined,
): AgentFacts {
  if (agent.kind === 'file') {
    return {
      model:
        definition === null || definition === undefined
          ? { kind: 'unknown' }
          : { kind: 'model', name: definition.model },
      tools: definition?.tools ?? agent.tools ?? null,
      skills:
        definition?.skillDescriptors.map((skill) => ({ id: skill.id, name: skill.name })) ?? [],
    };
  }
  // A code-defined agent with no model descriptor has an opaque generator: it may be a script or a
  // model the Bureau cannot introspect, and the listing does not say which, so it claims neither.
  // One with descriptors names its model through `bureau.agents.models`, when it has a single one.
  if (agent.media === null) {
    return { model: { kind: 'unknown' }, tools: agent.tools ?? null, skills: [] };
  }
  const only = models?.default ?? (models?.models.length === 1 ? models.models[0] : undefined);
  return {
    model: only === undefined ? { kind: 'unknown' } : { kind: 'model', name: only.model },
    tools: agent.tools ?? null,
    skills: [],
  };
}

/** The words for how many tools an agent has, or `undefined` when its tools are not known. */
export function toolCountText(tools: readonly string[] | null): string | undefined {
  if (tools === null) return undefined;
  return tools.length === 0 ? AGENTS_COPY.noTools : AGENTS_COPY.toolCount(tools.length);
}

/**
 * The label of an agent's Memory action. The count follows once the Bureau has said how many
 * memories there are, with a plus when only the first page of them has been read; an agent that
 * remembers nothing is just "Memory", because "Memory (0)" reads as a fault.
 */
export function memoryActionText(count: number | undefined, more: boolean): string {
  if (count === undefined || (count === 0 && !more)) return MEMORY_COPY.link;
  return AGENTS_COPY.memoryWithCount(count, more);
}

/** The short form of an agent file's hash that names its version, as the revision history shows it. */
export function shortVersion(hash: string): string {
  return hash.slice(0, 8);
}
