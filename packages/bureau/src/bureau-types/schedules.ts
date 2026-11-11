import type { WorkflowScheduleBlocker } from '../workflow-runtime';
import type { Subscription } from '@lostgradient/lifecycle';
import type {
  DurableEventEnvelope,
  DurableEventGap,
  DurableEventPage,
  SessionInputPayload,
} from '@lostgradient/operative';
import type {
  PaginatedResult,
  ScheduleFilter,
  ScheduleMissedFire,
  ScheduleSummary,
  ScheduleTriggerResult,
} from '@lostgradient/weft';
import type {
  DurableEventHistoryPageOptions,
  DurableEventHistorySubscribeOptions,
} from '../durable-event-history';
import type {
  EventHistoryDeletedAggregateOutcome,
  EventHistoryNotFoundOutcome,
  EventHistoryUnsupportedOutcome,
} from './common';

/** What {@link BureauSchedules.create} takes beside the definition. */
export interface CreateScheduleOptions {
  /** The run creating the schedule. See {@link BureauSchedules.create}. */
  readonly createdByRun?: string | undefined;
}
/**
 * The durable schedules of a Bureau: registering, reading, and changing recurring schedules, and
 * the history of their definitions. Every operation that needs the durable engine resolves
 * `undefined` when none is composed. `bureau.schedules.*` operations served by
 * `createBureauHandler` delegate to these members.
 */
export interface BureauSchedules {
  /** Reassign only future authority with a revision check; retain history and leave paused. */
  reassign(
    scheduleId: string,
    request: {
      readonly administrator: string;
      readonly targetOwner: string;
      readonly expectedRevision: number;
    },
  ): Promise<true | undefined>;
  /**
   * Register a durable recurring schedule via `engine.schedule(...)`.
   * Throws `ScheduleLocatorUnavailableError` when the schedule was created
   * but its summary could not be immediately retrieved — the schedule IS
   * registered in that case, only its locator failed. Returns `undefined`
   * when no durable engine is composed.
   *
   * `options.createdByRun` names the run that is creating the schedule, for a tool an agent calls
   * (a `scheduleSelf` of a host's own). When that run was started by a hook, directly or through
   * the runs above it, the schedule records the hook, and its fires are read as that hook's runs:
   * they start no `start-workflow` hook (COR-1952). A schedule created without it, or by a run no
   * hook started, is an owner's.
   */
  create(
    definition: DurableScheduleDefinition,
    options?: CreateScheduleOptions,
  ): Promise<ScheduleSummary | undefined>;

  /**
   * Retrieve a durable schedule by id. Returns `null` when the schedule does not
   * exist, `undefined` when no durable engine is composed.
   */
  get(scheduleId: string): Promise<ScheduleSummary | null | undefined>;

  /**
   * List durable schedules, optionally filtered. Returns `undefined` when no
   * durable engine is composed.
   */
  list(filter?: ScheduleFilter): Promise<PaginatedResult<ScheduleSummary> | undefined>;

  /**
   * Pause a durable schedule. Returns `true` on success, `undefined` when no
   * durable engine is composed. With `guard.expectedRevision`, the pause applies only if the
   * schedule's `revision` is still that value, and a mismatch throws Weft's
   * `ScheduleStaleRevisionError` having written nothing; Weft compares it inside its serialized
   * write, so Bureau never compares it itself.
   */
  pause(scheduleId: string, guard?: ScheduleRevisionGuard): Promise<true | undefined>;

  /**
   * Resume a paused durable schedule. Returns `true` on success, `undefined` when no durable
   * engine is composed. `guard` as for {@link BureauSchedules.pause}.
   */
  resume(scheduleId: string, guard?: ScheduleRevisionGuard): Promise<true | undefined>;

  /**
   * Cancel and permanently delete a durable schedule. Returns `true` on success,
   * `undefined` when no durable engine is composed. `guard` as for {@link BureauSchedules.pause}.
   */
  cancel(scheduleId: string, guard?: ScheduleRevisionGuard): Promise<true | undefined>;

