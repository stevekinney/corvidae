/**
 * The addresses under `/workflows`: a workflow type's page, its runs, and its editor. This is the
 * one module that spells them, because `/workflows/` was once the runs' address and a run's link
 * is never one (`workflowDetailPath` in `router.svelte.ts` builds those); `routes.test.ts` fails if
 * any other file builds a path that begins `/workflows/`.
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

/** The editor for one agent-authored workflow's file. */
export function workflowEditPath(type: string): string {
  return `${workflowTypePath(type)}/edit`;
}

/**
 * The engine's own run list, across every workflow type. It lives under `/engine` because it reads
 * the engine's list and takes the engine's status words in its `status` query parameter; `/runs` is
 * the Bureau's task list and has no engine rows.
 */
export const ENGINE_RUNS_PATH = '/engine/runs';
