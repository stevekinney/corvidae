/**
 * The browser's view of the Bureau's schedules: `bureau.schedules.*` (COR-1482), parsed at the
 * boundary. A Bureau schedule is a native Weft schedule that fires the built-in `agentRun`
 * workflow, so the engine lists it with the rest; this is how one is created, and how the agent it
 * runs is learned. Every write takes `expectedRevision`, the revision of the schedule the caller
 * read, which Weft compares inside its serialized write: a schedule that changed since is
 * `StaleRevision`, and nothing is written.
 *
 * A schedule's view carries the start of its input, the prompt each fire runs (`inputPreview`, at
 * most 500 characters), and names the agent (`agentName`). Both are `null` for the schedule of a
 * workflow file, because that runs no agent and sends no prompt.
 */
import { HttpClientError, type ScheduleSpec } from '@lostgradient/weft';
import { z } from 'zod';

import { callBureau, type Fetcher } from './bureau-client.ts';

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

const statusSchema = z.enum(['active', 'paused', 'cancelled']);

const viewSchema = z.object({
  id: z.string(),
  owner: z.string(),
  agentName: z.string().nullable(),
  inputPreview: z.string().nullable(),
  workflowType: z.string(),
  description: z.string().nullable(),
  cronExpression: z.string().nullable(),
  intervalMs: z.number().nullable(),
  status: statusSchema,
  overlap: z.enum(['skip', 'queue', 'cancel-running', 'allow']),
  revision: z.number().int(),
  /** The IANA zone a cron cadence is read in; `UTC` for an interval and for a schedule made without one. */
  timeZone: z.string(),
  nextFireAt: z.string().nullable(),
  /** The fire a person asked to skip, or `null` when none is. */
  skipUntil: z.string().nullable(),
  lastFireAt: z.string().nullable(),
  missedFireCount: z.number().int(),
  skippedCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** One schedule as `bureau.schedules.list`, `get`, and `create` show it. */
export type BureauSchedule = z.infer<typeof viewSchema>;

const receiptSchema = z.object({
  id: z.string(),
  status: statusSchema,
  revision: z.number().int(),
});

/** What a write answers: the schedule's status and its revision after the change. */
export type BureauScheduleReceipt = z.infer<typeof receiptSchema>;

/** The largest page `bureau.schedules.list` answers. */
const LISTING_PAGE_SIZE = 100;

const pageSchema = z.object({
  schedules: z.array(viewSchema),
  nextOffset: z.number().nullable(),
});

/** Every schedule the caller may see, following the pages to the end. */
export async function listBureauSchedules(options?: Options): Promise<readonly BureauSchedule[]> {
  const schedules: BureauSchedule[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page: z.infer<typeof pageSchema> = pageSchema.parse(
      await callBureau('bureau.schedules.list', { limit: LISTING_PAGE_SIZE, offset }, options),
    );
    schedules.push(...page.schedules);
    offset = page.nextOffset;
  }
  return schedules;
}

/** The units of Weft's duration grammar, largest first, with how many milliseconds each is. */
const DURATION_UNITS: readonly (readonly [string, number])[] = [
  ['d', 86_400_000],
  ['h', 3_600_000],
  ['m', 60_000],
  ['s', 1_000],
];

/**
 * A cadence as the Bureau takes it: a cron expression, or a duration. A cadence in milliseconds is
 * sent in the largest unit of Weft's duration grammar that holds it whole, so an hour is `1h`.
 */
export function bureauSpecOf(spec: ScheduleSpec): string {
  if ('cron' in spec) return spec.cron;
  if (typeof spec.every !== 'number') return spec.every;
  for (const [unit, milliseconds] of DURATION_UNITS) {
    if (spec.every % milliseconds === 0) return `${String(spec.every / milliseconds)}${unit}`;
  }
  return `${String(spec.every)}ms`;
}

/** What creating a schedule that runs an agent needs. An optional field that is empty is left out. */
export type AgentScheduleInput = {
  readonly agentName: string;
  /** A cron expression, or a duration such as `30s`, `6h`, or `1d`. */
  readonly spec: string;
  /** The text delivered to the agent each fire. */
  readonly input: string;
  readonly description?: string;
  /** A session each fire continues. Without one, every fire is a fresh session. */
  readonly sessionId?: string;
  readonly overlap?: 'skip' | 'allow';
  /** The IANA zone a cron `spec` is read in. Left out for an interval, which the Bureau refuses one for. */
  readonly timeZone?: string;
};

/** Creates a schedule the caller owns. Its revision is `1`. */
export async function createAgentSchedule(
  schedule: AgentScheduleInput,
  options?: Options,
): Promise<BureauSchedule> {
  const params = {
    agentName: schedule.agentName,
    spec: schedule.spec,
    input: schedule.input,
    ...(schedule.description === undefined || schedule.description === ''
      ? {}
      : { description: schedule.description }),
    ...(schedule.sessionId === undefined || schedule.sessionId === ''
      ? {}
      : { sessionId: schedule.sessionId }),
    ...(schedule.overlap === undefined ? {} : { overlap: schedule.overlap }),
    ...(schedule.timeZone === undefined ? {} : { timeZone: schedule.timeZone }),
  };
  return viewSchema.parse(await callBureau('bureau.schedules.create', params, options));
}

/** A write that names the revision it read. An absent revision is not sent, which compares nothing. */
async function guardedWrite(
  method: string,
  scheduleId: string,
  expectedRevision: number | undefined,
  options?: Options,
): Promise<BureauScheduleReceipt> {
  const params = {
    scheduleId,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  };
  return receiptSchema.parse(await callBureau(method, params, options));
}

/**
 * Pauses a schedule so it stops firing (`bureau.schedules.pause`), guarded by the revision the
 * caller read.
 */
export function pauseAgentSchedule(
  scheduleId: string,
  expectedRevision: number | undefined,
  options?: Options,
): Promise<BureauScheduleReceipt> {
  return guardedWrite('bureau.schedules.pause', scheduleId, expectedRevision, options);
}

/**
 * Resumes a paused schedule (`bureau.schedules.resume`), guarded by the revision the caller read.
 */
export function resumeAgentSchedule(
  scheduleId: string,
  expectedRevision: number | undefined,
  options?: Options,
): Promise<BureauScheduleReceipt> {
  return guardedWrite('bureau.schedules.resume', scheduleId, expectedRevision, options);
}

/**
 * Cancels a schedule for good (`bureau.schedules.cancel`), guarded by the revision the caller
 * read.
 */
export function cancelAgentSchedule(
  scheduleId: string,
  expectedRevision: number | undefined,
  options?: Options,
): Promise<BureauScheduleReceipt> {
  return guardedWrite('bureau.schedules.cancel', scheduleId, expectedRevision, options);
}

/** What an update changes: the cadence always, and the description, overlap, and zone when they are given. */
export type AgentScheduleUpdate = {
  readonly spec: string;
  readonly description?: string;
  readonly overlap?: 'skip' | 'allow';
  /** The IANA zone a cron `spec` is read in. Left out, the Bureau keeps the schedule's zone. */
  readonly timeZone?: string;
};

/** Replaces the schedule's cadence, and changes its description, overlap, and zone when they are given. */
export async function updateAgentSchedule(
  scheduleId: string,
  update: AgentScheduleUpdate,
  expectedRevision: number | undefined,
  options?: Options,
): Promise<BureauScheduleReceipt> {
  const params = {
    scheduleId,
    spec: update.spec,
    ...(update.description === undefined ? {} : { description: update.description }),
    ...(update.overlap === undefined ? {} : { overlap: update.overlap }),
    ...(update.timeZone === undefined ? {} : { timeZone: update.timeZone }),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  };
  return receiptSchema.parse(await callBureau('bureau.schedules.update', params, options));
}

/**
 * Skips the fire the caller read (`bureau.schedules.skipnext`), guarded by the revision the caller
 * read. A fire moves neither the revision nor the status, so the call also names the fire
 * (`occurrence`, in milliseconds since the epoch, sent as the ISO 8601 instant the Bureau takes):
 * when that is no longer the schedule's next fire the Bureau answers a `Conflict` whose
 * `data.reason` is `occurrence-not-next` ({@link isOccurrenceNotNext}) and writes nothing.
 */
export async function skipNextAgentSchedule(
  scheduleId: string,
  expectedRevision: number | undefined,
  occurrence: number,
  options?: Options,
): Promise<BureauScheduleReceipt> {
  const params = {
    scheduleId,
    occurrence: new Date(occurrence).toISOString(),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  };
  return receiptSchema.parse(await callBureau('bureau.schedules.skipnext', params, options));
}

/** Whether `error` is the Bureau's answer to a skip that named a fire that is no longer the next one. */
export function isOccurrenceNotNext(error: unknown): boolean {
  return (
    error instanceof HttpClientError &&
    error.data?.['weftCode'] === 'Conflict' &&
    error.data['reason'] === 'occurrence-not-next'
  );
}

const runNowSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('started'), taskId: z.string() }),
  z.object({ outcome: z.literal('queued'), taskId: z.string() }),
  z.object({ outcome: z.literal('skipped'), blockingTaskId: z.string().nullable() }),
]);

