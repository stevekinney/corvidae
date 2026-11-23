/**
 * What needs attention (COR-2009): the system problems a person should look at, read at the moment
 * of the call. It is one list, ordered once, most recent first, and the checks are that same list
 * counted by area, so a summary of the checks can never say all is well while the list says
 * otherwise. Reviews that wait on a person are never on it: those are the person's work, not a
 * problem with the system.
 *
 * The Bureau finds these kinds itself:
 *
 * - `alert`: a rule of {@link BureauOptions.alerts} that is firing, since it last fired.
 * - `missed-runs`: a schedule that missed occurrences in the last seven days and has not fired
 *   since, at the time the latest miss was recorded.
 * - `hook-failed`: an enabled hook whose newest delivery failed, either still retrying or given up
 *   (`gaveUp`), at the end of its last attempt.
 * - `plugin-not-loaded`: a plugin the Bureau skipped, at the time the plugins were composed. A
 *   plugin that only waits for a secret (`needs-setup`) is not on the list.
 * - `run-stalled` and `run-looping` (COR-2526): a run that is alive but makes no progress, and a
 *   run whose toolbox reported a loop, each while it lasts.
 * - `run-overspending` (COR-2527): a run that cost more than the `runs.spendThresholdUsd` setting,
 *   while it runs and for seven days after it settles. It is a flag only; the run is never stopped.
 *
 * A host adds what only it can see through {@link BureauOptions.attention}, such as `no-provider`
 * when no model provider is connected, and `worker-disconnected` for a remote worker that stopped
 * answering while work waited for its queue.
 *
 * @module attention-feed
 */

import type {
  AlertMetric,
  AlertStateSnapshot,
  PaginatedResult,
  ScheduleFilter,
  ScheduleSummary,
} from '@lostgradient/weft';

import type { ListedHook } from './hooks/hook-types';
import type { PluginListing } from './plugins/plugin-types';
import type { TaskAttentionRun } from './task-registry';

/** The areas a problem belongs to, in the order the checks list them. */
export const ATTENTION_AREAS = [
  'storage',
  'schedules',
  'providers',
  'hooks',
  'plugins',
  'workers',
  'runs',
] as const;

/** One of {@link ATTENTION_AREAS}: the check a problem counts under. */
export type AttentionArea = (typeof ATTENTION_AREAS)[number];

/** How far back a missed occurrence still needs attention: the seven days the missed-runs count covers. */
export const MISSED_RUNS_ATTENTION_WINDOW_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

/** An alert rule that is firing. */
export interface AlertAttentionItem {
  /** Discriminant. */
  readonly kind: 'alert';
  /** `storage` for a `storage.size` rule, `runs` for the others. */
  readonly area: 'storage' | 'runs';
  /** When the rule last started firing, in epoch milliseconds. */
  readonly at: number;
  /** The metric the rule watches. */
  readonly metric: AlertMetric;
  /** The metric's value when it was last evaluated, such as the storage size in bytes. */
  readonly currentValue: number;
  /** The value at or above which the rule fires. */
  readonly threshold: number;
}

/** A schedule that missed occurrences and has not fired since. */
export interface MissedRunsAttentionItem {
  /** Discriminant. */
  readonly kind: 'missed-runs';
  /** Always `schedules`. */
  readonly area: 'schedules';
  /** When the latest miss was recorded, in epoch milliseconds. */
  readonly at: number;
  /** The schedule. */
  readonly scheduleId: string;
  /** The schedule's description, or `null` when it has none. */
  readonly scheduleName: string | null;
  /** How many occurrences it missed in the window. */
  readonly count: number;
  /** The first missed occurrence in the window, in epoch milliseconds. */
  readonly since: number;
  /** Each recorded miss in the window, oldest first: when it was due, and how many fires it stands for. */
  readonly occurrences: readonly { readonly occurrence: number; readonly count: number }[];
}

