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
