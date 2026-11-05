/**
 * The command palette's search: chats, runs (the Bureau's tasks by title, agent or identifier, then
 * a workflow run by the start of its identifier), workflows, schedules, workers and reviews via
 * each domain's list operation, then agents and tools. What is waiting on the
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
import { agentLabel } from '../../lib/agent-label.ts';
import {
  listAgents,
  listContexts,
  type AgentSummary,
  type ChatContext,
} from '../../lib/bureau-client.ts';
import { listTasks, type TaskState, type TaskView } from '../../lib/bureau-tasks.ts';
import { scheduleDetailPath } from '../../lib/router.svelte.ts';
import { kindOf, loadScheduleOverlay } from '../../lib/schedule-kinds.ts';
import type { ScopeGate } from '../../lib/scopes.svelte.ts';
import type { ShortcutAction } from '../../lib/shortcuts.ts';
import { taskStatusWord } from '../../lib/status.ts';
import { loadCatalog, type CatalogRow } from '../../lib/workflow-catalog.ts';
import {
  scheduleName,
  scheduleNameIdentifiers,
} from '../../routes/schedules/schedule-presentation.ts';
import { PALETTE_COPY, SHORTCUT_COPY } from '../copy.ts';
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

/** One run the palette lists: a Bureau task, in the words the Runs page uses for it. */
export interface RunMatch {
  readonly id: string;
  /** What the run is called: the start of the chat that began it, condensed, else its agent. */
  readonly title: string;
  /** The agent that ran, as its identifier, or `null` for a task recorded with none. */
  readonly agentName: string | null;
  readonly status: TaskState;
  /** What a run that waits on the person is waiting for, else `null`. */
  readonly waiting: 'approval' | 'answer' | null;
}

/** One schedule the palette lists, named in the words the Schedules page uses for it. */
export interface ScheduleMatch {
  readonly id: string;
  /** What the schedule is called: its description, else what it starts. Never its identifier. */
  readonly name: string;
  /** The parts of `name` that are identifiers, to be set in monospace. */
  readonly identifiers: string[];
  readonly workflowType: string;
  /** The type the schedule starts, for the row's meta, or `null` when the name already says it. */
  readonly workflowTypeShown: string | null;
}

export interface ConsoleSearchResults {
  readonly chats: ChatContext[];
  /** The Bureau's runs whose title, agent or identifier matches, most recently changed first. */
  readonly runs: RunMatch[];
  /** Each agent's identifier and the name a person reads, so a row names "Tool runner" and not `tool-runner`. */
  readonly agentNames: ReadonlyMap<string, string>;
  readonly agents: AgentSummary[];
  /** The workflow types whose name or description matches. */
  readonly definitions: CatalogRow[];
  /** Runs, by the start of their identifier. */
  readonly workflows: WorkflowSummary[];
  readonly schedules: ScheduleMatch[];
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

/**
 * A schedule as the palette lists it: named as the Schedules page names it (its description, else
 * the agent or workflow it starts), never by its identifier. The type is shown beside the name only
 * when the name does not already say it.
 */
export function scheduleMatch(
  schedule: Pick<ScheduleSummary, 'id' | 'workflowType' | 'description'>,
  overlay: Parameters<typeof kindOf>[1],
): ScheduleMatch {
  const kind = kindOf(schedule, overlay);
  const identifiers = scheduleNameIdentifiers(schedule, kind);
  return {
    id: schedule.id,
    name: scheduleName(schedule, kind),
    identifiers,
    workflowType: schedule.workflowType,
    workflowTypeShown:
      kind.kind === 'agent-run' || identifiers.includes(schedule.workflowType)
        ? null
        : schedule.workflowType,
  };
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
        containsQuery(query, agentLabel(agent.name, agents)) ||
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
 * newest first, in the order the bell lists them (design rows 03c, 03g: the refund approval from
 * 4 minutes ago leads the question from an hour ago). An empty `query` matches all of them.
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
        (containsQuery(query, item.title) ||
          containsQuery(query, item.detail) ||
          containsQuery(query, item.chat)),
    )
    .toSorted((left, right) => right.emittedAtMs - left.emittedAtMs)
    .slice(0, limit);
}

/** The words a waiting item is found by and read as: the sentence, then what it is about. */
export function waitingLabel(item: NotificationItem): string {
  return item.detail === '' ? item.title : `${item.title} · ${item.detail}`;
}

/** What a waiting item's row says after its sentence: the kind of wait ("Approval · waiting", "Question"). */
export function waitingMeta(item: NotificationItem): string {
  return item.kind === 'approval'
    ? PALETTE_COPY.waitingMeta.approval
    : PALETTE_COPY.waitingMeta.question;
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
  return actions
    .filter((action) => containsQuery(query, action.label))
    .toSorted((left, right) => actionRank(left) - actionRank(right))
    .slice(0, limit);
}

/**
 * Where an action sits in the list: the "Go to" rows first, then New chat, then the rest, with the
 * shortcut map last (design row 03c: navigation rows, then New chat). The sort is stable, so
 * actions of one rank keep the order they were registered in.
 */
function actionRank(action: ShortcutAction): number {
  switch (action.group) {
    case SHORTCUT_COPY.navigationGroup:
      return 0;
    case SHORTCUT_COPY.chatGroup:
      return 1;
    case SHORTCUT_COPY.generalGroup:
      return 3;
    default:
      return 2;
  }
}

