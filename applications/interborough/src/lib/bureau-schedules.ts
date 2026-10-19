/**
 * The browser's view of the Bureau's schedules: `bureau.schedules.*` (COR-1482), parsed at the
 * boundary. A Bureau schedule is a native Weft schedule that fires the built-in `agentRun`
 * workflow, so the engine lists it with the rest; this is how one is created, and how the agent it
 * runs is learned. Every write takes `expectedRevision`, the revision of the schedule the caller
 * read, which Weft compares inside its serialized write: a schedule that changed since is
 * `StaleRevision`, and nothing is written.
 *
 * A schedule's view never carries its input, the prompt each fire runs. It does name the agent
 * (`agentName`), which is `null` for the schedule of a workflow file, because that runs none.
 */
import type { ScheduleSpec } from '@lostgradient/weft';
import { z } from 'zod';

import { callBureau, type Fetcher } from './bureau-client.ts';

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

const statusSchema = z.enum(['active', 'paused', 'cancelled']);

const viewSchema = z.object({
  id: z.string(),
  owner: z.string(),
  agentName: z.string().nullable(),
  workflowType: z.string(),
  description: z.string().nullable(),
  cronExpression: z.string().nullable(),
  intervalMs: z.number().nullable(),
  status: statusSchema,
  overlap: z.enum(['skip', 'queue', 'cancel-running', 'allow']),
  revision: z.number().int(),
  nextFireAt: z.string().nullable(),
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

export function pauseAgentSchedule(
  scheduleId: string,
  expectedRevision: number | undefined,
  options?: Options,
): Promise<BureauScheduleReceipt> {
  return guardedWrite('bureau.schedules.pause', scheduleId, expectedRevision, options);
}

export function resumeAgentSchedule(
  scheduleId: string,
  expectedRevision: number | undefined,
  options?: Options,
): Promise<BureauScheduleReceipt> {
  return guardedWrite('bureau.schedules.resume', scheduleId, expectedRevision, options);
}

export function cancelAgentSchedule(
  scheduleId: string,
  expectedRevision: number | undefined,
  options?: Options,
): Promise<BureauScheduleReceipt> {
  return guardedWrite('bureau.schedules.cancel', scheduleId, expectedRevision, options);
}

/** What an update changes: the cadence always, and the description and overlap when they are given. */
export type AgentScheduleUpdate = {
  readonly spec: string;
  readonly description?: string;
  readonly overlap?: 'skip' | 'allow';
};

/** Replaces the schedule's cadence, and changes its description and overlap when they are given. */
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
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  };
  return receiptSchema.parse(await callBureau('bureau.schedules.update', params, options));
}
