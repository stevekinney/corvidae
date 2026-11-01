/**
 * The addresses under `/workflows`: a workflow type's page, its runs, and its editor. This is the
 * one module that spells them, because `/workflows/` was once the runs' address. A run's link is
 * built in `router.svelte.ts` (`workflowDetailPath` for a run known by its ID alone,
 * `workflowRunPath` for one under its workflow); `routes.test.ts` fails if any other file builds a
 * path that begins `/workflows/`.
 */

/** A workflow type's page. */
export function workflowTypePath(type: string): string {
  return `/workflows/${encodeURIComponent(type)}`;
}

/** The runs of one workflow type. */
export function workflowRunsPath(type: string): string {
  return `${workflowTypePath(type)}/runs`;
}

/** The page that makes a workflow. It is a literal segment, so a workflow called `new` has no page. */
export function workflowNewPath(): string {
  return '/workflows/new';
}

/**
 * The page of the workflows the Bureau runs itself. It is a path of its own rather than a segment
 * under `/workflows`, so a workflow a person names `internal` still has its page.
 */
export function internalWorkflowsPath(): string {
  return '/internal-workflows';
}

/** The page that sets up one run of a workflow: its input, and whether it starts now or on a schedule. */
export function workflowRunSetupPath(type: string): string {
  return `${workflowTypePath(type)}/run`;
}

/** The editor for one agent-authored workflow's file. */
export function workflowEditPath(type: string): string {
  return `${workflowTypePath(type)}/edit`;
}

/**
 * The engine's own run list, across every workflow type. It lives under `/health` because it reads
 * the engine's list and takes the engine's status words in its `status` query parameter; `/runs` is
 * the Bureau's task list and has no engine rows.
 */
export const ENGINE_RUNS_PATH = '/health/runs';