/** An enabled hook whose newest delivery failed. */
export interface HookAttentionItem {
  /** Discriminant. */
  readonly kind: 'hook-failed';
  /** Always `hooks`. */
  readonly area: 'hooks';
  /** When its last attempt ended (or began, while no end is recorded), in epoch milliseconds. */
  readonly at: number;
  /** The hook. */
  readonly hookId: string;
  /** The hook's name, or `null` when it has none. */
  readonly hookName: string | null;
  /**
   * `true` once the delivery stopped for good (every attempt failed, or a failure a retry cannot
   * change); `false` while it is still retrying.
   */
  readonly gaveUp: boolean;
  /** The HTTP status the receiver answered on the last attempt, or `null` when none answered. */
  readonly status: number | null;
  /** The host the webhook posts to, or `null` for a hook that is not a webhook. */
  readonly host: string | null;
  /** How many attempts the delivery has made. */
  readonly attempts: number;
  /** Why the last attempt failed when no receiver answered, or `null`. */
  readonly error: string | null;
}

/** A plugin that did not load. */
export interface PluginAttentionItem {
  /** Discriminant. */
  readonly kind: 'plugin-not-loaded';
  /** Always `plugins`. */
  readonly area: 'plugins';
  /** When loading it was attempted, in epoch milliseconds, or `null` when that is not known. */
  readonly at: number | null;
  /** The plugin's name. */
  readonly plugin: string;
  /** The codes of the problems that kept it from loading. */
  readonly problems: readonly string[];
}

/** No model provider is connected, so no agent that needs a model can answer. */
export interface ProviderAttentionItem {
  /** Discriminant. */
  readonly kind: 'no-provider';
  /** Always `providers`. */
  readonly area: 'providers';
  /** When the last provider was removed, in epoch milliseconds, or `null` when none ever was. */
  readonly at: number | null;
  /** The provider removed last, such as `anthropic`, or `null` when none ever was. */
  readonly provider: string | null;
}

/**
 * A remote worker that stopped answering, so the queue it served has nobody running it. Only a
 * host that keeps a record of the workers it has seen can report it, through
 * {@link BureauOptions.attention}: the Bureau's own engine holds no memory of a worker once it is
 * gone.
 */
export interface WorkerAttentionItem {
  /** Discriminant. */
  readonly kind: 'worker-disconnected';
  /** Always `workers`. */
  readonly area: 'workers';
  /** When the worker was last heard from, in epoch milliseconds. */
  readonly at: number;
  /** The worker's identifier, such as `reports-worker`. */
  readonly workerId: string;
  /** The worker's name as a person reads it (`Reports worker`), or `null` when it has none. */
  readonly workerName: string | null;
  /** The task queue the worker served. */
  readonly queue: string;
  /** How many tasks wait on that queue. */
  readonly waiting: number;
  /** How many tasks on that queue failed for good. */
  readonly failedForGood: number;
}

/** A run that is alive but making no progress outside a declared wait (COR-2526), while it lasts. */
export interface RunStalledAttentionItem {
  /** Discriminant. */
  readonly kind: 'run-stalled';
  /** Always `runs`. */
  readonly area: 'runs';
  /** When the Bureau saw the run stall, in epoch milliseconds. */
  readonly at: number;
  /** The run. */
  readonly runId: string;
  /** The agent the run is of, or `null` when it has none. */
  readonly agentName: string | null;
}

/** A run whose toolbox reported a loop (COR-2526), until the run settles. */
export interface RunLoopingAttentionItem {
  /** Discriminant. */
  readonly kind: 'run-looping';
  /** Always `runs`. */
  readonly area: 'runs';
  /** When the Bureau recorded the first loop report, in epoch milliseconds. */
  readonly at: number;
  /** The run. */
  readonly runId: string;
  /** The agent the run is of, or `null` when it has none. */
  readonly agentName: string | null;
}

/**
 * A run that cost more than the workspace's spend threshold (COR-2527), while it runs and for seven
 * days after it settles. The run is never stopped by it.
 */