/** What a run now did under the schedule's overlap policy: it started, queued behind the running one, or was skipped. */
export type RunNowOutcome =
  | { readonly outcome: 'started' | 'queued'; readonly runId: string }
  | { readonly outcome: 'skipped'; readonly blockingRunId: string | null };

/**
 * Starts one run of the schedule now (`bureau.schedules.runnow`). The Bureau takes no revision for
 * it: a run now is not a change to the schedule, and a schedule that was cancelled meanwhile is
 * refused as a `Conflict`.
 */
export async function runNowAgentSchedule(
  scheduleId: string,
  options?: Options,
): Promise<RunNowOutcome> {
  const answer = runNowSchema.parse(
    await callBureau('bureau.schedules.runnow', { scheduleId }, options),
  );
  return answer.outcome === 'skipped'
    ? { outcome: 'skipped', blockingRunId: answer.blockingTaskId }
    : { outcome: answer.outcome, runId: answer.taskId };
}

const missedRowSchema = z.object({
  occurrence: z.string(),
  reason: z.enum(['late', 'dst-gap']),
  count: z.number().int(),
  recordedAt: z.string(),
});

/** One fire a schedule missed, as the schedule recorded it. `occurrence` is the instant it is recorded at. */
export type MissedFire = {
  /** The instant the miss is recorded at, in milliseconds: the occurrence's time for `late`, the end of the gap for `dst-gap`. */
  readonly occurrence: number;
  /** Why it was missed: the host was down or too slow (`late`), or the clock skipped the time (`dst-gap`). */
  readonly reason: 'late' | 'dst-gap';
  /** How many fires the row stands for. */
  readonly count: number;
  /** When the schedule recorded the miss, in milliseconds. */
  readonly recordedAt: number;
};

/** The fires one schedule missed, newest first (`bureau.schedules.missed`), which a reload still lists. */
export async function listAgentScheduleMissed(
  scheduleId: string,
  options?: Options,
): Promise<readonly MissedFire[]> {
  const answer = z
    .object({ missed: z.array(missedRowSchema) })
    .parse(await callBureau('bureau.schedules.missed', { scheduleId }, options));
  return answer.missed.map((row) => ({
    occurrence: Date.parse(row.occurrence),
    reason: row.reason,
    count: row.count,
    recordedAt: Date.parse(row.recordedAt),
  }));
}
