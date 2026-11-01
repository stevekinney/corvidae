/**
 * Data-fetching + mutation helpers for the Schedules domain (Track B, plan
 * §4, §9.3). Plain, framework-free functions over `HttpClient` — the
 * `.svelte` files wire these into `createQuery`/`createMutation`
 * (`@tanstack/svelte-query`); this module stays unit-testable without a DOM.
 *
 * List queries reuse the frozen `queryKeys.schedules.list` from
 * `src/lib/query.ts` (T1.5's shared key, already registered with
 * `keepPreviousData` there). `scheduleDetailQueryKey` is this track's own
 * addition — `src/lib/query.ts` didn't define one — kept in the same tuple
 * shape (`['schedules', 'detail', id]`) the frozen module's own
 * `workflows.detail`/`schedules.list` keys use, per PROJECT-BRIEF: "if
 * something genuinely blocks you … make the smallest local workaround"
 * rather than editing the frozen file for one missing key.
 */
import {
  HttpClientError,
  type Duration,
  type HttpClient,
  type PaginatedResult,
  type ScheduleFilter,
  type ScheduleOptions,
  type ScheduleOverlapPolicy,
  type ScheduleRevisionPolicy,
  type ScheduleSpec,
  type ScheduleSummary,
  type ScheduleUpdateOptions,
  type WorkflowSummary,
} from '@lostgradient/weft';

import type { QueryKey } from '@tanstack/svelte-query';

import type { MissedFire, RunNowOutcome } from '../../lib/bureau-schedules.ts';

export function scheduleDetailQueryKey(id: string): QueryKey {
  return ['schedules', 'detail', id] as const;
}

export function scheduleRunHistoryQueryKey(id: string): QueryKey {
  return ['schedules', 'run-history', id] as const;
}

export function scheduleMissedQueryKey(id: string): QueryKey {
  return ['schedules', 'missed', id] as const;
}

/** How many runs the table reads: the newest. */
const SCHEDULE_RUN_HISTORY_LIMIT = 10;

/**
 * `GET /api/v1/workflows?scheduleId=…` (`weft.workflows.list`'s `scheduleId`
 * filter) — the schedule's most recently launched runs, newest first (the
 * operation's documented "engine default ordering" is `createdAt`
 * descending; verified against `weft/src/core/engine/listing.ts`). Added by
 * weft#759 ("Expose schedule run history", weft 0.13+) closing weft#735,
 * which this console filed after finding no way to query which workflow
 * runs a schedule had launched — see `schedule-detail.svelte`'s "Recent
 * runs" panel, the sole consumer.
 */
export function fetchScheduleRunHistory(
  client: Pick<HttpClient, 'list'>,
  scheduleId: string,
): Promise<PaginatedResult<WorkflowSummary>> {
  return client.list({ scheduleId, limit: SCHEDULE_RUN_HISTORY_LIMIT });
}

/** `GET /api/v1/schedules` — page of schedule summaries. */
export function fetchScheduleList(
  client: Pick<HttpClient, 'listSchedules'>,
  filter: ScheduleFilter,
): Promise<PaginatedResult<ScheduleSummary>> {
  return client.listSchedules(filter);
}