export interface RunOverspendingAttentionItem {
  /** Discriminant. */
  readonly kind: 'run-overspending';
  /** Always `runs`. */
  readonly area: 'runs';
  /** When a step found the run over the threshold, in epoch milliseconds. */
  readonly at: number;
  /** The run. */
  readonly runId: string;
  /** The agent the run is of, or `null` when it has none. */
  readonly agentName: string | null;
  /** What the run has cost so far, or in total once it settled, in US dollars; `null` when not known. */
  readonly costUsd: number | null;
  /** The threshold in force when the step found the run over, in US dollars. */
  readonly thresholdUsd: number;
  /** When the run settled, in epoch milliseconds, or `null` while it runs. */
  readonly settledAt: number | null;
}

/** One problem that needs attention. */
export type BureauAttentionItem =
  | AlertAttentionItem
  | MissedRunsAttentionItem
  | HookAttentionItem
  | PluginAttentionItem
  | ProviderAttentionItem
  | WorkerAttentionItem
  | RunStalledAttentionItem
  | RunLoopingAttentionItem
  | RunOverspendingAttentionItem;

/** How many problems one area has; only areas with at least one are listed. */
export interface AttentionCheck {
  /** The area. */
  readonly area: AttentionArea;
  /** How many items of the list belong to it. */
  readonly count: number;
}

/** What needs attention, as {@link Bureau.attention} answers it. */
export interface BureauAttention {
  /** Every problem, most recent first; one whose time is not known comes first. */
  readonly items: readonly BureauAttentionItem[];
  /** `items.length`. */
  readonly count: number;
  /** The same items counted by area, in {@link ATTENTION_AREAS} order. */
  readonly checks: readonly AttentionCheck[];
}

/** What {@link readAttention} reads. Every reader may be absent when the Bureau has no such part. */
export interface AttentionSources {
  /** The current time, in epoch milliseconds. */
  readonly now: () => number;
  /** The alert rules that are firing now. */
  readonly activeAlerts?: () => readonly AlertStateSnapshot[];
  /** Every schedule, or `undefined` when there is no durable engine. */
  readonly schedules?: () => Promise<readonly ScheduleSummary[] | undefined>;
  /** A schedule's recorded misses, newest first, or `null`/`undefined` when it has none to read. */
  readonly missed?: (scheduleId: string) => Promise<
    | readonly {
        readonly occurrence: number;
        readonly count: number;
        readonly recordedAt: number;
      }[]
    | null
    | undefined
  >;
  /** Every hook with its newest delivery. */
  readonly hooks?: () => Promise<readonly ListedHook[]>;
  /** Every plugin the Bureau knows. */
  readonly plugins?: () => Promise<readonly PluginListing[]>;
  /** When the plugins were composed, in epoch milliseconds. */
  readonly pluginsComposedAt?: number;
  /** Every task that asks for attention now: stalled, looping or over the spend threshold. */
  readonly runs?: () => Promise<readonly TaskAttentionRun[]>;
  /** What the host reports that the Bureau cannot see. */
  readonly contributed?: () =>
    Promise<readonly BureauAttentionItem[]> | readonly BureauAttentionItem[];
}

function alertItems(alerts: readonly AlertStateSnapshot[]): BureauAttentionItem[] {
  return alerts.flatMap((alert) =>
    alert.status === 'firing' && alert.lastFiredAt !== undefined
      ? [
          {
            kind: 'alert' as const,
            area: alert.rule.metric === 'storage.size' ? ('storage' as const) : ('runs' as const),
            at: alert.lastFiredAt,
            metric: alert.rule.metric,
            currentValue: alert.currentValue,
            threshold: alert.rule.threshold,
          },
        ]
      : [],
  );
}

