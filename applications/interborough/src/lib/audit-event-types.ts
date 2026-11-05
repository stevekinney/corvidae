/**
 * Which records of the audit trail are events: the things a person or an agent did, or the host
 * noticed, that the audit log (`/health/audit`) lists. The trail also holds the engine's own steps
 * (`step.completed`, `tool.started`, a run's cleanup), which belong to a run's timeline and are
 * left out here, so the log lists "what happened" and a count of events counts those.
 *
 * Each event type has a kind, which is what the log's action select narrows by. A type with no
 * kind of the select's is `other` and shows under "Any action" only.
 */

/** The kinds the action select offers: Approved, Deleted, Edited, Removed and Started. */
export const AUDIT_ACTION_KINDS = ['approved', 'deleted', 'edited', 'removed', 'started'] as const;

/** One of the kinds the action select offers. */
export type AuditActionKind = (typeof AUDIT_ACTION_KINDS)[number];

/** What an event type counts as, for the action select. */
export type AuditEventKind = AuditActionKind | 'other';

/** The event types the log lists, each with its kind. */
export const AUDIT_EVENT_KINDS: ReadonlyMap<string, AuditEventKind> = new Map<
  string,
  AuditEventKind
>([
  ['host.started', 'started'],
  ['run.started', 'started'],
  ['run.aborted', 'other'],
  ['run.error', 'other'],
  ['schedule.fired', 'started'],
  ['schedule.created', 'other'],
  ['schedule.paused', 'edited'],
  ['schedule.resumed', 'edited'],
  ['schedule.cancelled', 'deleted'],
  ['schedule.missed', 'other'],
  ['tool.settled', 'other'],
  ['review.tool-approval.approved', 'approved'],
  ['review.tool-approval.denied', 'other'],
  ['memory.corrected', 'edited'],
  ['memory.forgotten', 'deleted'],
  ['agent.updated', 'edited'],
  ['workflow.created', 'other'],
  ['workflow.updated', 'edited'],
  ['hook.created', 'other'],
  ['hook.updated', 'edited'],
  ['session.deleted', 'deleted'],
  ['storage.key.deleted', 'deleted'],
  ['tool.source.connected', 'other'],
  ['tool.source.removed', 'removed'],
  ['provider.disconnected', 'removed'],
  ['skill.source.trusted', 'edited'],
  ['settings.changed', 'edited'],
  ['webhook.delivery.exhausted', 'other'],
]);

/** Every event type the log lists: what a query for events asks the Bureau for. */
export const AUDIT_EVENT_TYPES: readonly string[] = [...AUDIT_EVENT_KINDS.keys()];

/** The event types of one kind, or every event type for `undefined`. */
export function auditTypesOfKind(kind: AuditActionKind | undefined): readonly string[] {
  if (kind === undefined) return AUDIT_EVENT_TYPES;
  return AUDIT_EVENT_TYPES.filter((type) => AUDIT_EVENT_KINDS.get(type) === kind);
}
