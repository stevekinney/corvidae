import type { HttpClient } from '@lostgradient/weft';
import type { QueryClient } from '@tanstack/svelte-query';

import { getAgentCatalog, getAgentDefinition } from '../lib/agent-definitions.ts';
import { queryAudit } from '../lib/bureau-audit.ts';
import { callBureau, listAgents, listContexts } from '../lib/bureau-client.ts';
import { getGoal, listGoals } from '../lib/bureau-goals.ts';
import { listBureauReviews } from '../lib/bureau-reviews.ts';
import { getSettings } from '../lib/bureau-settings.ts';
import { listTasks } from '../lib/bureau-tasks.ts';
import { DEFAULT_AGENT } from '../lib/default-agent.ts';
import { classifyFault } from '../lib/faults.ts';
import { listMemories } from '../lib/memory-client.ts';
import { AGENT_MEMORY_PATTERN, queryKeys } from '../lib/query.ts';
import {
  CATALOG_STALE_TIME_MS,
  loadCatalog,
  orNotFound,
  resolveWorkflow,
} from '../lib/workflow-catalog.ts';
import { getWorkflowFile } from '../lib/workflow-files.ts';
import type { ViewName } from './views.ts';

/**
 * What a view's probe learned: whether the thing the view lists has nothing in it. A probe whose
 * empty answer is about to change by itself, such as a workflow's runs before its first fire, sets
 * `recheckMs` and names the feed that reports the change (`liveSource`): the frame asks again when
 * that feed carries the event that can fill the view (`app/bureau-event-queries.ts` for the Bureau,
 * `lib/live-source/cache-integration.ts` for the engine), and on a timer, that often, only while the
 * feed is not live. Without it an empty view stays as it is until the person leaves and comes back.
 */
export type ViewProbeResult = {
  readonly empty: boolean;
  readonly recheckMs?: number;
  readonly liveSource?: 'bureau' | 'fleet';
};

/** How often an empty runs page asks again while the feed that would fill it is not live, the poll `/tasks/:id` uses for a task that has ended. */
export const RUNS_RECHECK_MS = 5_000;

/** A failure with an HTTP status, for a probe that does not go through Weft's client. */
export class ViewProbeFault extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ViewProbeFault';
    this.status = status;
  }
}

/** The route parameters a probe may depend on. */
export type ViewProbeParameters = Readonly<Record<string, string>>;

/**
 * The one request a view makes before it shows its content, to learn whether the view is loading,
 * empty, failing, or forbidden. A probe asks for the least that settles the question.
 */
export type ViewProbe = (client: HttpClient, queryClient: QueryClient) => Promise<ViewProbeResult>;

/** A fault a probe raises itself for something the Bureau answered, with the status the Bureau would have. */
function notFound(what: string): ViewProbeFault {
  return new ViewProbeFault(`No ${what} was found.`, 404);
}

/** The audit trail: empty when the caller may see no record, which the Bureau answers for any caller. */
async function probeAudit(): Promise<ViewProbeResult> {
  const page = await queryAudit({}, undefined, { limit: 1 });
  return { empty: page.records.length === 0 };
}

/** The goals: empty when the caller has none. The Bureau answers any caller with the goals it owns. */
async function probeGoals(): Promise<ViewProbeResult> {
  const page = await listGoals({ limit: 1 });
  return { empty: page.goals.length === 0 };
}

/**
 * The runs: empty when the Bureau has neither a task nor a goal to list. It never asks the engine,
 * which a caller without `workflows:read` may not, and whose own list does not hold what the Bureau's
 * does (the page lists tasks and goals).
 */
async function probeRuns(): Promise<ViewProbeResult> {
  const [tasks, goals] = await Promise.all([listTasks({ limit: 1 }), listGoals({ limit: 1 })]);
  const empty = tasks.tasks.length === 0 && goals.goals.length === 0;
  // A first run can arrive while the page is open, so an empty page asks again: when the Bureau's
  // feed reports a run or a goal, and on a timer while it does not.
  return empty ? { empty, recheckMs: RUNS_RECHECK_MS, liveSource: 'bureau' } : { empty };
}

