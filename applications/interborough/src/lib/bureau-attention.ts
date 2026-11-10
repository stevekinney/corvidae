/**
 * The browser's view of what needs attention: `bureau.health.attention`, which lists the system
 * problems that need a person now (an alert rule firing, a schedule that missed runs, a hook whose
 * delivery failed, a plugin that did not load, a worker that stopped answering, no model provider connected). Reviews waiting on a
 * person are never on it: they are Needs you, which the reviews count reads.
 *
 * The sidebar's Health dot reads only how many there are. The notification bell reads the rules
 * that are firing, so those are parsed here too; the Health page reads the items themselves, which
 * are the Bureau's own records and not restated here beyond that.
 */
import { z } from 'zod';

import { callBureau, type Fetcher } from './bureau-client.ts';

const attentionCountSchema = z.object({ count: z.number().int().nonnegative() });

/**
 * How many problems need attention now. A caller without `bureau.diagnostics:read` is refused with
 * a fault, which the caller of this function lets through so the sidebar can leave its dot out
 * instead of showing a count it could not read.
 */
export async function getAttentionCount(options?: {
  readonly signal?: AbortSignal;
  readonly fetch?: Fetcher;
}): Promise<number> {
  return attentionCountSchema.parse(await callBureau('bureau.health.attention', {}, options)).count;
}

/** A rule of the host's that is firing, as `bureau.health.attention` lists it. */
export interface AttentionAlert {
  /** The metric the rule watches, such as `storage.size`. */
  readonly metric: string;
  /** When the rule last started firing, in epoch milliseconds. */
  readonly at: number;
  /** The metric's value when it was last evaluated, such as the storage size in bytes. */
  readonly currentValue: number;
}

const attentionAlertSchema = z.object({
  kind: z.literal('alert'),
  metric: z.string(),
  at: z.number(),
  currentValue: z.number(),
});

const attentionItemsSchema = z.object({ items: z.array(z.looseObject({ kind: z.string() })) });

/**
 * The rules that are firing now (`bureau.health.attention`), newest first as the Bureau lists
 * them. Every other kind of problem is left out: the bell words only the alerts. A caller without
 * `bureau.diagnostics:read` is refused with a fault, which the caller lets through.
 */
export async function listAttentionAlerts(options?: {
  readonly signal?: AbortSignal;
  readonly fetch?: Fetcher;
}): Promise<readonly AttentionAlert[]> {
  const { items } = attentionItemsSchema.parse(
    await callBureau('bureau.health.attention', {}, options),
  );
  return items.flatMap((item) => {
    const alert = attentionAlertSchema.safeParse(item);
    return alert.success
      ? [{ metric: alert.data.metric, at: alert.data.at, currentValue: alert.data.currentValue }]
      : [];
  });
}

const attentionMissedRunsSchema = z.object({
  kind: z.literal('missed-runs'),
  scheduleId: z.string(),
  count: z.number().int(),
  since: z.number(),
});

/** What the schedule rows need from the attention list: who missed runs, and whether a model can answer. */
export interface ScheduleAttention {
  /** The schedules that missed runs in the last seven days and have not fired since, by schedule id. */
  readonly missedRuns: ReadonlyMap<
    string,
    {
      /** How many occurrences it missed in the window. */
      readonly count: number;
      /** The first missed occurrence in the window, in epoch milliseconds. */
      readonly since: number;
    }
  >;
  /** Whether no model provider is connected, so a schedule that runs a model agent will not start. */
  readonly noProvider: boolean;
}

/**
 * What the schedule rows read of `bureau.health.attention`: the schedules that missed runs, and
 * whether no model provider is connected. A caller without `bureau.diagnostics:read` is refused
 * with a fault, which the caller lets through so the rows can fall back to what the engine says.
 */
