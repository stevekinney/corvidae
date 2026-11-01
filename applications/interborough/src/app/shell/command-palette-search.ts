/**
 * The command palette's search: chats, workflows (the types, then runs by id), schedules, workers
 * and reviews via each domain's list operation, then agents and tools. What is waiting on the
 * person and the actions (the registry's shortcuts, and "New chat with <agent>") are not searched
 * here: the palette lists them from the notification store and the shortcut registry.
 *
 * A query that starts with `>` is for actions only and one that starts with `@` is for agents only
 * ({@link parseQuery}); the first reads nothing, the second reads only the agents.
 *
 * Each domain search runs independently and survives its own failure (a 403
 * from a scope this principal lacks, a transient network error) rather than
 * failing the whole palette — a search-as-you-type surface degrading one
 * section beats it going blank. The domains that could not be read are named in
 * `failed`, so the palette never presents a failed search as "no matches".
 * Schedules are not searched at all without `schedules:read`, which
 * `weft.schedules.list` requires.
 */
import type {
  HttpClient,
  ReviewListEntry,
  ScheduleSummary,
  WorkflowSummary,
} from '@lostgradient/weft';

import { getAgentCatalog, type AgentCatalog } from '../../lib/agent-definitions.ts';
import {
  listAgents,
  listContexts,
  type AgentSummary,
  type ChatContext,
} from '../../lib/bureau-client.ts';
import { scheduleDetailPath } from '../../lib/router.svelte.ts';
import type { ScopeGate } from '../../lib/scopes.svelte.ts';
import type { ShortcutAction } from '../../lib/shortcuts.ts';
import { loadCatalog, type CatalogRow } from '../../lib/workflow-catalog.ts';
import { PALETTE_COPY } from '../copy.ts';
import type { NotificationItem } from '../notifications.svelte.ts';

/** One tool of the catalog, as the palette lists it. */
export type CatalogTool = AgentCatalog['tools'][number];

/** What a query is for: everything, only the actions (`>`), or only the agents (`@`). */
export type SearchMode = 'all' | 'actions' | 'agents';

/** A query read for its prefix. */
export interface ParsedQuery {
  readonly mode: SearchMode;
  /** What is searched for: the query without its prefix, trimmed. */
  readonly text: string;
}

/** Reads a query's prefix: `>` narrows to actions and `@` to agents. */
export function parseQuery(query: string): ParsedQuery {
  const trimmed = query.trimStart();
  if (trimmed.startsWith('>')) return { mode: 'actions', text: trimmed.slice(1).trim() };
  if (trimmed.startsWith('@')) return { mode: 'agents', text: trimmed.slice(1).trim() };
  return { mode: 'all', text: query.trim() };
}

export interface ConsoleSearchResults {
  readonly chats: ChatContext[];
  readonly agents: AgentSummary[];
  /** The workflow types whose name or description matches. */
  readonly definitions: CatalogRow[];
  /** Runs, by the start of their identifier. */
  readonly workflows: WorkflowSummary[];
  readonly schedules: ScheduleSummary[];
  readonly workers: { id: string; queue: string }[];
  readonly reviews: ReviewListEntry[];
  /** The tools of the catalog whose name or description matches. */
  readonly tools: CatalogTool[];
  /** The agents whose name matches, each of which a new chat can be opened with. */
  readonly newChats: AgentSummary[];
  /** The headings of the domains that could not be read, so their absence is not taken for "no matches". */
  readonly failed: readonly string[];
}

const OPEN_GATE: ScopeGate = { disabled: false, title: undefined };

export interface ConsoleSearchOptions {
  /** Whether the principal holds `schedules:read`; without it schedules are not searched. */
  readonly scheduleReadGate: ScopeGate;
  /** `workflows:read`: without it neither workflow types nor runs are searched. Open when omitted. */
  readonly workflowReadGate?: ScopeGate | undefined;
  /** `reviews:read`: without it reviews are not searched. Open when omitted. */
  readonly reviewReadGate?: ScopeGate | undefined;
  /** `system:read`: without it workers are not searched. Open when omitted. */
  readonly systemReadGate?: ScopeGate | undefined;
  /** Reads the workflow types; the shell answers from its query cache, so a keystroke does not read them again. */
  readonly readWorkflows?: (() => Promise<readonly CatalogRow[]>) | undefined;
  /** Reads the tools of the catalog, likewise. */
  readonly readTools?: (() => Promise<readonly CatalogTool[]>) | undefined;
}

/** Where a schedule's own page is. */
export function schedulePath(scheduleId: string): string {
  return scheduleDetailPath(scheduleId);
}

/** Where a worker's own page is: the workers view, on its list, with the worker selected. */
export function workerPath(workerId: string): string {
  return `/health/workers?worker=${encodeURIComponent(workerId)}`;
}

const WORKFLOW_ID_PREFIX_PATTERN = /^[A-Za-z0-9_-]+$/;

