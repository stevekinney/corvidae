/**
 * COR-2009 — what names an agent: the schedules that run it, the workflow files whose steps call
 * it, and the hooks scoped to it. They find the agent by its identifier, so each of them stops
 * finding it when the identifier changes, the agent is disabled, or it is deleted, and a person is
 * told which before that happens ("1 schedule (Weekly refund audit), 1 workflow (Order refund) and
 * 1 hook (Refund audit) name tool-runner").
 *
 * A workflow file that cannot be read as a workflow still names its agents in its text, and a
 * person who fixes it gets them back, so such a file is read as text: every `"agent": "<id>"` pair
 * in it counts. A file that can be read counts only its `agent` steps.
 *
 * @module agent-references
 */

import type { WorkflowListing } from './workflow-file-catalog.ts';

/** One schedule that runs the agent. */
export interface AgentScheduleReference {
  /** The schedule's identifier. */
  readonly id: string;
  /** The schedule's name (its description), or `null` when it has none. */
  readonly name: string | null;
}

/** One workflow file whose steps call the agent. */
export interface AgentWorkflowReference {
  /** The workflow's identifier. */
  readonly id: string;
  /** The workflow's `title`, or `null` when the file gives none or cannot be read. */
  readonly title: string | null;
}

/** One hook scoped to the agent. */
export interface AgentHookReference {
  /** The hook's identifier. */
  readonly id: string;
  /** The hook's name, or `null` when it has none. */
  readonly name: string | null;
}

/** Everything that names one agent, each list in the order its source lists it. */
export interface AgentReferences {
  /** The agent's identifier. */
  readonly agentName: string;
  /** The schedules whose every fire runs the agent. */
  readonly schedules: readonly AgentScheduleReference[];
  /** The workflow files with a step that calls the agent. */
  readonly workflows: readonly AgentWorkflowReference[];
  /** The hooks scoped to the agent. */
  readonly hooks: readonly AgentHookReference[];
}

/** Where {@link findAgentReferences} reads from. */
export interface AgentReferenceSources {
  /** Every schedule, with the agent it runs (`undefined` for one that runs none) and its name. */
  readonly schedules: () => Promise<
    readonly {
      readonly id: string;
      readonly agentName: string | undefined;
      readonly name: string | null;
    }[]
  >;
  /** Every workflow file, as the workflow catalog lists it; omitted for a Bureau with none. */
  readonly workflows?: () => readonly WorkflowListing[];
  /** The text of a workflow file, for one that cannot be read as a workflow. */
  readonly workflowText?: (id: string) => Promise<string | undefined>;
  /** Every hook, with its scope and name; omitted for a Bureau with no hooks. */
  readonly hooks?: () => Promise<
    readonly {
      readonly id: string;
      readonly name?: string | undefined;
      readonly scope?: { readonly kind: string; readonly id: string } | undefined;
    }[]
  >;
}

/** Whether a ready workflow file has a step whose agent is `agentName`. */
function stepsName(listing: WorkflowListing, agentName: string): boolean {
  return (listing.steps ?? []).some((step) => {
    const record = step as { readonly handler?: unknown; readonly input?: unknown };
    if (record.handler !== 'agent') return false;
    const input = record.input;
    return (
      typeof input === 'object' &&
      input !== null &&
      (input as { readonly agent?: unknown }).agent === agentName
    );
  });
}

/** Every `"agent": "<value>"` pair in `text`, read as JSON string literals. */
function agentsNamedInText(text: string): Set<string> {
  const named = new Set<string>();
  for (const match of text.matchAll(/"agent"\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
    const literal = match[1];
    if (literal === undefined) continue;
    try {
      const value: unknown = JSON.parse(literal);
      if (typeof value === 'string') named.add(value);
    } catch {
      // A literal JSON cannot read names nothing.
    }
  }
  return named;
}

/** What names `agentName`, read from `sources` now. */
export async function findAgentReferences(
  agentName: string,
  sources: AgentReferenceSources,
): Promise<AgentReferences> {
  const allSchedules = await sources.schedules();
  const schedules = allSchedules
    .filter((schedule) => schedule.agentName === agentName)
    .map((schedule) => ({ id: schedule.id, name: schedule.name }));
  const workflows: AgentWorkflowReference[] = [];
  for (const listing of sources.workflows?.() ?? []) {
    if (listing.state === 'ready') {
      if (stepsName(listing, agentName)) workflows.push({ id: listing.id, title: listing.title });
      continue;
    }
    const text = await sources.workflowText?.(listing.id);
    if (text !== undefined && agentsNamedInText(text).has(agentName)) {
      workflows.push({ id: listing.id, title: null });
    }
  }
  const hooks = (await sources.hooks?.()) ?? [];
  return {
    agentName,
    schedules,
    workflows,
    hooks: hooks
      .filter((hook) => hook.scope?.kind === 'agent' && hook.scope.id === agentName)
      .map((hook) => ({ id: hook.id, name: hook.name ?? null })),
  };
}
