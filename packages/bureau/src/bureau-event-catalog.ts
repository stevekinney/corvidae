/**
 * The catalog of the Bureau's published event kinds (COR-1940): for each kind in
 * {@link PUBLISHED_BUREAU_EVENT_KINDS}, what the event means and the fields of its `payload`. It is
 * what a person writing a hook reads to choose the kinds to match, and what a `start-workflow`
 * hook's input looks like.
 *
 * The record is typed over {@link PublishedBureauEventKind}, so a kind added to
 * `BUREAU_EVENT_CLASSIFICATION` as `published` is a compile error here until it has an entry, and
 * `bureau-event-catalog.test.ts` compares the keys to {@link PUBLISHED_BUREAU_EVENT_KINDS} at run
 * time. That is the guard: no published kind is undescribed.
 *
 * Each entry also says where the event comes from, as {@link BureauEventOrigin}, which is how a
 * `start-workflow` hook stays out of a chain (see `hooks/hook-origin.ts`): the record is typed, so
 * a kind cannot be added without choosing, and `bureau-event-catalog.test.ts` checks that every
 * `run` kind names a run the guard can follow.
 *
 * Each entry says which kinds of subject the event can be told apart by, as `scopes` (COR-1978):
 * the scopes a hook that lists the kind may have, and what the editor's Only for offers. A kind
 * with none is about the whole Bureau, or names nothing a scope can match.
 *
 * Weft's own event kinds (`weft.*` run, workflow and schedule events) are not in it. The Bureau's
 * feed publishes Weft's `ScheduleMissedFire` as `schedule.missed` and nothing else of Weft's, and
 * matching a hook on the rest needs a subscription to the engine's own feed, which the Bureau does
 * not make. They are out of scope for hooks until it does.
 *
 * @module bureau-event-catalog
 */

import {
  PUBLISHED_BUREAU_EVENT_KINDS,
  type PublishedBureauEventKind,
} from './bureau-event-feed.ts';
import type { HookScopeKind } from './hooks/hook-types.ts';

/** The type of one field of an event's payload. */
export type BureauEventFieldType =
  'string' | 'number' | 'boolean' | 'string[]' | 'object' | 'unknown';

/** One field of an event's `payload`. */
export interface BureauEventField {
  /** The payload key. */
  readonly name: string;
  /** Its JSON type. */
  readonly type: BureauEventFieldType;
  /** Whether the payload leaves the field out for some events of the kind. */
  readonly optional: boolean;
}

/**
 * Where an event can come from, which decides whether a `start-workflow` hook may listen to it.
 *
 * - `run`: the payload names a run (its `runId`, `goalRunId` or `taskId` is present on every
 *   event of the kind), so the guard can follow it to the workflow instance a hook started.
 * - `external`: a narrow allowlist. Only a kind with a stated argument that no run, tool or action
 *   of a run can cause it. Each carries a one-line reason beside its entry.
 * - `unattributed`: everything else, and the default for a new kind. A run may cause the event (a
 *   session saved, a notification written, a schedule paused, a definition file written by a
 *   tool) and nothing on it leads back to the run, so a hook that started a workflow from it
 *   could start itself again. A kind is `unattributed` unless someone can argue otherwise.
 */
export type BureauEventOrigin = 'run' | 'external' | 'unattributed';

/** One published event kind, described. */
export interface BureauEventCatalogEntry {
  /** The kind, as a hook's `events` and `bureau.events`' `kinds` name it. */
  readonly kind: PublishedBureauEventKind;
  /** What the event means, and when the Bureau publishes it. */
  readonly description: string;
  /** Where the event can come from; a `start-workflow` hook may listen to `run` and `external` kinds only. */
  readonly origin: BureauEventOrigin;
  /** The fields of the event's `payload`, in the order the projection sets them. */
  readonly payload: readonly BureauEventField[];
  /**
   * The kinds of subject a hook that lists this kind may be scoped to: what `hooks/hook-scope.ts`
   * can read from an event of the kind. Empty for a kind that is about no one subject.
   */
  readonly scopes: readonly HookScopeKind[];
}

