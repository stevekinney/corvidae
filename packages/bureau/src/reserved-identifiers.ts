/**
 * COR-851 — the identifier namespaces a durable goal owns.
 *
 * Every id a goal uses is a deterministic function of its caller-chosen
 * `goalRunId`, and each lives in a namespace shared with ordinary callers: the
 * controller is a workflow (`goal:<id>`), each attempt is a run
 * (`goal-<id>-a<n>`), each conversation is a session (`goal-<id>-s<n>`), and its
 * audit events are recorded under a workflow-shaped id of their own
 * (`bureau-goal-audit:<id>`).
 *
 * Verifying ownership at the point of use (`goal-ownership.ts`) protects what a
 * goal reads, stops, or signals. It cannot protect a purge by workflow id: Weft
 * deletes every event carrying a workflow's id when it retires that workflow, so
 * an ordinary run that merely shares an id with a goal's audit trail erases the
 * trail when it is purged, whoever owns the goal. The only defence there is to
 * keep the ids from ever being held by anything but the goal, so the three
 * prefixes below are refused for every id an ordinary caller chooses (a run's
 * session, a child run, a schedule's session). Goal internals build these ids
 * themselves and never pass through that admission. Ownership verification stays
 * as defence in depth for a store written by something else.
 *
 * The host-level operate-by-id APIs (`cancelDurableRun`, `abortRun`, `deleteRun`,
 * `deleteSession`, `getDurableRun`, `signalDurableRun`) take no principal and
 * are not guarded for these ids: they are host-trusted by design, the same as
 * for every other run, and a host that forwards a caller-supplied id to one of
 * them owns authorizing it. The reservation closes squatting and purge
 * collisions, which no authorization at the point of use can.
 *
 * The prefixes are the single source: each builder of a goal-derived id starts
 * from one of them, and a test asserts that, so a new derived id cannot slip
 * outside the reservation.
 */

/** The controller workflow: `goal:<id>`. */
export const GOAL_WORKFLOW_ID_PREFIX = 'goal:';
/** An attempt's run (`goal-<id>-a<n>`) and a goal's session (`goal-<id>-s<n>`). */
export const GOAL_RUN_AND_SESSION_ID_PREFIX = 'goal-';
/** The workflow-shaped id a goal's audit events are recorded under. */
export const GOAL_AUDIT_WORKFLOW_ID_PREFIX = 'bureau-goal-audit:';

export const GOAL_RESERVED_IDENTIFIER_PREFIXES: readonly string[] = [
  GOAL_WORKFLOW_ID_PREFIX,
  GOAL_RUN_AND_SESSION_ID_PREFIX,
  GOAL_AUDIT_WORKFLOW_ID_PREFIX,
];

/** The reserved prefix `id` starts with, or `undefined` when it is free for ordinary use. */
export function reservedGoalIdentifierPrefix(id: string): string | undefined {
  return GOAL_RESERVED_IDENTIFIER_PREFIXES.find((prefix) => id.startsWith(prefix));
}

/** Why `id` may not be chosen by an ordinary caller as a `kind`; `undefined` when it may. */
export function reservedIdentifierReason(kind: string, id: string): string | undefined {
  const prefix = reservedGoalIdentifierPrefix(id);
  return prefix === undefined
    ? undefined
    : `reserved-identifier: ${kind} "${id}" begins with "${prefix}", a prefix durable goals own; choose another.`;
}

/**
 * Event history records a run, a session, and a schedule under a workflow-shaped
 * id (`run:<id>`, `session:<id>`, `schedule:<id>`; see `encodeOwner`). A child
 * run's workflow id is its run id, and Weft deletes every event carrying a
 * workflow's id when it purges that workflow, so a child named `run:<victim>`
 * would erase the victim's history when it is purged (and fabricate a retained
 * run owner while it lives). These prefixes are therefore refused for an id that
 * names a workflow.
 */
export const EVENT_OWNER_WORKFLOW_ID_PREFIXES: readonly string[] = [
  'run:',
  'session:',
  'schedule:',
];

/**
 * Why `id` may not be chosen by an ordinary caller as the id of a workflow
 * (`kind`); `undefined` when it may. Covers the goal prefixes and the
 * event-history owner prefixes.
 */
export function reservedWorkflowIdentifierReason(kind: string, id: string): string | undefined {
  const goalReason = reservedIdentifierReason(kind, id);
  if (goalReason !== undefined) return goalReason;
  const prefix = EVENT_OWNER_WORKFLOW_ID_PREFIXES.find((candidate) => id.startsWith(candidate));
  return prefix === undefined
    ? undefined
    : `reserved-identifier: ${kind} "${id}" begins with "${prefix}", a prefix durable event history records its owners under; choose another.`;
}
