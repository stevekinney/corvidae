/**
 * The command palette's search: chats and agents first, then runs, schedules, workers and reviews
 * via each domain's list operation, then the console's own pages.
 *
 * Each domain search runs independently and swallows its own failure (a 403
 * from a scope this principal lacks, a transient network error) rather than
 * failing the whole palette — a search-as-you-type surface degrading one
 * section to "no results" beats it going blank. Schedules are not searched at
 * all without `schedules:read`, which `weft.schedules.list` requires.
 */
import type {
  HttpClient,
  ReviewListEntry,
  ScheduleSummary,
  WorkflowSummary,
} from '@lostgradient/weft';

import {
  listAgents,
  listContexts,
  type AgentSummary,
  type ChatContext,
} from '../../lib/bureau-client.ts';
import { scheduleDetailPath } from '../../lib/router.svelte.ts';
import type { ScopeGate } from '../../lib/scopes.svelte.ts';
import { canChat } from '../../routes/agents/agent-presentation.ts';
import { VIEW_COPY } from '../copy.ts';
import type { ViewName } from '../views.ts';

export interface ConsoleSearchResults {
  readonly chats: ChatContext[];
  readonly agents: AgentSummary[];
  /** The published agents whose name matches, each of which a new chat can be opened with. */
  readonly newChats: AgentSummary[];
  readonly workflows: WorkflowSummary[];
  readonly schedules: ScheduleSummary[];
  readonly workers: { id: string; queue: string }[];
  readonly reviews: ReviewListEntry[];
  /** The console's own pages whose name matches. */
  readonly pages: ConsolePage[];
}

export interface ConsoleSearchOptions {
  /** Whether the principal holds `schedules:read`; without it schedules are not searched. */
  readonly scheduleReadGate: ScopeGate;
}

/** One of the console's own pages, as the palette offers it. */
export interface ConsolePage {
  readonly view: ViewName;
  readonly label: string;
  readonly path: string;
  /** `command` for "Go to Reviews", which the palette lists with its commands; `engine` for the rest. */
  readonly group: 'command' | 'engine';
}

/** Where a schedule's own page is. */
export function schedulePath(scheduleId: string): string {
  return scheduleDetailPath(scheduleId);
}

/** Where a worker's own page is: the workers view, on its list, with the worker selected. */
export function workerPath(workerId: string): string {
  return `/workers?tab=list&worker=${encodeURIComponent(workerId)}`;
}

const WORKFLOW_ID_PREFIX_PATTERN = /^[A-Za-z0-9_-]+$/;

/** How many rows of one kind the palette lists. */
const RESULTS_PER_GROUP = 5;

/** How many sessions the palette reads to search; the newest are the ones a person is after. */
const CHATS_SEARCHED = 100;

/** Reviews and the engine's pages, which the palette opens by name; the other views have groups of their own. */
const CONSOLE_PAGES: readonly ConsolePage[] = (
  [
    ['reviews', '/reviews', 'command'],
    ['workers', '/workers', 'engine'],
    ['storage', '/storage', 'engine'],
    ['system', '/system', 'engine'],
    ['audit', '/audit', 'engine'],
  ] as const
).map(([view, path, group]) => ({ view, label: VIEW_COPY[view].label, path, group }));

function containsQuery(needle: string, text: string | null | undefined): boolean {
  return text !== null && text !== undefined && text.toLowerCase().includes(needle.toLowerCase());
}

/** The sessions whose title, agent or last message holds `query`, in the order given. */
export function matchChats(contexts: readonly ChatContext[], query: string): ChatContext[] {
  return contexts
    .filter(
      (context) =>
        containsQuery(query, context.title) ||
        containsQuery(query, context.agentName) ||
        containsQuery(query, context.lastMessagePreview),
    )
    .slice(0, RESULTS_PER_GROUP);
}

