/**
 * The ways a run can start, as the Started by column and filter name them. A plain module (no
 * rune, no component) so the page, its tests and the browser specs read the one list.
 */
import type { TaskOriginKind } from '@lostgradient/bureau';

/** What can start a run, for the filter: every kind of origin the Bureau records. */
export type StartedBy = TaskOriginKind;

/**
 * The words for each way a run can start. This is the one list the column, the filter and the
 * address read, and the type checks it against the Bureau's own kinds: a kind added there fails to
 * compile here until it has a label, and a label for a kind the Bureau does not have fails too.
 */
export const STARTED_BY_LABELS = {
  chat: 'A chat',
  person: 'A person',
  schedule: 'A schedule',
  api: 'The API',
  agent: 'An agent',
  goal: 'A goal',
  parent: 'A workflow',
} as const satisfies Record<StartedBy, string>;

function isStartedBy(kind: string): kind is StartedBy {
  return Object.hasOwn(STARTED_BY_LABELS, kind);
}

/** Every kind of origin, in the order the filter lists them. */
export const STARTED_BY_KINDS: readonly StartedBy[] =
  Object.keys(STARTED_BY_LABELS).filter(isStartedBy);
