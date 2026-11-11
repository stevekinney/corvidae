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

/** One workflow the start picker lists: pickable, or off for the reason it names. */
export type StartChoice = {
  /** The workflow's name, which is the value the picker holds. */
  readonly name: string;
  /** Why it cannot be picked, or `null` when it can. */
  readonly reason: 'paused' | 'invalid' | null;
};

/**
 * What the start picker lists: the workflows a person built, in catalog order. A file that is
 * paused or that cannot load stays in the list, off, with its reason. A type the Bureau registers
 * to run itself (Chat with an agent, goals, the heartbeat) never appears.
 */
export function startChoices(rows: readonly CatalogRow[]): readonly StartChoice[] {
  const choices: StartChoice[] = [];
  for (const row of rows) {
    if (row.engine) continue;
    if (row.kind === 'code') choices.push({ name: row.name, reason: null });
    else if (row.file === null) continue;
    else if (row.file.state !== 'ready') choices.push({ name: row.name, reason: 'invalid' });
    else choices.push({ name: row.name, reason: row.file.paused ? 'paused' : null });
  }
  return choices;
}
