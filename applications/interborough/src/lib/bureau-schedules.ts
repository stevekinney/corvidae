/**
 * The browser's view of the Bureau's schedules: `bureau.schedules.*` (COR-1482), through the
 * generated client. A Bureau schedule is a native Weft schedule that fires the built-in `agentRun`
 * workflow, so the engine lists it with the rest; this is how one is created, and how the agent it
 * runs is learned. Every write takes `expectedRevision`, the revision of the schedule the caller
 * read, which Weft compares inside its serialized write: a schedule that changed since is
 * `StaleRevision`, and nothing is written.
 *
 * A schedule's view carries the start of its input, the prompt each fire runs (`inputPreview`, at
 * most 500 characters), and names the agent (`agentName`). Both are `null` for the schedule of a
 * workflow file, because that runs no agent and sends no prompt. Non-owner workspace responses also redact
 * input previews, last-fire timestamps, and private fire counters to `null`.
 */
import { HttpClientError, type ScheduleSpec } from '@lostgradient/weft';
import { bureauClient, type BureauOutput } from './bureau-api.ts';
import type { Fetcher } from './bureau-client.ts';

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

/**
 * One schedule as `bureau.schedules.list`, `get`, and `create` show it. `continuesChat` says whether
 * every fire continues one chat (the chat's own id is never served); `timeZone` is the IANA zone a
 * cron cadence is read in, `UTC` for an interval; `skippedOccurrences` are the upcoming fires a
 * person asked to skip, as ISO 8601 instants, soonest first; `blocker` is why the schedule will not
 * start, or `null` when nothing blocks it: a workflow file's schedule whose file stopped parsing is
 * kept from the file's last good version and starts nothing until the file parses again.
 */
export type BureauSchedule = BureauOutput<'bureau.schedules.get'>;

/**
 * A schedule as a Bureau that does not say has it: not continuing a chat, and with nothing blocking
 * it. The server's schema always sends both, so these defaults belong to the browser, applied to the
 * typed result.
 */
export function scheduleOf(
  view: Omit<BureauSchedule, 'continuesChat' | 'blocker'> & {
    readonly continuesChat?: boolean | undefined;
    readonly blocker?: BureauSchedule['blocker'] | undefined;
  },
): BureauSchedule {
  return { ...view, continuesChat: view.continuesChat ?? false, blocker: view.blocker ?? null };
}

/** What a write answers: the schedule's status and its revision after the change. */
export type BureauScheduleReceipt = BureauOutput<'bureau.schedules.pause'>;

/** The largest page `bureau.schedules.list` answers. */
const LISTING_PAGE_SIZE = 100;

/** Every schedule the caller may see, following the pages to the end. */
export async function listBureauSchedules(options?: Options): Promise<readonly BureauSchedule[]> {
  const schedules: BureauSchedule[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page: BureauOutput<'bureau.schedules.list'> = await bureauClient['bureau.schedules.list'](
      { limit: LISTING_PAGE_SIZE, offset },
      options,
    );
    schedules.push(...page.schedules.map(scheduleOf));
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
  /**
   * Every fire continues one new chat, which the Bureau names and the first fire makes as the
   * schedule's owner. A page cannot make up the chat's identifier itself, because under a
   * workspace the Bureau refuses a chat that is not yet its owner's.
   */
  readonly continueChat?: true;
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
    ...(schedule.continueChat === true ? { continueChat: true } : {}),
    ...(schedule.overlap === undefined ? {} : { overlap: schedule.overlap }),
    ...(schedule.timeZone === undefined ? {} : { timeZone: schedule.timeZone }),
  };
  return scheduleOf(await bureauClient['bureau.schedules.create'](params, options));
}

/** The params of a write that names the revision it read. An absent revision is not sent, which compares nothing. */
function guardedParams(
  scheduleId: string,
  expectedRevision: number | undefined,
): { readonly scheduleId: string; readonly expectedRevision?: number } {
  return { scheduleId, ...(expectedRevision === undefined ? {} : { expectedRevision }) };
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
  return bureauClient['bureau.schedules.pause'](
    guardedParams(scheduleId, expectedRevision),
    options,
  );
}