/** `GET /api/v1/schedules/:id` — `null` when no schedule with that id exists. */
export function fetchScheduleDetail(
  client: Pick<HttpClient, 'getSchedule'>,
  id: string,
): Promise<ScheduleSummary | null> {
  return client.getSchedule(id);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface CreateScheduleArgs {
  readonly workflowType: string;
  readonly input: unknown;
  readonly spec: ScheduleSpec;
  readonly id?: string;
  readonly description?: string;
  readonly overlap?: ScheduleOverlapPolicy;
  readonly backfill?: boolean;
  readonly jitter?: Duration;
  /** The IANA zone a cron `spec` is read in. Left out for an interval, which Weft refuses one for. */
  readonly timeZone?: string;
  readonly revisionPolicy?: ScheduleRevisionPolicy;
}

/** The one `HttpClient.schedule()` shape `createSchedule` needs — narrowed past the real (overloaded, generic-name-inferring) signature so a plain test fake can satisfy it. A real `HttpClient` satisfies this structurally: its richer `ClientScheduleHandle` return value is assignable to `{ id: string }`. */
export interface ScheduleCreateClient {
  schedule(
    workflowType: string,
    input: unknown,
    spec: ScheduleSpec,
    options?: ScheduleOptions,
  ): Promise<{ readonly id: string }>;
}

/** `POST /api/v1/schedules` (`weft.schedules.create`) — returns the created schedule's id. */
export async function createSchedule(
  client: ScheduleCreateClient,
  args: CreateScheduleArgs,
): Promise<{ id: string }> {
  const handle = await client.schedule(args.workflowType, args.input, args.spec, {
    ...(args.id !== undefined ? { id: args.id } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...(args.overlap !== undefined ? { overlap: args.overlap } : {}),
    ...(args.backfill !== undefined ? { backfill: args.backfill } : {}),
    ...(args.jitter !== undefined ? { jitter: args.jitter } : {}),
    ...(args.timeZone !== undefined ? { timeZone: args.timeZone } : {}),
    ...(args.revisionPolicy !== undefined ? { revisionPolicy: args.revisionPolicy } : {}),
  });
  return { id: handle.id };
}

/**
 * `PATCH /api/v1/schedules/:id` (`weft.schedules.update`).
 *
 * `options` is `ScheduleUpdateOptions` (`description | overlap | backfill |
 * jitter | timeZone | revisionPolicy`), forwarded as-is. Callers pass
 * `ScheduleFormState.toUpdateOptions()`, which already applies the
 * omit-when-unchanged rule to every key: `undefined` (or an absent key)
 * preserves the schedule's current value, and that matters most for
 * `revisionPolicy: 'pinned'`, which is never a no-op server-side — it always
 * re-captures the pin against whatever is active at that moment.
 */
export function updateScheduleSpec(
  client: Pick<HttpClient, 'updateSchedule'>,
  id: string,
  spec: ScheduleSpec,
  options?: ScheduleUpdateOptions,
): Promise<void> {
  return client.updateSchedule(id, spec, options);
}

export function pauseSchedule(
  client: Pick<HttpClient, 'pauseSchedule'>,
  id: string,
): Promise<void> {
  return client.pauseSchedule(id);
}

export function resumeSchedule(
  client: Pick<HttpClient, 'resumeSchedule'>,
  id: string,
): Promise<void> {
  return client.resumeSchedule(id);
}

export function cancelSchedule(
  client: Pick<HttpClient, 'cancelSchedule'>,
  id: string,
): Promise<void> {
  return client.cancelSchedule(id);
}

/** The engine operations a schedule's controls call, narrowed so a plain test fake can satisfy them. */
export interface ScheduleControlClient {
  readonly operations: {
    'weft.schedules.runnow': (input: {
      scheduleId: string;
    }) => Promise<
      | { readonly outcome: 'started'; readonly workflowId: string }
      | { readonly outcome: 'queued'; readonly workflowId: string }
      | { readonly outcome: 'skipped'; readonly blockingWorkflowId?: string }
    >;
    'weft.schedules.missed': (input: { scheduleId: string }) => Promise<{
      readonly missed: ReadonlyArray<{
        readonly occurrence: number;
        readonly reason: 'late' | 'dst-gap';
        readonly count: number;
        readonly recordedAt: number;
      }>;
    }>;
  };
}

/**
 * `POST /api/v1/schedules/:id/skip-next` ('weft.schedules.skipnext'): the next fire that would
 * start a run starts none. It answers `204` with no body, which the JSON-RPC operation client
 * reads as an invalid response, so this is the REST call, made with the client's own address and
 * headers. A refusal is an `HttpClientError`, as every other write of the client raises.
 */
export async function skipNextSchedule(
  client: Pick<HttpClient, 'baseUrl' | 'headers'>,
  id: string,
): Promise<void> {
  const response = await fetch(
    `${client.baseUrl}/v1/schedules/${encodeURIComponent(id)}/skip-next`,
    { method: 'POST', headers: client.headers },
  );
  if (response.ok) return;
  let message = response.statusText;
  let data: Record<string, unknown> | undefined;
  try {
    const body: unknown = await response.json();
    if (isPlainObject(body)) {
      if (typeof body['error'] === 'string') message = body['error'];
      data = body;
    }
  } catch {
    // A body that is not JSON leaves the status text as the message.
  }
  throw new HttpClientError(response.status, message, data === undefined ? {} : { data });
}

/** `POST /api/v1/schedules/:id/run-now` (`weft.schedules.runnow`): one run now, under the schedule's overlap policy. */
export async function runNowSchedule(
  client: Pick<ScheduleControlClient, 'operations'>,
  id: string,
): Promise<RunNowOutcome> {
  const answer = await client.operations['weft.schedules.runnow']({ scheduleId: id });
  return answer.outcome === 'skipped'
    ? { outcome: 'skipped', blockingRunId: answer.blockingWorkflowId ?? null }
    : { outcome: answer.outcome, runId: answer.workflowId };
}

/** `GET /api/v1/schedules/:id/missed` (`weft.schedules.missed`): the fires the schedule missed, newest first. */
export async function listScheduleMissed(
  client: Pick<ScheduleControlClient, 'operations'>,
  id: string,
): Promise<readonly MissedFire[]> {
  const answer = await client.operations['weft.schedules.missed']({ scheduleId: id });
  return answer.missed.map(({ occurrence, reason, count, recordedAt }) => ({
    occurrence,
    reason,
    count,
    recordedAt,
  }));
}
