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

function entry(
  kind: PublishedBureauEventKind,
  origin: BureauEventOrigin,
  description: string,
  payload: FieldList,
): BureauEventCatalogEntry {
  return { kind, description, origin, payload: payload.map(([name, type]) => field(name, type)) };
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
  ),
  'run.registered': entry('run.registered', 'run', 'A run was registered with the Bureau.', RUN),
  'run.settled': entry(
    'run.settled',
    'run',
    'A run reached a terminal state: it completed, failed, or was aborted.',
    RUN,
  ),
  'run.removed': entry('run.removed', 'run', 'A settled run was removed from the Bureau.', RUN),
  'run.abort-settled': entry(
    'run.abort-settled',
    'run',
    'A run that was asked to abort has finished stopping.',
    RUN,
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
  ),
  'recovery.rejected': entry(
    'recovery.rejected',
    'run',
    'The Bureau declined to recover a run, and says why.',
    [
      ['runId', 'string'],
      ['reason', 'string'],
    ],
  ),
  'recovery.lease-released': entry(
    'recovery.lease-released',
    'run',
    'The Bureau released the recovery lease it held on a run.',
    RUN,
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
  ),
  'schedule.paused': entry(
    'schedule.paused',
    'unattributed',
    'A schedule was paused.',
    SCHEDULE_CHANGE,
  ),
  'schedule.resumed': entry(
    'schedule.resumed',
    'unattributed',
    'A paused schedule was resumed.',
    SCHEDULE_CHANGE,
  ),
  'schedule.cancelled': entry(
    'schedule.cancelled',
    'unattributed',
    'A schedule was cancelled.',
    SCHEDULE_CHANGE,
  ),
  'schedule.failed': entry('schedule.failed', 'run', 'A run a schedule started failed.', [
    ['scheduleId', 'string'],
    ['runId', 'string'],
    ['status', 'string'],
  ]),
  'schedule.completed': entry('schedule.completed', 'run', 'A run a schedule started completed.', [
    ['scheduleId', 'string'],
    ['runId', 'string'],
    ['status', 'string'],
  ]),
  'schedule.attempted': entry(
    'schedule.attempted',
    'unattributed',
    'A schedule tried to fire an occurrence.',
    [
      ['scheduleId', 'string'],
      ['occurrence?', 'number'],
    ],
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
  ),
  'skill.loaded': entry('skill.loaded', 'unattributed', 'A skill was loaded for a run.', SKILL),
  'skill.activated': entry(
    'skill.activated',
    'unattributed',
    'A loaded skill was activated for a run.',
    SKILL,
  ),
  'skill.deactivated': entry(
    'skill.deactivated',
    'unattributed',
    'An active skill was deactivated.',
    SKILL,
  ),
  'skill.rejected': entry(
    'skill.rejected',
    'unattributed',
    'A skill was refused by a rule; `reason` and `rule` say which.',
    [...SKILL, ['reason', 'string'], ['rule?', 'string']],
  ),
  'skill.failed': entry(
    'skill.failed',
    'unattributed',
    'A skill failed while it was loading or running.',
    SKILL,
  ),
  'session.created': entry(
    'session.created',
    'unattributed',
    'A session was created.',
    SESSION.slice(0, 5),
  ),
  'session.saved': entry('session.saved', 'unattributed', 'A session was saved.', SESSION),
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
  ),
  'review.approved': entry('review.approved', 'run', 'A waiting review was approved.', REVIEW),
  'review.denied': entry('review.denied', 'run', 'A waiting review was denied.', REVIEW),
  'review.rejected': entry(
    'review.rejected',
    'run',
    'An answer to a review was rejected as invalid.',
    REVIEW,
  ),
  'review.expired': entry('review.expired', 'run', 'A waiting review expired unanswered.', REVIEW),
  'review.revoked': entry(
    'review.revoked',
    'run',
    'A review’s earlier approval was revoked.',
    REVIEW,
  ),
  'review.canceled': entry(
    'review.canceled',
    'run',
    'A waiting review was canceled with its run.',
    REVIEW,
  ),
  'review.superseded': entry(
    'review.superseded',
    'run',
    'A waiting review was replaced by a newer one.',
    REVIEW,
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
  'goal.started': entry('goal.started', 'run', 'A goal was started.', [
    ['goalRunId', 'string'],
    ['goalIdentity?', 'object'],
  ]),
  'goal.attempt.started': entry(
    'goal.attempt.started',
    'run',
    'A goal started an attempt.',
    GOAL_ATTEMPT,
  ),
  'goal.attempt.evaluating': entry(
    'goal.attempt.evaluating',
    'run',
    'A goal’s attempt finished its run and its validator started. Published live only, never in a goal’s recorded history.',
    GOAL_ATTEMPT,
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
  ),
  'goal.succeeded': entry('goal.succeeded', 'run', 'A goal succeeded.', GOAL_TERMINAL),
  'goal.exhausted': entry(
    'goal.exhausted',
    'run',
    'A goal used up its attempts without succeeding.',
    GOAL_TERMINAL,
  ),
  'goal.canceled': entry('goal.canceled', 'run', 'A goal was canceled.', GOAL_TERMINAL),
  'goal.failed': entry(
    'goal.failed',
    'run',
    'A goal failed. `validatorError` keeps the validator error’s `kind` and `code`; its message stays behind `bureau.goals.get`.',
    [
      ['goalRunId', 'string'],
      ['terminalReason?', 'string'],
      ['validatorError?', 'object'],
    ],
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
    'A rescan of the agent or workflow files changed what the catalog holds. `rejected` names the added or changed definitions that are invalid now.',
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
  ),
  'task.cleanup-acknowledged': entry(
    'task.cleanup-acknowledged',
    'run',
    'A task’s cleanup was acknowledged.',
    [
      ['taskId', 'string'],
      ['cleanup', 'string'],
    ],
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
