import type { HttpClient } from '@lostgradient/weft';
import type { QueryClient } from '@tanstack/svelte-query';

import { getAgentCatalog, getAgentDefinition } from '../lib/agent-definitions.ts';
import { queryAudit } from '../lib/bureau-audit.ts';
import { callBureau, listAgents, listContexts } from '../lib/bureau-client.ts';
import { listGoals } from '../lib/bureau-goals.ts';
import { listBureauReviews } from '../lib/bureau-reviews.ts';
import { getTask, listTasks } from '../lib/bureau-tasks.ts';
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
 * `recheckMs`, and the frame asks again that often while the view is empty. Without it an empty
 * view stays as it is until the person leaves and comes back.
 */
export type ViewProbeResult = { readonly empty: boolean; readonly recheckMs?: number };

/** How often an empty runs page asks again, the poll `/tasks/:id` uses for a task that has ended. */
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
  if (pattern === '/workflows/:type/edit') {
    if ((await orNotFound(getWorkflowFile(type))) === undefined) throw notFound('workflow');
    return { empty: false };
  }
  if ((await resolveWorkflow(client, type)) === undefined) throw notFound('workflow');
  if (pattern === '/workflows/:type/runs') {
    const page = await client.list({ type, limit: 1 });
    return page.items.length === 0 ? { empty: true, recheckMs: RUNS_RECHECK_MS } : { empty: false };
  }
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
      if (parameters['sessionId'] !== undefined) {
        const sessionId = parameters['sessionId'];
        return async () => {
          // Only whether it exists and may be seen matters here; the page reads what it shows.
          await callBureau('bureau.contexts.get', { contextId: sessionId });
          return { empty: false };
        };
      }
      // A new chat needs an agent that is published: an unknown or unpublished one is not found.
      if (pattern === '/chat/new') {
        const agent = search.get('agent') ?? DEFAULT_AGENT;
        return async () => {
          const agents = await listAgents();
          const found = agents.find((entry) => entry.name === agent);
          if (found === undefined || found.publishState !== 'published') throw notFound('agent');
          return { empty: false };
        };
      }
      // The list is empty when the caller has no session.
      return async () => {
        const page = await listContexts({ limit: 1 });
        return { empty: page.contexts.length === 0 };
      };
    case 'agents':
      return async () => {
        const agents = await listAgents();
        if (parameters['id'] === undefined) return { empty: agents.length === 0 };
        if (!agents.some((entry) => entry.name === parameters['id'])) throw notFound('agent');
        // An agent's memory page is empty when the agent has no memory: ranking has no score floor,
        // so a search finds something whenever one exists, and there is no other empty state.
        if (pattern === AGENT_MEMORY_PATTERN) {
          const page = await listMemories(parameters['id'], { limit: 1 });
          return { empty: page.memories.length === 0 };
        }
        return { empty: false };
      };
    case 'audit':
      return probeAudit;
    case 'goals':
      return probeGoals;
    case 'agent-editor': {
      const id = parameters['id'];
      return id === undefined ? probeAgentCatalog : () => probeEditableAgent(id);
    }
    case 'workflows': {
      const type = parameters['type'];
      return type === undefined
        ? probeWorkflowList
        : (client) => probeWorkflowType(client, type, pattern);
    }
    case 'runs':
      if (parameters['id'] !== undefined) return undefined;
      return async (client) => {
        const page = await client.list({ limit: 1 });
        return { empty: page.items.length === 0 };
      };
    case 'schedules':
      // One schedule's page asks for that schedule, and says in its own words when it is not there.
      if (parameters['id'] !== undefined) return undefined;
      return async (client) => {
        const page = await client.listSchedules({});
        return { empty: page.items.length === 0 };
      };
    case 'tasks':
      // One task's page asks for that task, which settles whether it exists and may be seen. The
      // list is empty when the caller has no task.
      if (parameters['id'] !== undefined) {
        const taskId = parameters['id'];
        return async () => {
          await getTask(taskId);
          return { empty: false };
        };
      }
      return async () => {
        const page = await listTasks({ limit: 1 });
        return { empty: page.tasks.length === 0 };
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
    case 'system':
    case 'engine':
      return async (client) => {
        await client.operations['weft.system.registry']({});
        return { empty: false };
      };
  }
}