export async function readScheduleAttention(options?: {
  readonly signal?: AbortSignal;
  readonly fetch?: Fetcher;
}): Promise<ScheduleAttention> {
  const { items } = attentionItemsSchema.parse(
    await callBureau('bureau.health.attention', {}, options),
  );
  const missedRuns = new Map<string, { count: number; since: number }>();
  let noProvider = false;
  for (const item of items) {
    if (item.kind === 'no-provider') noProvider = true;
    const missed = attentionMissedRunsSchema.safeParse(item);
    if (missed.success) {
      missedRuns.set(missed.data.scheduleId, {
        count: missed.data.count,
        since: missed.data.since,
      });
    }
  }
  return { missedRuns, noProvider };
}

/** The check a problem counts under, in the order the Bureau lists the checks. */
export const ATTENTION_AREAS = [
  'storage',
  'schedules',
  'providers',
  'hooks',
  'plugins',
  'workers',
  'runs',
] as const;

/** One of {@link ATTENTION_AREAS}. */
export type AttentionArea = (typeof ATTENTION_AREAS)[number];

const area = z.enum(ATTENTION_AREAS);

const attentionItemSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('alert'),
    area,
    at: z.number(),
    metric: z.string(),
    currentValue: z.number(),
    threshold: z.number(),
  }),
  z.object({
    kind: z.literal('missed-runs'),
    area,
    at: z.number(),
    scheduleId: z.string(),
    scheduleName: z.string().nullable(),
    count: z.number().int(),
    since: z.number(),
    occurrences: z.array(z.object({ occurrence: z.number(), count: z.number().int() })),
  }),
  z.object({
    kind: z.literal('hook-failed'),
    area,
    at: z.number(),
    hookId: z.string(),
    hookName: z.string().nullable(),
    gaveUp: z.boolean(),
    status: z.number().int().nullable(),
    host: z.string().nullable(),
    attempts: z.number().int(),
    error: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('plugin-not-loaded'),
    area,
    at: z.number().nullable(),
    plugin: z.string(),
    problems: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('no-provider'),
    area,
    at: z.number().nullable(),
    provider: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('worker-disconnected'),
    area,
    at: z.number(),
    workerId: z.string(),
    workerName: z.string().nullable(),
    queue: z.string(),
    waiting: z.number().int().nonnegative(),
    failedForGood: z.number().int().nonnegative(),
  }),
]);

/** One problem that needs attention, as `bureau.health.attention` lists it. */
export type AttentionItem = z.infer<typeof attentionItemSchema>;

/** What `bureau.health.attention` answers: the problems, most recent first, and the same problems counted by area. */
export interface Attention {
  /** Every problem, most recent first; one with no known time first. */
  readonly items: readonly AttentionItem[];
  /** The same items counted by area; only an area with a problem is listed. */
  readonly checks: readonly { readonly area: AttentionArea; readonly count: number }[];
}

const attentionSchema = z.object({
  items: z.array(z.looseObject({ kind: z.string() })),
  checks: z.array(z.object({ area, count: z.number().int().positive() })),
});

/**
 * Everything on the attention list, in the order the Bureau gives it, and the checks that count it
 * by area. An item of a kind this build does not know is left out of `items`. A caller without
 * `bureau.diagnostics:read` is refused with a fault, which the caller lets through.
 */
export async function readAttention(options?: {
  readonly signal?: AbortSignal;
  readonly fetch?: Fetcher;
}): Promise<Attention> {
  const parsed = attentionSchema.parse(await callBureau('bureau.health.attention', {}, options));
  return {
    items: parsed.items.flatMap((item) => {
      const known = attentionItemSchema.safeParse(item);
      return known.success ? [known.data] : [];
    }),
    checks: parsed.checks,
  };
}

/**
 * Every problem that needs attention now, most recent first as the Bureau lists them, for Home's
 * Needs attention card. A kind this build has no schema for is left out, since a row has to say
 * what to look at; the Health dot still counts it. A caller without `bureau.diagnostics:read` is
 * refused with a fault, which the caller lets through so a card can say it could not read them
 * instead of claiming that nothing needs attention.
 */
export async function listAttentionItems(options?: {
  readonly signal?: AbortSignal;
  readonly fetch?: Fetcher;
}): Promise<readonly AttentionItem[]> {
  const { items } = await readAttention(options);
  return items;
}
