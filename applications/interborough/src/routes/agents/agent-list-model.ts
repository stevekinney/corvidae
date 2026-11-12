/**
 * The rows of the Agents list as the page draws them (board PageAgents, "Agents, /agents"): the
 * agents that can run, from `bureau.agents.list`, and the ones a disabled plugin holds back, from
 * `bureau.agents.definitions.list` (state `unavailable`). A row carries what the two kinds share (a
 * human name, the identifier, a description, when it was last used and how many chats it has had)
 * and what only one has: a built-in agent, a model that needs a provider, an agent file that can be
 * edited, the reason a plugin's agent cannot run.
 */
import { AGENTS_COPY } from '../../app/copy/agents.ts';
import type { AgentListing } from '../../lib/agent-definitions.ts';
import { agentLabel } from '../../lib/agent-label.ts';
import { pluginOfAgent } from '../../lib/agent-paths.ts';
import type { AgentSummary } from '../../lib/bureau-client.ts';
import { calendarDay, clockTime, viewerTimeZone } from '../../lib/format/clock.ts';
import type { AgentChatUsage } from './agent-presentation.ts';

/** The locale the product's words are written in, as `lib/format/clock.ts` reads it. */
const LOCALE = 'en-US';

/** One agent of the list, whether it can run or its plugin holds it back. */
export type AgentRow = {
  /** The identifier, which is what the address and the Bureau name the agent by. */
  readonly id: string;
  /** The name a person reads, such as "Tool runner". */
  readonly title: string;
  readonly description: string | null;
  /** `unavailable` is an agent of a plugin that is disabled: it can be read, never run. */
  readonly state: 'available' | 'unavailable';
  /** Whether the host ships the agent itself: defined in code, with no plugin's namespace. */
  readonly builtIn: boolean;
  /** Whether the agent is a file, which has an editor. */
  readonly editable: boolean;
  /** Whether the agent answers with a model, so a chat with it needs a provider. */
  readonly usesModel: boolean;
  /** The plugin that ships the agent, by name, or `null` for the host's and the owner's own. */
  readonly plugin: string | null;
  /** Why an unavailable agent cannot run, in the host's words, or `null`. */
  readonly reason: string | null;
  /** The chats had with it, or `undefined` when the Bureau has not counted any. */
  readonly usage: AgentChatUsage | undefined;
};

/**
 * What an agent is called in a row: its display name in words ("tool-runner" reads "Tool runner"),
 * without the namespace of the plugin that ships it ("demo:tool-runner" is also "Tool runner").
 */
export function agentRowTitle(name: string): string {
  const bare = name.includes(' ') ? name : name.slice(name.indexOf(':') + 1);
  return agentLabel(bare, undefined);
}

/** The row of an agent that can run, from the Bureau's listing and the chats it has had. */
export function availableRow(
  agent: Pick<AgentSummary, 'name' | 'displayName' | 'description' | 'kind' | 'media'>,
  usage: AgentChatUsage | undefined,
): AgentRow {
  const plugin = pluginOfAgent(agent.name);
  return {
    id: agent.name,
    title: agentRowTitle(agent.displayName),
    description: agent.description,
    state: 'available',
    builtIn: agent.kind === 'code' && plugin === null,
    editable: agent.kind === 'file',
    usesModel: agent.media !== null,
    plugin,
    reason: null,
    usage,
  };
}

/** The row of an agent its plugin holds back, from the definitions list and the chats it has had. */
export function unavailableRow(
  listing: Pick<AgentListing, 'id' | 'name' | 'description' | 'unavailable'>,
  usage: AgentChatUsage | undefined,
): AgentRow {
  return {
    id: listing.id,
    title: agentRowTitle(listing.name),
    description: listing.description,
    state: 'unavailable',
    builtIn: false,
    editable: false,
    usesModel: false,
    plugin: pluginOfAgent(listing.id),
    reason: listing.unavailable?.message ?? null,
    usage,
  };
}

/**
 * When the agent was last used, as the right end of line one says it: the clock for today
 * ("10:42 AM"), "Yesterday" for the day before, the day for anything older ("Oct 21"), and "No
 * activity yet" for an agent no chat has touched.
 */
export function activityText(
  lastChatAt: number | null,
  now: number,
  zone: string = viewerTimeZone(),
): string {
  if (lastChatAt === null) return AGENTS_COPY.row.noActivity;
  const days = calendarDay(now, zone) - calendarDay(lastChatAt, zone);
  if (days <= 0) return clockTime(lastChatAt, zone);
  if (days === 1) return AGENTS_COPY.row.yesterday;
  return new Intl.DateTimeFormat(LOCALE, {
    month: 'short',
    day: 'numeric',
    timeZone: zone,
  }).format(lastChatAt);
}

/**
 * The agents most recently used first, and the ones no chat has touched last, in the order they
 * were listed. The sort is stable, so equal times keep the Bureau's order.
 */
export function sortByActivity(rows: readonly AgentRow[]): AgentRow[] {
  return rows.toSorted((a, b) => {
    const left = a.usage?.lastChatAt ?? null;
    const right = b.usage?.lastChatAt ?? null;
    if (left === right) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    return right - left;
  });
}

/** Whether the search words (already lower-cased) name the row: its title, identifier or description. */
export function rowMatches(row: AgentRow, needle: string): boolean {
  return (
    needle === '' ||
    row.title.toLowerCase().includes(needle) ||
    row.id.toLowerCase().includes(needle) ||
    (row.description ?? '').toLowerCase().includes(needle)
  );
}

/**
 * The plugins that hold agents back, by name and in the order the agents first name them. An
 * unavailable agent whose identifier carries no namespace has no plugin to name.
 */
export function holdingPlugins(rows: readonly AgentRow[]): string[] {
  const names: string[] = [];
  for (const row of rows) {
    if (row.state === 'unavailable' && row.plugin !== null && !names.includes(row.plugin)) {
      names.push(row.plugin);
    }
  }
  return names;
}

/** What a row's status column says: `waiting` for an agent with a chat that waits on the person, `unavailable` for a held-back agent. */
export function rowStatus(row: AgentRow): 'waiting' | 'unavailable' | undefined {
  if (row.state === 'unavailable') return 'unavailable';
  return row.usage !== undefined && row.usage.waiting > 0 ? 'waiting' : undefined;
}
