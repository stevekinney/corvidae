import { AGENT_PAGE_COPY, AGENTS_COPY } from '../../app/copy.ts';
import type { AgentDetail } from '../../lib/agent-definitions.ts';
import type { AgentModels, AgentSummary, ChatContext } from '../../lib/bureau-client.ts';

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
  /** How many of the chats have a run going now: the Bureau's `running` activity. */
  readonly running: number;
};

/**
 * The chat count and last-chat time of each agent, from the sessions the Bureau lists. Both are the
 * Bureau's own figures grouped by the agent each session names: a count is the sessions, and the
 * last-chat time is the latest `updatedAt` among them (a session that is still being talked in
 * counts as used now). `waiting` counts the sessions that wait on the person, and `running` the
 * ones with a run going. A session read twice counts once. An agent with no session has no entry.
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
      running: (known?.running ?? 0) + (context.activity === 'running' ? 1 : 0),
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
      skills: definition?.card.map((skill) => ({ id: skill.id, name: skill.name })) ?? [],
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

/** The status line under an agent's description: its words, and the tone of the dot beside them. */
export type AgentStatusLine = {
  /** The dot's tone, or `null` for a line with no dot. */
  readonly tone: 'warning' | 'info' | 'neutral' | null;
  /** "Waiting on you, 3 chats", "Unavailable, 1 chat", "No chats yet" or "3 chats". */
  readonly text: string;
};

/**
 * The status line under an agent's description (board PageAgent, rows 38b, 39c and 39o): what its
 * chats are doing, in the tone of the dot beside it, then how many chats it has. A chat that waits
 * on the person comes first, then one that is running. An agent a disabled plugin ships is
 * unavailable whatever its chats are doing. An agent with no chats says so alone, and one whose
 * chats are all at rest has only its count, with no dot. `undefined` while the chats are not
 * `known`.
 */
export function agentStatusLine(
  usage: AgentChatUsage | undefined,
  options: { readonly known: boolean; readonly unavailable: boolean },
): AgentStatusLine | undefined {
  const words = AGENT_PAGE_COPY.header;
  const count = usage?.count ?? 0;
  if (options.unavailable) {
    const text = options.known
      ? words.status(words.unavailable, AGENTS_COPY.chatCount(count))
      : words.unavailable;
    return { tone: 'neutral', text };
  }
  if (!options.known) return undefined;
  if (usage === undefined || count === 0) return { tone: null, text: words.noChats };
  if (usage.waiting > 0) {
    return { tone: 'warning', text: words.status(words.waiting, AGENTS_COPY.chatCount(count)) };
  }
  if (usage.running > 0) {
    return { tone: 'info', text: words.status(words.running, AGENTS_COPY.chatCount(count)) };
  }
  return { tone: null, text: AGENTS_COPY.chatCount(count) };
}

/**
 * How many tools an agent may call, for its Access tab's count: the tools its file names, the tools
 * an agent defined in code states for itself, or else the tools its listing names. `undefined`
 * when none of them says, which is never shown as none.
 */
export function allowedToolCount(
  detail: Pick<AgentDetail, 'definition' | 'codeDefinition'> | undefined,
  listed: readonly string[] | undefined,
): number | undefined {
  const tools = detail?.definition?.tools ?? detail?.codeDefinition?.tools ?? listed;
  return tools?.length;
}

/**
 * A tab's count as the tab bar shows it after the tab's name: the number, with a plus when only the
 * first pages have been read, or `undefined` while it is not known. Zero is shown, because an empty
 * tab is a fact the person reads before opening it (board PageAgent, row 39o).
 */
export function tabCountText(count: number | undefined, more = false): string | undefined {
  if (count === undefined) return undefined;
  return `${String(count)}${more ? '+' : ''}`;
}

/** The short form of an agent file's hash that names its version, as the revision history shows it. */
export function shortVersion(hash: string): string {
  return hash.slice(0, 8);
}