/** The agents whose name, display name or description holds `query`, in the order given. */
export function matchAgents(agents: readonly AgentSummary[], query: string): AgentSummary[] {
  return agents
    .filter(
      (agent) =>
        containsQuery(query, agent.name) ||
        containsQuery(query, agent.displayName) ||
        containsQuery(query, agent.description),
    )
    .slice(0, RESULTS_PER_GROUP);
}

/** The words of the command that opens a chat with the agent named `name`. */
export function newChatLabel(name: string): string {
  return `New chat with ${name}`;
}

/** The agents a chat can be opened with whose command holds `query`: only a published agent is offered. */
export function matchNewChats(agents: readonly AgentSummary[], query: string): AgentSummary[] {
  return agents
    .filter((agent) => canChat(agent) && containsQuery(query, newChatLabel(agent.name)))
    .slice(0, RESULTS_PER_GROUP);
}

/** The pages of the console whose name holds `query`, with or without "Go to". */
export function matchPages(query: string): ConsolePage[] {
  return CONSOLE_PAGES.filter((page) => containsQuery(query, `go to ${page.label}`));
}

const NO_RESULTS: ConsoleSearchResults = {
  chats: [],
  agents: [],
  newChats: [],
  workflows: [],
  schedules: [],
  workers: [],
  reviews: [],
  pages: [],
};

/**
 * Search every domain for `query`. An empty query returns empty results.
 *
 * `client.list({ idPrefix })` is server-side filtering per its documented
 * `ListFilter.idPrefix` contract — but `HttpClient`'s own query-string builder
 * (`buildWorkflowListSearchParams`) never serializes `idPrefix` into the
 * request, so the server always receives an unfiltered `limit`-only query and
 * the prefix is silently dropped. Workaround, not a weft fork: still pass
 * `idPrefix` (free once the bug is fixed, and lets the server apply `limit`
 * meaningfully today), but also re-filter client-side so the palette is
 * correct regardless.
 */
export async function searchConsole(
  client: HttpClient,
  query: string,
  options: ConsoleSearchOptions,
): Promise<ConsoleSearchResults> {
  if (query.length === 0) return NO_RESULTS;

  const idPrefix = WORKFLOW_ID_PREFIX_PATTERN.test(query) ? query : undefined;

  const [contexts, agents, workflows, schedules, workers, reviews] = await Promise.all([
    listContexts({ limit: CHATS_SEARCHED }).then(
      (page) => page.contexts,
      () => [] as ChatContext[],
    ),
    listAgents().then(
      (list) => list,
      () => [] as readonly AgentSummary[],
    ),
    idPrefix
      ? client.list({ idPrefix, limit: 50 }).then(
          (result) =>
            result.items
              .filter((workflow) => workflow.id.startsWith(idPrefix))
              .slice(0, RESULTS_PER_GROUP),
          () => [] as WorkflowSummary[],
        )
      : Promise.resolve([] as WorkflowSummary[]),
    options.scheduleReadGate.disabled
      ? Promise.resolve([] as ScheduleSummary[])
      : client.listSchedules({ limit: 100 }).then(
          (result) =>
            result.items
              .filter((schedule) => containsQuery(query, schedule.id))
              .slice(0, RESULTS_PER_GROUP),
          () => [] as ScheduleSummary[],
        ),
    client.operations['weft.workers.list']({}).then(
      (result) =>
        result.items
          .filter((worker) => containsQuery(query, worker.id))
          .slice(0, RESULTS_PER_GROUP),
      () => [] as { id: string; queue: string }[],
    ),
    client.listReviews({}).then(
      (result) =>
        result
          .filter((review) => containsQuery(query, review.reviewId))
          .slice(0, RESULTS_PER_GROUP),
      () => [] as ReviewListEntry[],
    ),
  ]);
  return {
    chats: matchChats(contexts, query),
    agents: matchAgents(agents, query),
    newChats: matchNewChats(agents, query),
    workflows,
    schedules,
    workers,
    reviews,
    pages: matchPages(query),
  };
}