/** The editor for a new agent needs the models and tools it may offer, so it asks for them. */
async function probeAgentCatalog(): Promise<ViewProbeResult> {
  await getAgentCatalog();
  return { empty: false };
}

/**
 * The editor for one agent needs an agent file it may edit. A code-defined agent can be read but
 * not written, so it answers as one that is not there, as the Bureau does for a write.
 */
async function probeEditableAgent(id: string): Promise<ViewProbeResult> {
  const agent = await getAgentDefinition(id);
  if (agent.source === 'code') {
    throw new ViewProbeFault(`The agent "${id}" is defined in code, so it cannot be edited.`, 404);
  }
  return { empty: false };
}

/**
 * The list: empty when neither the engine nor the Bureau has a workflow to list. The load goes
 * through the query cache under the list's own key, so the page that follows takes it instead of
 * reading every page of both services again.
 */
async function probeWorkflowList(
  client: HttpClient,
  queryClient: QueryClient,
): Promise<ViewProbeResult> {
  const rows = await queryClient.fetchQuery({
    queryKey: queryKeys.workflowCatalog.list(),
    queryFn: ({ signal }) => loadCatalog(client, { signal }),
    staleTime: CATALOG_STALE_TIME_MS,
    // The frame's probe never retries on its own, and the load it shares does not either.
    retry: false,
  });
  return { empty: rows.length === 0 };
}

/**
 * One workflow type's page, its runs, or its editor. The page and the runs need the type to exist,
 * by the rule `resolveWorkflow` states; the editor needs a file, because a code-defined type has
 * none to edit. The runs are empty when the engine lists none of that type's.
 */
async function probeWorkflowType(
  client: HttpClient,
  type: string,
  pattern: string | undefined,
): Promise<ViewProbeResult> {
  if (pattern === '/workflows/:workflow/edit') {
    if ((await orNotFound(getWorkflowFile(type))) === undefined) throw notFound('workflow');
    return { empty: false };
  }
  if ((await resolveWorkflow(client, type)) === undefined) throw notFound('workflow');
  if (pattern === '/workflows/:workflow/runs') {
    const page = await client.list({ type, limit: 1 });
    // A first run of the type is the engine's `workflow:started`.
    return page.items.length === 0
      ? { empty: true, recheckMs: RUNS_RECHECK_MS, liveSource: 'fleet' }
      : { empty: false };
  }
  return { empty: false };
}

/** The engine answering is all the pages that read it need settled before they show. */
async function probeEngineRegistry(client: HttpClient): Promise<ViewProbeResult> {
  await client.operations['weft.system.registry']({});
  return { empty: false };
}

/**
 * The probe for a view, or `undefined` when the view needs none because the route itself says
 * what it is showing: one run's detail page handles a run that is missing in its own words.
 */
