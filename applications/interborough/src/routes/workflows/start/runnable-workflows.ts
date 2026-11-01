import type { CatalogRow } from '../../../lib/workflow-catalog.ts';

/**
 * The workflows a person can start a run of from the picker: every type that code registered and
 * every file that is ready and not paused, but never a type the Bureau registers to run itself,
 * which starts itself. It is the rule the workflow page's Start run follows, applied to a row.
 */
export function runnableWorkflows(rows: readonly CatalogRow[]): readonly CatalogRow[] {
  return rows.filter(
    (row) =>
      !row.engine && (row.kind === 'code' || (row.file?.state === 'ready' && !row.file.paused)),
  );
}