  /**
   * Change a durable schedule's cadence, description, and overlap policy (COR-1482), and the agent,
   * text, and session each fire runs (COR-2018), by wrapping Weft's `updateSchedule`. Weft replaces
   * the cadence wholesale, so `update.spec` is required, in the same grammar as
   * {@link DurableScheduleDefinition.spec}. The schedule's owner is never changed, and the agent,
   * text, and session are only when `update` names them. Resolves `true`, or `undefined` when no durable engine is
   * composed. A schedule that does not exist, and a workflow file's schedule (which belongs to its
   * file), reject with `NOT_FOUND`; an overlap Bureau does not offer, or `'allow'` on a schedule
   * with a recurring session, rejects with `BAD_REQUEST`. `guard` as for
   * {@link BureauSchedules.pause}.
   */
  update(
    scheduleId: string,
    update: DurableScheduleUpdate,
    guard?: ScheduleRevisionGuard,
  ): Promise<true | undefined>;

  /**
   * Skip one upcoming run of a durable schedule (COR-1829, COR-2018), by wrapping Weft's
   * `skipNextScheduleOccurrence`: `occurrence`, in milliseconds since the epoch, the next run or any
   * after it, starts none, and the runs around it run as usual; left out, the next run is skipped,
   * whichever it is. Skipped runs are the summary's `skippedOccurrences` until the schedule moves
   * past them, and the next is not always `nextFireAt`: in a time zone `nextFireAt` can be the end
   * of a daylight-saving gap that fires nothing. The skip leaves the schedule's `revision` as it is,
   * and skipping a run already skipped changes nothing. A paused schedule's runs can be skipped,
   * counted from the first after now, and the pause keeps them for when it resumes.
   * Resolves `true`, or `undefined` when no durable engine is composed. A schedule that does not
   * exist, and a workflow file's schedule, reject with `NOT_FOUND`; a cancelled schedule has no run
   * to skip and rejects. `guard` as for {@link BureauSchedules.pause}.
   *
   * A fire moves neither the schedule's `revision` nor its `status`, so the run a caller read can
   * start before the skip is written (COR-1985). `occurrence` is compared inside the same write, and
   * the call rejects with Weft's `ScheduleOccurrenceNotNextError` and writes nothing when it is not
   * an upcoming run: a fire passed it, or the cadence starts no run then.
   */
  skipNext(
    scheduleId: string,
    guard?: ScheduleRevisionGuard,
    occurrence?: number,
  ): Promise<true | undefined>;

  /**
   * Take back the skip of one upcoming run of a durable schedule (COR-2018), by wrapping Weft's
   * `unskipScheduleOccurrence`: `occurrence`, one of the summary's `skippedOccurrences` in
   * milliseconds since the epoch, starts a run after all. Like a skip it leaves the schedule's
   * `revision` as it is, and an upcoming run that is not skipped changes nothing. A run that has
   * already passed cannot be taken back, and rejects with Weft's `ScheduleOccurrenceNotNextError`.
   * Resolves `true`, or `undefined` when no durable engine is composed. A schedule that does not
   * exist, and a workflow file's schedule, reject with `NOT_FOUND`; a cancelled schedule rejects.
   * `guard` as for {@link BureauSchedules.pause}.
   */
  unskip(
    scheduleId: string,
    occurrence: number,
    guard?: ScheduleRevisionGuard,
  ): Promise<true | undefined>;

  /**
   * Start one run of a durable schedule now (COR-1829), by wrapping Weft's `triggerSchedule`, under
   * the schedule's overlap policy: the result says whether the run `started` (with its run id, which
   * is the id of the task it creates), was `queued`, or was `skipped` because a run was still going.
   * The run is a task whose origin is `{ kind: 'schedule', manual: true }`; the schedule's
   * `nextFireAt` and `revision` do not change. A paused schedule can be run. Resolves `undefined` when
   * no durable engine is composed. A schedule that does not exist, and a workflow file's schedule,
   * reject with `NOT_FOUND`; a cancelled one rejects.
   */
  runNow(scheduleId: string): Promise<ScheduleTriggerResult | undefined>;