export function probeFor(
  view: ViewName,
  parameters: ViewProbeParameters,
  pattern?: string,
  search: URLSearchParams = new URLSearchParams(),
): ViewProbe | undefined {
  switch (view) {
    case 'chat':
      // One session's page asks for that session, which settles whether it exists and may be seen.
      if (parameters['chat'] !== undefined) {
        const sessionId = parameters['chat'];
        return async () => {
          // Only whether it exists and may be seen matters here; the page reads what it shows.
          await callBureau('bureau.contexts.get', { contextId: sessionId });
          return { empty: false };
        };
      }
      // A new chat needs an agent the Bureau lists: an unknown one is not found.
      if (pattern === '/chats/new') {
        const agent = search.get('agent') ?? DEFAULT_AGENT;
        return async () => {
          const agents = await listAgents();
          const found = agents.find((entry) => entry.name === agent);
          if (found === undefined) throw notFound('agent');
          return { empty: false };
        };
      }
      // The list is empty when the caller has started no chat: a goal's or a schedule's session is
      // not listed here, so it does not make the list not empty.
      return async () => {
        const page = await listContexts({ origin: 'chat', limit: 1 });
        return { empty: page.contexts.length === 0 };
      };
    case 'agents':
      return async () => {
        const agents = await listAgents();
        const agent = parameters['agent'];
        if (agent === undefined) return { empty: agents.length === 0 };
        if (!agents.some((entry) => entry.name === agent)) throw notFound('agent');
        // An agent's memory page is empty when the agent has no memory: ranking has no score floor,
        // so a search finds something whenever one exists, and there is no other empty state.
        if (pattern === AGENT_MEMORY_PATTERN) {
          const page = await listMemories(agent, { limit: 1 });
          return { empty: page.memories.length === 0 };
        }
        return { empty: false };
      };
    case 'audit':
      return probeAudit;
    case 'settings':
      // The sections that moved out of the System page read the engine, not the Bureau's settings;
      // General, Models and Model policy read the settings.
      if (
        pattern !== undefined &&
        pattern !== '/settings' &&
        pattern !== '/settings/models' &&
        pattern !== '/settings/model-policy'
      ) {
        return probeEngineRegistry;
      }
      // The settings always have something to show: every key is listed, with a value or without.
      // Asking for them settles whether the caller may read them and whether the Bureau answers.
      return async () => {
        await getSettings();
        return { empty: false };
      };
    case 'goals': {
      // The page that makes a goal asks for nothing: it is where the first one is made.
      if (pattern === '/goals/new') return undefined;
      const goal = parameters['goal'];
      if (goal === undefined) return probeGoals;
      // One goal's page asks for that goal, which settles whether it exists and may be seen.
      return async () => {
        await getGoal(goal);
        return { empty: false };
      };
    }
    case 'capabilities':
      // The catalog is what the page cannot do without: asking for it settles whether the caller
      // may read it. The skills are read by the page, which says so itself when they are missing.
      return probeAgentCatalog;
    case 'agent-editor': {
      const agent = parameters['agent'];
      return agent === undefined ? probeAgentCatalog : () => probeEditableAgent(agent);
    }
    case 'workflows': {
      // The page that makes a workflow asks for nothing: it is where the first one is written.
      if (pattern === '/workflows/new') return undefined;
      // The internal workflows are listed from the same catalog and say when there are none.
      if (pattern === '/internal-workflows') return undefined;
      const workflow = parameters['workflow'];
      return workflow === undefined
        ? probeWorkflowList
        : (client) => probeWorkflowType(client, workflow, pattern);
    }
    case 'runs':
      if (parameters['run'] !== undefined) return undefined;
      return probeRuns;
    case 'schedules':
      // One schedule's page asks for that schedule, and says in its own words when it is not there.
      if (parameters['schedule'] !== undefined) return undefined;
      return async (client) => {
        const page = await client.listSchedules({});
        return { empty: page.items.length === 0 };
      };
    case 'reviews':
      // The Bureau's list is what the view can be refused, and nothing else it says is the view's
      // to report: the page reads the engine's reviews itself, when the principal may, and shows the
      // Bureau's own failure in a banner beside them. So the probe lets through the two answers that
      // mean the caller may not see the list: a 403, which the frame shows as forbidden, and a 401
      // (the Bureau does not know the caller), which the frame shows as an error with Retry, as it
      // does for every other view's probe. It swallows any other failure (a 5xx, an unreachable
      // Bureau), and a view with reviews of either kind is never empty here.
      return async () => {
        try {
          await listBureauReviews();
        } catch (error) {
          if (classifyFault(error)?.kind === 'unauthorized') throw error;
        }
        return { empty: false };
      };
    case 'workers':
      return async (client) => {
        await client.operations['weft.workers.list']({});
        return { empty: false };
      };
    case 'storage':
      return async (client) => {
        await client.operations['weft.storage.capabilities']({});
        return { empty: false };
      };
    case 'health':
      // The page reads the engine band by band, each with its own scope and its own failure, so a
      // principal holding only one of the page's scopes is not turned away by a probe that needs
      // the other.
      return undefined;
  }
}