/**
 * Resumes a paused schedule (`bureau.schedules.resume`), guarded by the revision the caller read.
 */
export function resumeAgentSchedule(
  scheduleId: string,
  expectedRevision: number | undefined,
  options?: Options,
): Promise<BureauScheduleReceipt> {
  return bureauClient['bureau.schedules.resume'](
    guardedParams(scheduleId, expectedRevision),
    options,
  );
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
  return bureauClient['bureau.schedules.cancel'](
    guardedParams(scheduleId, expectedRevision),
    options,
  );
}

/**
 * What an update changes: the cadence always, and the description, overlap, zone, agent, message,
 * and chat when they are given. A field that is left out is kept as the schedule has it.
 */
export type AgentScheduleUpdate = {
  readonly spec: string;
  readonly description?: string;
  readonly overlap?: 'skip' | 'allow';
  /** The IANA zone a cron `spec` is read in. Left out, the Bureau keeps the schedule's zone. */
  readonly timeZone?: string;
  /** The catalog agent each fire runs from now on. */
  readonly agentName?: string;
  /** The text each fire sends from now on, which replaces the schedule's text whole. */
  readonly input?: string;
  /** The chat every fire continues from now on, or `null` to make each fire a fresh chat. */
  readonly sessionId?: string | null;
  /**
   * Every fire continues one new chat from now on, which the Bureau names, replacing the chat the
   * schedule continued. It is how the agent of a schedule that continues a chat is changed, because
   * the Bureau refuses an agent apart from its chat.
   */
  readonly continueChat?: true;
};

/** Replaces the schedule's cadence, and changes its description, overlap, zone, agent, message, and chat when they are given. */
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
    ...(update.agentName === undefined ? {} : { agentName: update.agentName }),
    ...(update.input === undefined ? {} : { input: update.input }),
    ...(update.sessionId === undefined ? {} : { sessionId: update.sessionId }),
    ...(update.continueChat === true ? { continueChat: true } : {}),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  };
  return bureauClient['bureau.schedules.update'](params, options);
}

/**
 * Skips the fire the caller read (`bureau.schedules.skipnext`), the next or a later one, guarded by
 * the revision the caller read. A fire moves neither the revision nor the status, so the call also
 * names the fire (`occurrence`, in milliseconds since the epoch, sent as the ISO 8601 instant the
 * Bureau takes): when that is no longer an upcoming fire the Bureau answers a `Conflict` whose
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
  return bureauClient['bureau.schedules.skipnext'](params, options);
}

/**
 * Takes back the skip of the fire the caller read (`bureau.schedules.unskip`), guarded by the
 * revision the caller read, so it starts a task after all. A fire that has passed since is a
 * `Conflict` whose `data.reason` is `occurrence-not-next` ({@link isOccurrenceNotNext}), and
 * nothing is written.
 */
export async function unskipAgentSchedule(
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
  return bureauClient['bureau.schedules.unskip'](params, options);
}

/** Whether `error` is the Bureau's answer to a skip or an unskip that named a fire that is no longer upcoming. */
export function isOccurrenceNotNext(error: unknown): boolean {
  return (
    error instanceof HttpClientError &&
    error.data?.['weftCode'] === 'Conflict' &&
    error.data['reason'] === 'occurrence-not-next'
  );
}

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
  const answer = await bureauClient['bureau.schedules.runnow']({ scheduleId }, options);
  return answer.outcome === 'skipped'
    ? { outcome: 'skipped', blockingRunId: answer.blockingTaskId }
    : { outcome: answer.outcome, runId: answer.taskId };
}

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
  const answer = await bureauClient['bureau.schedules.missed']({ scheduleId }, options);
  return answer.missed.map((row) => ({
    occurrence: Date.parse(row.occurrence),
    reason: row.reason,
    count: row.count,
    recordedAt: Date.parse(row.recordedAt),
  }));
}