/** How many rows of one kind the palette lists. */
const RESULTS_PER_GROUP = 5;

/** How many rows a query that narrows to one kind lists. */
export const NARROWED_RESULTS = 20;

/** How many sessions the palette reads to search; the newest are the ones a person is after. */
const CHATS_SEARCHED = 100;

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
export function matchAgents(
  agents: readonly AgentSummary[],
  query: string,
  limit: number = RESULTS_PER_GROUP,
): AgentSummary[] {
  return agents
    .filter(
      (agent) =>
        containsQuery(query, agent.name) ||
        containsQuery(query, agent.displayName) ||
        containsQuery(query, agent.description),
    )
    .slice(0, limit);
}

/** The words of the command that opens a chat with the agent named `name`. */
export function newChatLabel(name: string): string {
  return `New chat with ${name}`;
}

/** The agents a chat can be opened with whose command holds `query`. */
export function matchNewChats(
  agents: readonly AgentSummary[],
  query: string,
  limit: number = RESULTS_PER_GROUP,
): AgentSummary[] {
  return agents.filter((agent) => containsQuery(query, newChatLabel(agent.name))).slice(0, limit);
}

/** How many of what is waiting on the person, and of the actions, the palette lists for a query that names no kind. */
const LOCAL_RESULTS = 8;

/**
 * What is waiting on the person (an approval, a question) whose sentence or chat holds `query`,
 * oldest first, because the one waiting longest is the one to answer first. An empty `query`
 * matches all of them.
 */
export function matchWaiting(
  items: readonly NotificationItem[],
  query: string,
  limit: number = LOCAL_RESULTS,
): NotificationItem[] {
  return items
    .filter(
      (item) =>
        (item.kind === 'approval' || item.kind === 'question') &&
        (containsQuery(query, item.title) || containsQuery(query, item.detail)),
    )
    .toSorted((left, right) => left.emittedAtMs - right.emittedAtMs)
    .slice(0, limit);
}

/** The words a waiting item is found by and read as: the sentence, then what it is about. */
export function waitingLabel(item: NotificationItem): string {
  return item.detail === '' ? item.title : `${item.title}${item.joiner}${item.detail}`;
}

/**
 * The actions (shortcuts that act everywhere) whose name holds `query`; an empty `query` matches
 * all of them. `limit` is left out for a query narrowed to actions.
 */
export function matchActions(
  actions: readonly ShortcutAction[],
  query: string,
  limit: number = LOCAL_RESULTS,
): ShortcutAction[] {
  return actions.filter((action) => containsQuery(query, action.label)).slice(0, limit);
}

/** The workflow types a person starts or edits (not the ones the Bureau runs itself) whose name or description holds `query`. */
export function matchDefinitions(rows: readonly CatalogRow[], query: string): CatalogRow[] {
  return rows
    .filter(
      (row) =>
        !row.engine && (containsQuery(query, row.name) || containsQuery(query, row.description)),
    )
    .slice(0, RESULTS_PER_GROUP);
}

/** The tools whose name or description holds `query`. */
export function matchTools(tools: readonly CatalogTool[], query: string): CatalogTool[] {
  return tools
    .filter(
      (tool) =>
        containsQuery(query, tool.name) ||
        containsQuery(query, tool.shortDescription ?? tool.description),
    )
    .slice(0, RESULTS_PER_GROUP);
}

/** Where a tool is shown: the Capabilities page with the tool open. */
export function toolPath(name: string): string {
  return `/capabilities?tool=${encodeURIComponent(name)}`;
}

/** Nothing found: what a query that reads nothing returns. */
export const NO_RESULTS: ConsoleSearchResults = {
  chats: [],
  agents: [],
  definitions: [],
  workflows: [],
  schedules: [],
  workers: [],
  reviews: [],
  tools: [],
  newChats: [],
  failed: [],
};

/**
 * Settles one domain's read: its rows, or `fallback` when it could not be read, after noting its
 * heading in `failed` so the palette can say the search was incomplete.
 */
function reading<Rows>(
  failed: string[],
  heading: string,
  read: Promise<Rows>,
  fallback: Rows,
): Promise<Rows> {
  return read.then(
    (rows) => rows,
    () => {
      failed.push(heading);
      return fallback;
    },
  );
}

/**
 * Search every domain for `rawQuery`. An empty query returns empty results, because the palette
 * then lists what is waiting and the actions. A query that starts with `>` or `@` reads only the
 * agents: `@` lists them, and `>` the chats each can be opened with.
 *
 * `client.list({ idPrefix })` is server-side filtering per its documented
 * `ListFilter.idPrefix` contract — but `HttpClient`'s own query-string builder
 * (`buildWorkflowListSearchParams`) never serializes `idPrefix` into the
 * request, so the server always receives an unfiltered `limit`-only query and
 * the prefix is silently dropped. Workaround, not a weft fork: still pass
 * `idPrefix` (free once the bug is fixed, and lets the server apply `limit`
 * meaningfully today), but also re-filter client-side so the palette is
 * correct regardless.
 *
 * A domain the principal's scopes do not cover is not read at all, and one that fails is no
 * results, so a search that returns nothing for a domain does not say it holds nothing.
 */