  /**
   * The occurrences a durable schedule missed, newest first (COR-1829), at most `options.limit` of the
   * schedule's most recent 100: a miss is `late` (the engine was down) or `dst-gap` (the clock
   * sprang forward past the time). Resolves `null` when the schedule does not exist and `undefined`
   * when no durable engine is composed. It does not check who may see the schedule, so a caller
   * answers to {@link Bureau.ownerOf} first.
   */
  missed(
    scheduleId: string,
    options?: { readonly limit?: number | undefined },
  ): Promise<ScheduleMissedFire[] | null | undefined>;

  /**
   * The name of the catalog agent an agent schedule runs, or `undefined` when there is no such
   * schedule, when it is a workflow file's schedule (which runs no agent of its own), or when no
   * durable engine is composed. It is read from the schedule's stored input and is the only part
   * of that input this returns: never its text or its session. It does not check who may see the
   * schedule, so a caller answers to {@link Bureau.ownerOf} first.
   */
  agentName(scheduleId: string): Promise<string | undefined>;

  /**
   * The start of the text an agent schedule sends each fire: at most 500 characters, ending in `…`
   * when it was cut, so a schedule can be told by what it says. `undefined` when there is no such
   * schedule, when it is a workflow file's, when its input holds no text, or when no durable engine
   * is composed. It reads the stored input beside {@link BureauSchedules.agentName}, never its
   * session, and does not check who may see the schedule, so a caller answers to
   * {@link Bureau.ownerOf} first.
   */
  inputPreview(scheduleId: string): Promise<string | undefined>;

  /**
   * Whether every fire of an agent schedule continues one session (COR-2018): `true` when the
   * schedule's stored input names a session, `false` when each fire is a fresh one. Only that
   * boolean leaves here, never the session's id. `undefined` when there is no such schedule, when
   * it is a workflow file's, or when no durable engine is composed. It does not check who may see
   * the schedule, so a caller answers to {@link Bureau.ownerOf} first.
   */
  continuesChat(scheduleId: string): Promise<boolean | undefined>;

  /**
   * COR-2009 — why a workflow file's schedule won't start: its file is there but stopped parsing,
   * so Bureau keeps the schedule its last good version made and holds it until the file parses
   * again. The answer names the workflow, the file's problem, and the status the schedule holds
   * meanwhile (`active` for one Bureau paused for the problem). `undefined` for any other schedule,
   * one whose file loads, and when no durable engine is composed. It does not check who may see the
   * schedule, so a caller answers to {@link Bureau.ownerOf} first.
   */
  blocker(scheduleId: string): Promise<WorkflowScheduleBlocker | undefined>;

  /**
   * One page of the schedule definition's durable event history (`schedule.created`, paused,
   * resumed, and cancelled), from the exclusive `options.since` cursor. It is
   * {@link BureauTasks.events} for the `schedule` owner: the outcomes, `options.principal`
   * authorization, and paging are that method's, so see it for the full contract.
   */
  events(
    scheduleId: string,
    options?: DurableEventHistoryPageOptions,
  ): Promise<
    | DurableEventPage
    | DurableEventGap
    | EventHistoryUnsupportedOutcome
    | EventHistoryNotFoundOutcome
    | EventHistoryDeletedAggregateOutcome
  >;

  /**
   * Replays the schedule definition's durable event history from the exclusive `options.since`
   * cursor, then delivers live events with no gap and no duplicate at the handoff. It is
   * {@link BureauTasks.subscribeEvents} for the `schedule` owner, so an ephemeral bureau returns
   * an already-closed subscription and `options.principal` applies as it does there.
   */
  subscribeEvents(
    scheduleId: string,
    listener: (event: DurableEventEnvelope) => void,
    options?: DurableEventHistorySubscribeOptions,
  ): Subscription;
}
// ── Durable Schedule ────────────────────────────────────────────────