/** The topic a "New chat about" action starts with: what was typed, trimmed. Nothing when nothing was. */
export function newChatTopic(query: string): string | undefined {
  const topic = query.trim();
  return topic === '' ? undefined : topic;
}

/** Where "New chat about <topic>" goes: a new chat whose box already holds the topic. */
export function newChatAboutPath(topic: string): string {
  return `/chats/new?about=${encodeURIComponent(topic)}`;
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
        containsQuery(query, tool.title) ||
        containsQuery(query, tool.shortDescription ?? tool.description),
    )
    .slice(0, RESULTS_PER_GROUP);
}

/** Where a tool is shown: the Capabilities page with the tool open. */
export function toolPath(name: string): string {
  return `/capabilities?tool=${encodeURIComponent(name)}`;
}

/**
 * What a run is called in the palette: the first clause of the chat that began it, so "Please
 * refund order 4471, it arrived damaged." reads "Refund order 4471" (design row 03g). A run no
 * chat began is called after its agent, and a task with neither is just "Run".
 */
export function runTitle(
  chat: Pick<ChatContext, 'title'> | undefined,
  agentName: string | undefined,
): string {
  const clause = (chat?.title ?? '')
    .split(/[,;:\n]|[.!?](?:\s|$)/)[0]
    ?.trim()
    .replace(/^please\s+/i, '');
  if (clause !== undefined && clause !== '') {
    return `${clause.charAt(0).toUpperCase()}${clause.slice(1)}`;
  }
  return agentName ?? PALETTE_COPY.untitledRun;
}

/** What a task waits on, from its open waits. */
function waitingOn(task: TaskView): RunMatch['waiting'] {
  if (task.status !== 'input-required') return null;
  const wait = task.openWaits[0];
  if (wait === undefined) return null;
  return wait.kind === 'tool-approval' ? 'approval' : 'answer';
}

/**
 * The runs (Bureau tasks, most recently changed first) whose title, agent or identifier holds
 * `query`. `chats` name what began each run, and `agentNames` read an agent's identifier as the
 * name a person knows it by.
 */
export function matchRuns(
  tasks: readonly TaskView[],
  chats: readonly ChatContext[],
  agentNames: ReadonlyMap<string, string>,
  query: string,
  limit: number = RESULTS_PER_GROUP,
): RunMatch[] {
  const chatsById = new Map(chats.map((chat) => [chat.id, chat] as const));
  const found: RunMatch[] = [];
  for (const task of tasks) {
    const agentText =
      task.agentName === null ? undefined : (agentNames.get(task.agentName) ?? task.agentName);
    const title = runTitle(chatsById.get(task.contextId), agentText);
    if (
      containsQuery(query, title) ||
      containsQuery(query, agentText) ||
      containsQuery(query, task.agentName) ||
      containsQuery(query, task.id)
    ) {
      found.push({
        id: task.id,
        title,
        agentName: task.agentName,
        status: task.status,
        waiting: waitingOn(task),
      });
      if (found.length === limit) break;
    }
  }
  return found;
}

/** Each agent's identifier and the name a person reads for it ("tool-runner" reads "Tool runner"). */
function agentNamesOf(agents: readonly AgentSummary[]): ReadonlyMap<string, string> {
  return new Map(agents.map((agent) => [agent.name, agentLabel(agent.name, agents)] as const));
}

/** What a run says of how it stands: what it waits on, or its state in a word ("waiting for approval", "done"). */
export function runStanding(run: Pick<RunMatch, 'status' | 'waiting'>): string {
  return run.waiting === null
    ? taskStatusWord(run.status).toLowerCase()
    : PALETTE_COPY.runWaiting[run.waiting];
}

/**
 * What a run's row says after its title: the agent that ran, then how it stands ("Tool runner ·
 * waiting for approval"). A run called after its agent does not name the agent twice.
 */
export function runMeta(run: RunMatch, agentText: string | undefined): string {
  return agentText === undefined || agentText === run.title
    ? runStanding(run)
    : `${agentText} · ${runStanding(run)}`;
}

/** How many of the newest runs the palette reads to search them. */
const RUNS_SEARCHED = 100;

/** Nothing found: what a query that reads nothing returns. */
export const NO_RESULTS: ConsoleSearchResults = {
  chats: [],
  runs: [],
  agentNames: new Map(),
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
      ? {
          ...NO_RESULTS,
          agents: matchAgents(agents, query, NARROWED_RESULTS),
          agentNames: agentNamesOf(agents),
          failed,
        }
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
  const [contexts, agents, definitions, tools, workflows, schedules, workers, reviews, tasks] =
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
        ? Promise.resolve([] as ScheduleMatch[])
        : reading(
            failed,
            groups.schedules,
            client.listSchedules({ limit: 100 }).then((result) =>
              loadScheduleOverlay(client).then((overlay) =>
                result.items
                  .map((schedule) => scheduleMatch(schedule, overlay))
                  .filter(
                    (schedule) =>
                      containsQuery(query, schedule.name) ||
                      containsQuery(query, schedule.id) ||
                      containsQuery(query, schedule.workflowType),
                  )
                  .slice(0, RESULTS_PER_GROUP),
              ),
            ),
            [] as ScheduleMatch[],
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
      reading(
        failed,
        groups.runs,
        listTasks({ limit: RUNS_SEARCHED }).then((page) => page.tasks),
        [] as readonly TaskView[],
      ),
    ]);
  const agentNames = agentNamesOf(agents);
  return {
    chats: matchChats(contexts, query),
    runs: matchRuns(tasks, contexts, agentNames, query),
    agentNames,
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