/** A field. A trailing `?` on the name marks it optional. */
function field(name: string, type: BureauEventFieldType): BureauEventField {
  return name.endsWith('?')
    ? { name: name.slice(0, -1), type, optional: true }
    : { name, type, optional: false };
}

type FieldList = readonly (readonly [name: string, type: BureauEventFieldType])[];

const RUN: FieldList = [['runId', 'string']];
// `dedupeKey` and `committedAtMs` are set only when an outbox carried the transition.
const SCHEDULE_CHANGE: FieldList = [
  ['scheduleId', 'string'],
  ['dedupeKey?', 'string'],
  ['committedAtMs?', 'number'],
];
const SESSION: FieldList = [
  ['sessionId', 'string'],
  ['agentName', 'string'],
  ['incarnation', 'string'],
  ['ordinal', 'number'],
  ['committedAtMs', 'number'],
];
// Every correlation field is optional: a dispatch site stamps only what it knows.
const SKILL: FieldList = [
  ['skillName', 'string'],
  ['runId?', 'string'],
  ['sessionId?', 'string'],
  ['traceId?', 'string'],
  ['agentName?', 'string'],
  ['sourceId?', 'string'],
  ['artifactDigest?', 'string'],
  ['status', 'string'],
];
const REVIEW: FieldList = [
  ['reviewId', 'string'],
  ['runId', 'string'],
  ['principal', 'string'],
  ['reviewKind', 'string'],
];
const GOAL_ATTEMPT: FieldList = [
  ['goalRunId', 'string'],
  ['attemptId?', 'string'],
  ['attemptIndex?', 'number'],
  ['runId?', 'string'],
];
const GOAL_TERMINAL: FieldList = [
  ['goalRunId', 'string'],
  ['terminalReason?', 'string'],
];
const ASSET: FieldList = [
  ['sequence', 'number'],
  ['at', 'string'],
  ['assetId?', 'string'],
  ['revision?', 'number'],
  ['state?', 'string'],
  ['principal?', 'string'],
  ['uploadId?', 'string'],
  ['digest?', 'string'],
];

/** A kind that names a run or a schedule: the walk up from either reaches all three subjects. */
const EVERY_SCOPE: readonly HookScopeKind[] = ['agent', 'workflow', 'schedule'];
/** A kind that names only the agent, in its payload or through its goal. */
const AGENT_SCOPE: readonly HookScopeKind[] = ['agent'];

function entry(
  kind: PublishedBureauEventKind,
  origin: BureauEventOrigin,
  description: string,
  payload: FieldList,
  scopes: readonly HookScopeKind[] = [],
): BureauEventCatalogEntry {
  return {
    kind,
    description,
    origin,
    payload: payload.map(([name, type]) => field(name, type)),
    scopes,
  };
}

/**
 * Every published kind with its description and payload shape, keyed by kind. A payload is a
 * projection: it holds identifiers, statuses and counts, never the content of the run, goal,
 * notification or review it is about.
 */
export const BUREAU_EVENT_CATALOG: Readonly<
  Record<PublishedBureauEventKind, BureauEventCatalogEntry>