/**
 * Parameters for registering a durable bureau schedule via
 * {@link BureauSchedules.create}. The schedule fires the named `agentName`
 * on the given `spec`; each fire is either a fresh session (no `sessionId`)
 * or appended to the same persistent session (`sessionId` given).
 */
/**
 * Applies a schedule change only to the schedule the caller read: the `revision` of its summary
 * (COR-1482). Weft compares it inside its serialized write.
 */
export interface ScheduleRevisionGuard {
  readonly expectedRevision?: number | undefined;
}
/**
 * What {@link BureauSchedules.update} changes. Omitted `description`, `overlap`, `agentName`,
 * `input`, and `sessionId` keep their values.
 */
export interface DurableScheduleUpdate {
  /** The schedule's new cadence: a cron expression or a Weft duration shorthand, as at creation. */
  readonly spec: string;
  readonly description?: string | undefined;
  readonly overlap?: 'skip' | 'allow' | undefined;
  /**
   * The catalog agent each fire runs from now on. An agent that is not in the catalog rejects with
   * {@link UnknownScheduleAgentError} and changes nothing, as at creation.
   */
  readonly agentName?: string | undefined;
  /**
   * The text each fire sends from now on. It replaces the text of the stored input: an input that
   * also carries media keeps its media parts, after the new text.
   */
  readonly input?: string | undefined;
  /**
   * The session each fire continues from now on, or `null` to make every fire a fresh session
   * again. A session on a schedule whose overlap is `'allow'` rejects with `BAD_REQUEST`, as at
   * creation.
   */
  readonly sessionId?: string | null | undefined;
  /**
   * Start a new chat that every fire continues from now on, which Bureau names itself (the
   * schedule's first fire makes it, owned by the schedule's owner). It replaces the chat the
   * schedule continued, if any, and is refused together with `sessionId`. Under a workspace a
   * caller cannot name a chat that does not exist yet, so this is how a schedule is given one.
   */
  readonly continueChat?: boolean | undefined;
  /**
   * The schedule's new IANA time zone (see {@link DurableScheduleDefinition.timeZone}). Left as it
   * was when omitted; an interval `spec` is always read as UTC.
   */
  readonly timeZone?: string | undefined;
}
export interface DurableScheduleDefinition {
  /** Human-readable operator description stored with the schedule. */
  description?: string;
  /** Agent name to run on each schedule fire. */
  agentName: string;
  /**
   * Input delivered to the agent each fire: text, or an ordered list of text and
   * media parts delivered as one user message.
   */
  input: SessionInputPayload;
  /** Cron expression (e.g. `'0 9 * * *'`) or weft duration shorthand (e.g. `'6h'`, `'30s'`, `'1d'`). */
  spec: string;
  /**
   * When given, each schedule fire appends a run to this session — building a
   * recurring conversation that accumulates context across fires. When omitted,
   * each fire is a fresh standalone session.
   */
  sessionId?: string;
  /**
   * Start a new chat that every fire continues, which Bureau names itself; the first fire makes it,
   * owned by the schedule's owner. Refused together with `sessionId`. Under a workspace a caller
   * cannot name a chat that does not exist yet, so this is how a schedule is given a new one.
   */
  continueChat?: boolean;
  /** Overlap policy when a prior fire is still running. Defaults to `'skip'`. */
  overlap?: 'skip' | 'allow';
  /**
   * The IANA time zone a cron `spec` is read in, such as `America/Los_Angeles`, or `UTC`. Omitted, the
   * schedule runs in UTC. A wall-clock time the clock skips when it springs forward (a daily 02:30 on
   * that day) is counted as a missed fire with reason `dst-gap`, and one it repeats when it falls back
   * runs once. Only a cron `spec` takes one; an interval with a zone is refused.
   */
  timeZone?: string;
  /**
   * The schedule's owner of record (COR-718), written once into the schedule's
   * `ScheduledAgentRunInput.principal`. Every fire's run is owned by it, and the
   * scheduler is only ever the actor on the fire's `schedule.fired` audit entry.
   * Omitted, the schedule is owned by `anonymous:local`.
   */
  principal?: string;
}