export async function searchConsole(
  client: HttpClient,
  rawQuery: string,
  options: ConsoleSearchOptions,
): Promise<ConsoleSearchResults> {
  const { mode, text: query } = parseQuery(rawQuery);
  if (mode !== 'all') {
    // Only the agents are read: `@` lists them, and `>` lists the chats each can be opened with.
    const failed: string[] = [];
    const agents = await reading(failed, PALETTE_COPY.groups.agents, listAgents(), []);
    return mode === 'agents'
      ? { ...NO_RESULTS, agents: matchAgents(agents, query, NARROWED_RESULTS), failed }
      : { ...NO_RESULTS, newChats: matchNewChats(agents, query, NARROWED_RESULTS), failed };
  }
  if (query.length === 0) return NO_RESULTS;

  const workflowGate = options.workflowReadGate ?? OPEN_GATE;
  const reviewGate = options.reviewReadGate ?? OPEN_GATE;
  const systemGate = options.systemReadGate ?? OPEN_GATE;
  const idPrefix =
    !workflowGate.disabled && WORKFLOW_ID_PREFIX_PATTERN.test(query) ? query : undefined;

  const failed: string[] = [];
  const groups = PALETTE_COPY.groups;
  const [contexts, agents, definitions, tools, workflows, schedules, workers, reviews] =
    await Promise.all([
      // Chats a person started: a goal's or a schedule's session is reached from its run.
      reading(
        failed,
        groups.chats,
        listContexts({ origin: 'chat', limit: CHATS_SEARCHED }).then((page) => page.contexts),
        [] as ChatContext[],
      ),
      reading(failed, groups.agents, listAgents(), [] as readonly AgentSummary[]),
      workflowGate.disabled
        ? Promise.resolve([] as readonly CatalogRow[])
        : reading(
            failed,
            groups.workflows,
            options.readWorkflows?.() ?? loadCatalog(client),
            [] as readonly CatalogRow[],
          ),
      reading(
        failed,
        groups.tools,
        options.readTools?.() ?? getAgentCatalog().then((catalog) => catalog.tools),
        [] as readonly CatalogTool[],
      ),
      idPrefix
        ? reading(
            failed,
            groups.runs,
            client
              .list({ idPrefix, limit: 50 })
              .then((result) =>
                result.items
                  .filter((workflow) => workflow.id.startsWith(idPrefix))
                  .slice(0, RESULTS_PER_GROUP),
              ),
            [] as WorkflowSummary[],
          )
        : Promise.resolve([] as WorkflowSummary[]),
      options.scheduleReadGate.disabled
        ? Promise.resolve([] as ScheduleSummary[])
        : reading(
            failed,
            groups.schedules,
            client
              .listSchedules({ limit: 100 })
              .then((result) =>
                result.items
                  .filter((schedule) => containsQuery(query, schedule.id))
                  .slice(0, RESULTS_PER_GROUP),
              ),
            [] as ScheduleSummary[],
          ),
      systemGate.disabled
        ? Promise.resolve([] as { id: string; queue: string }[])
        : reading(
            failed,
            groups.workers,
            client.operations['weft.workers.list']({}).then((result) =>
              result.items
                .filter((worker) => containsQuery(query, worker.id))
                .slice(0, RESULTS_PER_GROUP),
            ),
            [] as { id: string; queue: string }[],
          ),
      reviewGate.disabled
        ? Promise.resolve([] as ReviewListEntry[])
        : reading(
            failed,
            groups.reviews,
            client
              .listReviews({})
              .then((result) =>
                result
                  .filter((review) => containsQuery(query, review.reviewId))
                  .slice(0, RESULTS_PER_GROUP),
              ),
            [] as ReviewListEntry[],
          ),
    ]);
  return {
    chats: matchChats(contexts, query),
    agents: matchAgents(agents, query),
    definitions: matchDefinitions(definitions, query),
    workflows,
    schedules,
    workers,
    reviews,
    tools: matchTools(tools, query),
    newChats: matchNewChats(agents, query),
    failed,
  };
}

/**
 * Wraps a read so one that succeeded within `ttlMs` is answered again without asking, which keeps
 * a palette that searches as the person types from reading a catalog on every keystroke. A read
 * that fails is not kept.
 */
export function memoizeRead<T>(read: () => Promise<T>, ttlMs: number): () => Promise<T> {
  let kept: { readonly value: Promise<T>; readonly atMs: number } | undefined;
  return () => {
    const now = Date.now();
    if (kept !== undefined && now - kept.atMs < ttlMs) return kept.value;
    const value = read();
    const entry = { value, atMs: now };
    kept = entry;
    value.catch(() => {
      if (kept === entry) kept = undefined;
    });
    return value;
  };
}