async function missedRunItems(
  sources: AttentionSources,
  now: number,
): Promise<BureauAttentionItem[]> {
  if (sources.schedules === undefined || sources.missed === undefined) return [];
  const schedules = (await sources.schedules()) ?? [];
  const windowStart = now - MISSED_RUNS_ATTENTION_WINDOW_MILLISECONDS;
  const items: BureauAttentionItem[] = [];
  for (const schedule of schedules) {
    if (schedule.missedFireCount === 0) continue;
    const rows = (await sources.missed(schedule.id)) ?? [];
    // A miss is still news while the schedule has not fired after it and it falls in the window.
    const lastFireAt = schedule.lastFireAt ?? Number.NEGATIVE_INFINITY;
    const open = rows
      .filter((row) => row.occurrence >= windowStart && row.occurrence > lastFireAt)
      .toSorted((left, right) => left.occurrence - right.occurrence);
    const first = open[0];
    if (first === undefined) continue;
    items.push({
      kind: 'missed-runs',
      area: 'schedules',
      at: Math.max(...open.map((row) => row.recordedAt)),
      scheduleId: schedule.id,
      scheduleName: schedule.description ?? null,
      count: open.reduce((total, row) => total + row.count, 0),
      since: first.occurrence,
      occurrences: open.map((row) => ({ occurrence: row.occurrence, count: row.count })),
    });
  }
  return items;
}

const RETRYING_FAILURES = new Set(['response', 'network-error', 'interrupted', 'refused', 'error']);

function webhookHost(hook: ListedHook): string | null {
  if (hook.action.type !== 'webhook') return null;
  try {
    return new URL(hook.action.url).host;
  } catch {
    return null;
  }
}

function hookItem(hook: ListedHook): BureauAttentionItem | undefined {
  const delivery = hook.lastDelivery;
  if (!hook.enabled || delivery === null) return undefined;
  const attempt = delivery.lastAttempt;
  const gaveUp =
    delivery.status === 'exhausted' ||
    delivery.status === 'failed' ||
    delivery.status === 'failed-secret';
  const retrying =
    delivery.status === 'pending' &&
    attempt !== undefined &&
    RETRYING_FAILURES.has(attempt.outcome) &&
    // An answer in the 2xx range is a delivery, whatever the record still says.
    !(attempt.outcome === 'response' && attempt.status !== undefined && attempt.status < 300);
  if (!gaveUp && !retrying) return undefined;
  return {
    kind: 'hook-failed',
    area: 'hooks',
    at: attempt?.finishedAt ?? attempt?.startedAt ?? delivery.updatedAt,
    hookId: hook.id,
    hookName: hook.name ?? null,
    gaveUp,
    status: attempt?.status ?? null,
    host: webhookHost(hook),
    attempts: attempt?.number ?? 0,
    error: attempt?.status === undefined ? (attempt?.error ?? null) : null,
  };
}

function pluginItems(
  plugins: readonly PluginListing[],
  composedAt: number | undefined,
): BureauAttentionItem[] {
  return plugins.flatMap((plugin) =>
    plugin.status === 'skipped'
      ? [
          {
            kind: 'plugin-not-loaded' as const,
            area: 'plugins' as const,
            at: composedAt ?? null,
            plugin: plugin.descriptor.name,
            problems: plugin.problems.map((problem) => problem.code),
          },
        ]
      : [],
  );
}