> = Object.freeze({
  action: entry(
    'action',
    'run',
    'A run recorded an action in its log (a step, a tool call, a message). Only the log entry’s shape crosses, never its detail.',
    [
      ['sequence', 'number'],
      ['runId', 'string'],
      ['actionType', 'string'],
      ['timestamp', 'number'],
    ],
    EVERY_SCOPE,
  ),
  'run.registered': entry(
    'run.registered',
    'run',
    'A run was registered with the Bureau.',
    RUN,
    EVERY_SCOPE,
  ),
  'run.settled': entry(
    'run.settled',
    'run',
    'A run reached a terminal state: it completed, failed, or was aborted.',
    RUN,
    EVERY_SCOPE,
  ),
  // No scope: deleting a run deletes the task record a scope would read, before dispatch reads it.
  'run.removed': entry('run.removed', 'run', 'A settled run was removed from the Bureau.', RUN),
  'run.abort-settled': entry(
    'run.abort-settled',
    'run',
    'A run that was asked to abort has finished stopping.',
    RUN,
    EVERY_SCOPE,
  ),
  // external: only the host disposes a Bureau; no tool or action of a run reaches it.
  'bureau.disposed': entry(
    'bureau.disposed',
    'external',
    'The Bureau was disposed; no later event follows.',
    [],
  ),
  'recovery.attempted': entry(
    'recovery.attempted',
    'run',
    'The Bureau tried to recover a run it found unfinished after a restart.',
    [
      ['runId', 'string'],
      ['verdict', 'string'],
    ],
    EVERY_SCOPE,
  ),
  'recovery.rejected': entry(
    'recovery.rejected',
    'run',
    'The Bureau declined to recover a run, and says why.',
    [
      ['runId', 'string'],
      ['reason', 'string'],
    ],
    EVERY_SCOPE,
  ),
  'recovery.lease-released': entry(
    'recovery.lease-released',
    'run',
    'The Bureau released the recovery lease it held on a run.',
    RUN,
    EVERY_SCOPE,
  ),
  'schedule.created': entry(
    'schedule.created',
    'unattributed',
    'A schedule was created for an agent.',
    [
      ['agentName', 'string'],
      ['scheduleId', 'string'],
      ['sessionId?', 'string'],
    ],
    EVERY_SCOPE,
  ),
  'schedule.paused': entry(
    'schedule.paused',
    'unattributed',
    'A schedule was paused.',
    SCHEDULE_CHANGE,
    EVERY_SCOPE,
  ),
  'schedule.resumed': entry(
    'schedule.resumed',
    'unattributed',
    'A paused schedule was resumed.',
    SCHEDULE_CHANGE,
    EVERY_SCOPE,
  ),
  'schedule.cancelled': entry(
    'schedule.cancelled',
    'unattributed',
    'A schedule was cancelled.',
    SCHEDULE_CHANGE,
    EVERY_SCOPE,
  ),
  'schedule.failed': entry(
    'schedule.failed',
    'run',
    'A run a schedule started failed.',
    [
      ['scheduleId', 'string'],
      ['runId', 'string'],
      ['status', 'string'],
    ],
    EVERY_SCOPE,
  ),
  'schedule.completed': entry(
    'schedule.completed',
    'run',
    'A run a schedule started completed.',
    [
      ['scheduleId', 'string'],
      ['runId', 'string'],
      ['status', 'string'],
    ],
    EVERY_SCOPE,
  ),
  'schedule.attempted': entry(
    'schedule.attempted',
    'unattributed',
    'A schedule tried to fire an occurrence.',
    [
      ['scheduleId', 'string'],
      ['occurrence?', 'number'],
    ],
    EVERY_SCOPE,
  ),
  'schedule.skipped': entry(
    'schedule.skipped',
    'unattributed',
    'A schedule skipped an occurrence because an earlier run still held it, by the schedule’s overlap policy.',
    [
      ['scheduleId', 'string'],
      ['occurrence?', 'number'],
      ['blockingRunId?', 'string'],
      ['policy', 'string'],
    ],
    EVERY_SCOPE,
  ),
  'skill.loaded': entry(
    'skill.loaded',
    'unattributed',
    'A skill was loaded for a run.',
    SKILL,
    EVERY_SCOPE,
  ),
  'skill.activated': entry(
    'skill.activated',
    'unattributed',
    'A loaded skill was activated for a run.',
    SKILL,
    EVERY_SCOPE,
  ),
  'skill.deactivated': entry(
    'skill.deactivated',
    'unattributed',
    'An active skill was deactivated.',
    SKILL,
    EVERY_SCOPE,
  ),
  'skill.rejected': entry(
    'skill.rejected',
    'unattributed',
    'A skill was refused by a rule; `reason` and `rule` say which.',
    [...SKILL, ['reason', 'string'], ['rule?', 'string']],
    EVERY_SCOPE,
  ),
  'skill.failed': entry(
    'skill.failed',
    'unattributed',
    'A skill failed while it was loading or running.',
    SKILL,
    EVERY_SCOPE,
  ),
  'session.created': entry(
    'session.created',
    'unattributed',
    'A session was created.',
    SESSION.slice(0, 5),
    AGENT_SCOPE,
  ),
  'session.saved': entry(
    'session.saved',
    'unattributed',
    'A session was saved.',
    SESSION,
    AGENT_SCOPE,
  ),
  'session.deleted': entry('session.deleted', 'unattributed', 'A session was deleted.', [
    ['sessionId', 'string'],
    ['incarnation', 'string'],
    ['ordinal', 'number'],
    ['committedAtMs', 'number'],
  ]),
  'review.requested': entry(
    'review.requested',
    'run',
    'A tool approval or a human wait is now waiting for someone to answer it. `reviewKind` says which.',
    REVIEW,
    EVERY_SCOPE,
  ),
  'review.approved': entry(
    'review.approved',
    'run',
    'A waiting review was approved.',
    REVIEW,
    EVERY_SCOPE,
  ),
  'review.denied': entry(
    'review.denied',
    'run',
    'A waiting review was denied.',
    REVIEW,
    EVERY_SCOPE,
  ),
  'review.rejected': entry(
    'review.rejected',
    'run',
    'An answer to a review was rejected as invalid.',
    REVIEW,
    EVERY_SCOPE,
  ),
  'review.expired': entry(
    'review.expired',
    'run',
    'A waiting review expired unanswered.',
    REVIEW,
    EVERY_SCOPE,
  ),
  'review.revoked': entry(
    'review.revoked',
    'run',
    'A review’s earlier approval was revoked.',
    REVIEW,
    EVERY_SCOPE,
  ),
  'review.canceled': entry(
    'review.canceled',
    'run',
    'A waiting review was canceled with its run.',
    REVIEW,
    EVERY_SCOPE,
  ),
  'review.superseded': entry(
    'review.superseded',
    'run',
    'A waiting review was replaced by a newer one.',
    REVIEW,
    EVERY_SCOPE,
  ),
  'steering.accepted': entry(
    'steering.accepted',
    'unattributed',
    'A steering command to a session was accepted.',
    [
      ['sessionId', 'string'],
      ['commandId', 'string'],
      ['configVersion', 'number'],
      ['status', 'string'],
    ],
  ),
  'goal.started': entry(
    'goal.started',
    'run',
    'A goal was started.',
    [
      ['goalRunId', 'string'],
      ['goalIdentity?', 'object'],
    ],
    AGENT_SCOPE,
  ),
  'goal.attempt.started': entry(
    'goal.attempt.started',
    'run',
    'A goal started an attempt.',
    GOAL_ATTEMPT,
    AGENT_SCOPE,
  ),
  'goal.attempt.evaluating': entry(
    'goal.attempt.evaluating',
    'run',
    'A goal’s attempt finished its run and its validator started. Published live only, never in a goal’s recorded history.',
    GOAL_ATTEMPT,
    AGENT_SCOPE,
  ),
  'goal.attempt.validated': entry(
    'goal.attempt.validated',
    'run',
    'A goal’s validator judged an attempt.',
    [
      ['goalRunId', 'string'],
      ['attemptId?', 'string'],
      ['validatorIdentity?', 'object'],
      ['outcomeKind?', 'string'],
      ['feedbackDigest?', 'string'],
    ],
    AGENT_SCOPE,
  ),
  'goal.succeeded': entry('goal.succeeded', 'run', 'A goal succeeded.', GOAL_TERMINAL, AGENT_SCOPE),
  'goal.exhausted': entry(
    'goal.exhausted',
    'run',
    'A goal used up its attempts without succeeding.',
    GOAL_TERMINAL,
    AGENT_SCOPE,
  ),
  'goal.canceled': entry(
    'goal.canceled',
    'run',
    'A goal was canceled.',
    GOAL_TERMINAL,
    AGENT_SCOPE,
  ),
  'goal.failed': entry(
    'goal.failed',
    'run',
    'A goal failed. `validatorError` keeps the validator error’s `kind` and `code`; its message stays behind `bureau.goals.get`.',
    [
      ['goalRunId', 'string'],
      ['terminalReason?', 'string'],
      ['validatorError?', 'object'],
    ],
    AGENT_SCOPE,
  ),
  'goal.recovered': entry(
    'goal.recovered',
    'run',
    'A goal’s controller was restarted after the Bureau did.',
    [
      ['goalRunId', 'string'],
      ['controllerRestarts?', 'number'],
      ['status?', 'string'],
      ['transitionSeq?', 'number'],
    ],
    AGENT_SCOPE,
  ),
  'asset.upload.started': entry(
    'asset.upload.started',
    'unattributed',
    'An asset upload began.',
    ASSET,
  ),
  'asset.upload.purged': entry(
    'asset.upload.purged',
    'unattributed',
    'An unfinished asset upload was removed.',
    ASSET,
  ),
  'asset.blob.purged': entry(
    'asset.blob.purged',
    'unattributed',
    'The stored bytes of an asset were removed.',
    ASSET,
  ),
  'asset.expired': entry(
    'asset.expired',
    'unattributed',
    'An asset passed its retention and expired.',
    ASSET,
  ),
  'definitions.changed': entry(
    'definitions.changed',
    'unattributed',
    'A rescan of the agent or workflow files changed what the catalog holds. `rejected` names the added or changed definitions that are invalid now. A change that only the built-in `bureau` workflow tools wrote carries `source: "bureau"`.',
    [
      ['catalog', 'string'],
      ['added', 'string[]'],
      ['changed', 'string[]'],
      ['removed', 'string[]'],
      ['rejected', 'string[]'],
    ],
  ),
  // external: downtime or a daylight-saving gap swallowed the occurrences; a run cannot make time pass or skip.
  'schedule.missed': entry(
    'schedule.missed',
    'external',
    'A schedule’s occurrences were missed (the Bureau was down, or a daylight-saving gap swallowed them) and were not fired. Weft’s `ScheduleMissedFire`, the one Weft event the feed carries.',
    [
      ['scheduleId', 'string'],
      ['missedCount', 'number'],
      ['windowStart', 'number'],
      ['windowEnd', 'number'],
      ['reason', 'string'],
    ],
    EVERY_SCOPE,
  ),
  'task.cleanup-acknowledged': entry(
    'task.cleanup-acknowledged',
    'run',
    'A task’s cleanup was acknowledged.',
    [
      ['taskId', 'string'],
      ['cleanup', 'string'],
    ],
    EVERY_SCOPE,
  ),
  'notification.created': entry(
    'notification.created',
    'unattributed',
    'A notification was written for an owner. The payload names it and its kind, not its owner, title, body or link. A hook that writes notifications cannot match this kind.',
    [
      ['notificationId', 'string'],
      ['kind', 'string'],
    ],
  ),
  diagnostic: entry(
    'diagnostic',
    'unattributed',
    'The Bureau reported a warning or an error. Only the level and the scope cross, never the message or the cause.',
    [
      ['level', 'string'],
      ['scope', 'string'],
    ],
  ),
  'memory.governance': entry(
    'memory.governance',
    'unattributed',
    'A governed-memory operation (a write, a forget, a retention pass) produced a notification.',
    [
      ['type', 'string'],
      ['outcome', 'string'],
      ['tenantId', 'string'],
      ['at', 'number'],
      ['recordIds', 'string[]'],
      ['operationId?', 'string'],
    ],
  ),
} satisfies Record<PublishedBureauEventKind, BureauEventCatalogEntry>);

/** The catalog as a list, in {@link PUBLISHED_BUREAU_EVENT_KINDS} order. */
export function bureauEventCatalog(): readonly BureauEventCatalogEntry[] {
  return PUBLISHED_BUREAU_EVENT_KINDS.map((kind) => BUREAU_EVENT_CATALOG[kind]);
}
