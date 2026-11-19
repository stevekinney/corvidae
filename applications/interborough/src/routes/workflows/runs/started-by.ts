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
  'agent-run': "An agent's tool call",
  goal: 'A goal',
  parent: 'A workflow',
  // COR-2009: Interborough's own runs, such as the schedule tick.
  system: 'Interborough',
  // COR-2163: a plugin's trigger started the workflow run.
  trigger: 'A trigger',
} as const satisfies Record<StartedBy, string>;

/**
 * The same kinds as the Started by filter names them: the plural a chip reads after its label
 * ("Started by: Goals"), and "You" for a run a person started by hand, as the design's counts do
 * ("Chats 5, Schedules 4, Goals 8, Interborough 2, You 0"). The singular words above lead a
 * sentence or a column; these name a set of runs.
 */
export const STARTED_BY_FILTER_LABELS = {
  chat: 'Chats',
  person: 'You',
  schedule: 'Schedules',
  api: 'The API',
  agent: 'Agents',
  'agent-run': 'Agent tool calls',
  goal: 'Goals',
  parent: 'Workflows',
  system: 'Interborough',
  trigger: 'Triggers',
} as const satisfies Record<StartedBy, string>;

function isStartedBy(kind: string): kind is StartedBy {
  return Object.hasOwn(STARTED_BY_LABELS, kind);
}

/** Every kind of origin, in the order the filter lists them. */
export const STARTED_BY_KINDS: readonly StartedBy[] = Object.keys(STARTED_BY_LABELS).filter(
  (kind): kind is StartedBy => kind !== 'agent-run' && isStartedBy(kind),
);