/** A time the registry stored as ISO 8601, in epoch milliseconds; `fallback` when it does not parse. */
function epochOf(instant: string | null, fallback: number): number {
  const parsed = instant === null ? Number.NaN : Date.parse(instant);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * The runs that ask for attention (COR-2526, COR-2527): a stalled run and a looping run while they
 * are one, and an overspending run while it runs and for seven days after it settled, the window a
 * schedule's missed runs use. A run that is over the threshold and still stalled is listed once for
 * each reason, each naming the run.
 */
function runItems(runs: readonly TaskAttentionRun[], now: number): BureauAttentionItem[] {
  const items: BureauAttentionItem[] = [];
  for (const run of runs) {
    if (run.attention.includes('stalled')) {
      items.push({
        kind: 'run-stalled',
        area: 'runs',
        at: epochOf(run.stalledSince, now),
        runId: run.taskId,
        agentName: run.agentName,
      });
    }
    if (run.attention.includes('looping')) {
      items.push({
        kind: 'run-looping',
        area: 'runs',
        at: epochOf(run.loopingSince, now),
        runId: run.taskId,
        agentName: run.agentName,
      });
    }
    if (run.attention.includes('overspending') && run.overspending !== null) {
      const settledAt = run.settledAt === null ? null : epochOf(run.settledAt, now);
      if (settledAt !== null && settledAt < now - MISSED_RUNS_ATTENTION_WINDOW_MILLISECONDS) {
        continue;
      }
      items.push({
        kind: 'run-overspending',
        area: 'runs',
        at: epochOf(run.overspending.since, now),
        runId: run.taskId,
        agentName: run.agentName,
        costUsd: run.costUsd,
        thresholdUsd: run.overspending.thresholdUsd,
        settledAt,
      });
    }
  }
  return items;
}

/** Most recent first; an item whose time is not known comes first, then by area order. */
function compareItems(left: BureauAttentionItem, right: BureauAttentionItem): number {
  const leftAt = left.at ?? Number.POSITIVE_INFINITY;
  const rightAt = right.at ?? Number.POSITIVE_INFINITY;
  if (leftAt !== rightAt) return rightAt - leftAt;
  return ATTENTION_AREAS.indexOf(left.area) - ATTENTION_AREAS.indexOf(right.area);
}

/** The checks: the same items counted by area, listing only the areas that have any. */
export function attentionChecksOf(items: readonly BureauAttentionItem[]): AttentionCheck[] {
  return ATTENTION_AREAS.flatMap((area) => {
    const count = items.filter((item) => item.area === area).length;
    return count === 0 ? [] : [{ area, count }];
  });
}

/** Reads what needs attention now from `sources`. A source that fails rejects the whole read. */
export async function readAttention(sources: AttentionSources): Promise<BureauAttention> {
  const now = sources.now();
  const hooks = sources.hooks === undefined ? [] : await sources.hooks();
  const plugins = sources.plugins === undefined ? [] : await sources.plugins();
  const runs = sources.runs === undefined ? [] : await sources.runs();
  const contributed = sources.contributed === undefined ? [] : await sources.contributed();
  const found = [
    ...alertItems(sources.activeAlerts?.() ?? []),
    ...(await missedRunItems(sources, now)),
    ...hooks.flatMap((hook) => hookItem(hook) ?? []),
    ...pluginItems(plugins, sources.pluginsComposedAt),
    ...runItems(runs, now),
  ];
  // A plugin the host also reports is listed once, as the Bureau found it.
  const reportedPlugins = new Set(
    found.flatMap((item) => (item.kind === 'plugin-not-loaded' ? [item.plugin] : [])),
  );
  const items = [
    ...found,
    ...contributed.filter(
      (item) => item.kind !== 'plugin-not-loaded' || !reportedPlugins.has(item.plugin),
    ),
  ].toSorted(compareItems);
  return { items, count: items.length, checks: attentionChecksOf(items) };
}

/** The page size {@link everySchedule} reads schedules in. */
const SCHEDULE_PAGE_SIZE = 100;

/**
 * Every schedule, page by page, or `undefined` when there is no durable engine to hold any. A
 * schedule added between pages may be missed, and one removed may shift the next page; the read is
 * a snapshot of the moment, as the rest of the feed is.
 */
export async function everySchedule(schedules: {
  readonly list: (filter?: ScheduleFilter) => Promise<PaginatedResult<ScheduleSummary> | undefined>;
}): Promise<readonly ScheduleSummary[] | undefined> {
  const all: ScheduleSummary[] = [];
  for (let offset = 0; ; offset += SCHEDULE_PAGE_SIZE) {
    const page = await schedules.list({ limit: SCHEDULE_PAGE_SIZE, offset });
    if (page === undefined) return undefined;
    all.push(...page.items);
    if (page.items.length < SCHEDULE_PAGE_SIZE || all.length >= page.total) return all;
  }
}
