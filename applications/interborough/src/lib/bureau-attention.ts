/**
 * The browser's view of what needs attention: `bureau.health.attention`, which lists the system
 * problems that need a person now (an alert rule firing, a schedule that missed runs, a hook whose
 * delivery failed, a plugin that did not load, a worker that stopped answering, no model provider connected). Reviews waiting on a
 * person are never on it: they are Needs you, which the reviews count reads.
 *
 * The sidebar's Health dot reads only how many there are. The notification bell reads the rules
 * that are firing; the Health page reads the items themselves, which are the Bureau's own records.
 */
import { bureauClient, type BureauOutput } from './bureau-api.ts';
import type { Fetcher } from './bureau-client.ts';

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

/**
 * The kinds of run the Bureau lists (a stalled run, a looping run, and a run over the spend
 * threshold) that this build has no row for yet. The Health dot counts them; no row says them.
 */
type RunAttentionKind = 'run-stalled' | 'run-looping' | 'run-overspending';

/** One problem that needs attention and that this build words, as `bureau.health.attention` lists it. */
export type AttentionItem =
  | Exclude<WireAttentionItem, { readonly kind: 'alert' | RunAttentionKind }>
  // The metric is a string: a rule a newer Bureau watches still reaches the bell.
  | (Omit<Extract<WireAttentionItem, { readonly kind: 'alert' }>, 'metric'> & {
      readonly metric: string;
    });

type WireAttentionItem = BureauOutput<'bureau.health.attention'>['items'][number];

/** Any item the Bureau lists, including the kinds this build has no row for. */
type ListedAttentionItem = AttentionItem | Extract<WireAttentionItem, { kind: RunAttentionKind }>;

/** The kinds of item this build words. A Bureau newer than the browser may list one it does not know. */
const KNOWN_ATTENTION_KINDS: ReadonlySet<string> = new Set([
  'alert',
  'missed-runs',
  'hook-failed',
  'plugin-not-loaded',
  'no-provider',
  'worker-disconnected',
]);

/** The items of a kind this build knows: a row has to say what to look at, so any other is left out. */
export function knownAttentionItems(
  items: readonly ListedAttentionItem[],
): readonly AttentionItem[] {
  return items.filter((item): item is AttentionItem => KNOWN_ATTENTION_KINDS.has(item.kind));
}

/**
 * How many problems need attention now. A caller without `bureau.diagnostics:read` is refused with
 * a fault, which the caller of this function lets through so the sidebar can leave its dot out
 * instead of showing a count it could not read.
 */
export async function getAttentionCount(options?: Options): Promise<number> {
  const answer = await bureauClient['bureau.health.attention']({}, options);
  return answer.count;
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

/**
 * The rules that are firing now (`bureau.health.attention`), newest first as the Bureau lists
 * them. Every other kind of problem is left out: the bell words only the alerts. A caller without
 * `bureau.diagnostics:read` is refused with a fault, which the caller lets through.
 */
export async function listAttentionAlerts(options?: Options): Promise<readonly AttentionAlert[]> {
  const { items } = await bureauClient['bureau.health.attention']({}, options);
  return items.flatMap((item) =>
    item.kind === 'alert'
      ? [{ metric: item.metric, at: item.at, currentValue: item.currentValue }]
      : [],
  );
}

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
export async function readScheduleAttention(options?: Options): Promise<ScheduleAttention> {
  const { items } = await bureauClient['bureau.health.attention']({}, options);
  const missedRuns = new Map<string, { count: number; since: number }>();
  let noProvider = false;
  for (const item of items) {
    if (item.kind === 'no-provider') noProvider = true;
    if (item.kind === 'missed-runs') {
      missedRuns.set(item.scheduleId, { count: item.count, since: item.since });
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

/** What `bureau.health.attention` answers: the problems, most recent first, and the same problems counted by area. */
export interface Attention {
  /** Every problem, most recent first; one with no known time first. */
  readonly items: readonly AttentionItem[];
  /** The same items counted by area; only an area with a problem is listed. */
  readonly checks: readonly { readonly area: AttentionArea; readonly count: number }[];
}

/**
 * Everything on the attention list, in the order the Bureau gives it, and the checks that count it
 * by area. An item of a kind this build does not know is left out of `items`. A caller without
 * `bureau.diagnostics:read` is refused with a fault, which the caller lets through.
 */
export async function readAttention(options?: Options): Promise<Attention> {
  const attention = await bureauClient['bureau.health.attention']({}, options);
  return { items: knownAttentionItems(attention.items), checks: attention.checks };
}

/**
 * Every problem that needs attention now, most recent first as the Bureau lists them, for Home's
 * Needs attention card. A kind this build has no wording for is left out, since a row has to say
 * what to look at; the Health dot still counts it. A caller without `bureau.diagnostics:read` is
 * refused with a fault, which the caller lets through so a card can say it could not read them
 * instead of claiming that nothing needs attention.
 */
export async function listAttentionItems(options?: Options): Promise<readonly AttentionItem[]> {
  const { items } = await readAttention(options);
  return items;
}
