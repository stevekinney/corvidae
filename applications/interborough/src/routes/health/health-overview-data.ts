/**
 * What the Health overview's counts and metric cards are worked out from: the engine's runs in the
 * last 24 hours and the runs that wait on a person. A run that waits on a review has started and
 * counts under Needs you, not under Running now, and it is neither done nor failed, so it is told
 * apart by the reviews and not by the engine's status (a run that paused for an approval ended its
 * first turn, and the engine reports it as completed).
 */

import { z } from 'zod';

import { formatBytes } from '../../lib/format/index.ts';
import { HEALTH_COUNTS_COPY, HEALTH_METRICS_COPY } from './health-copy.ts';
import { joinWords } from './health-times.ts';

/** The window the metric cards and "Failed in 24 hours" count over. */
export const OVERVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;

/** One of the four counts: its number, `undefined` while it loads, `null` when it could not be read. */
export interface HealthCount {
  readonly value: number | undefined | null;
  /** The line under the number; ignored while loading. */
  readonly caption: string;
  /** Whether a number above zero is a problem, so it carries the dot. */
  readonly bad: boolean;
}

/** The part of an engine run these figures read. */
export interface RunSummary {
  readonly id: string;
  readonly status: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** What a run waits on: a tool's approval, a question, or a workflow review. */
export type WaitKind = 'approval' | 'question' | 'review';

/** The runs that wait on a person, by run identifier, with what each waits on. */
export function waitingRuns(
  reviews: readonly { readonly runId: string; readonly kind: string }[],
): ReadonlyMap<string, WaitKind> {
  const waiting = new Map<string, WaitKind>();
  for (const review of reviews) {
    const kind: WaitKind =
      review.kind === 'tool-approval'
        ? 'approval'
        : review.kind === 'human-wait'
          ? 'question'
          : 'review';
    // A run that waits on an approval and a question is told by the approval.
    if (waiting.get(review.runId) !== 'approval') waiting.set(review.runId, kind);
  }
  return waiting;
}

const runPageSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      createdAt: z.number(),
      updatedAt: z.number(),
    }),
  ),
});

/** The runs of one page of `weft.workflows.list`, read down to what these figures use. */
export function parseRunPage(page: unknown): RunSummary[] {
  return runPageSchema.parse(page).items;
}

/** How many of `running` the engine is executing now: the ones that wait on a person are not. */
export function runningNow(
  running: readonly RunSummary[],
  waiting: ReadonlyMap<string, WaitKind>,
): number {
  return running.filter((run) => !waiting.has(run.id)).length;
}

/** The runs started in the window, told by how they stand. */
export interface StartedSummary {
  readonly total: number;
  readonly done: number;
  readonly waiting: number;
  /** The runs that failed, are still running, or were canceled, as the words the caption adds. */
  readonly other: readonly string[];
  /** How many runs started in the 24 hours before the window, once that is known. */
  readonly before?: number;
}

/** How the runs started in a window stand now. */
export function startedSummary(
  runs: readonly RunSummary[],
  waiting: ReadonlyMap<string, WaitKind>,
  before?: number,
): StartedSummary {
  let done = 0;
  let waitingCount = 0;
  let failed = 0;
  let running = 0;
  let canceled = 0;
  for (const run of runs) {
    if (waiting.has(run.id)) waitingCount += 1;
    else if (run.status === 'completed') done += 1;
    else if (run.status === 'failed' || run.status === 'timed-out') failed += 1;
    else if (run.status === 'running') running += 1;
    else if (run.status === 'cancelled' || run.status === 'canceled') canceled += 1;
  }
  return {
    total: runs.length,
    done,
    waiting: waitingCount,
    other: [
      ...(failed > 0 ? [`${failed} failed`] : []),
      ...(running > 0 ? [`${running} running`] : []),
      ...(canceled > 0 ? [`${canceled} canceled`] : []),
    ],
    ...(before === undefined ? {} : { before }),
  };
}

/** The median time the finished runs took, and how many there were; `undefined` when none finished. */
export function medianFinish(
  runs: readonly RunSummary[],
  waiting: ReadonlyMap<string, WaitKind>,
): { readonly milliseconds: number; readonly count: number } | undefined {
  const durations = runs
    .filter((run) => run.status === 'completed' && !waiting.has(run.id))
    .map((run) => Math.max(0, run.updatedAt - run.createdAt))
    .toSorted((left, right) => left - right);
  if (durations.length === 0) return undefined;
  const middle = Math.floor(durations.length / 2);
  const milliseconds =
    durations.length % 2 === 1
      ? (durations[middle] ?? 0)
      : ((durations[middle - 1] ?? 0) + (durations[middle] ?? 0)) / 2;
  return { milliseconds, count: durations.length };
}

/** A duration as the card says it: "<1 s", "8 s", "1m 12s", "1h 5m". */
export function finishTime(milliseconds: number): string {
  if (milliseconds < 1_000) return '<1 s';
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The line under "Needs you": which kinds of review wait, as "An approval and a question". */
export function waitingCaption(reviews: readonly { readonly kind: string }[]): string {
  const kinds = HEALTH_COUNTS_COPY.waitingKinds;
  const approvals = reviews.filter((review) => review.kind === 'tool-approval').length;
  const questions = reviews.filter((review) => review.kind === 'human-wait').length;
  const workflow = reviews.length - approvals - questions;
  const parts = [
    approvals === 0
      ? undefined
      : approvals === 1
        ? kinds.approval.one
        : kinds.approval.many(approvals),
    questions === 0
      ? undefined
      : questions === 1
        ? kinds.question.one
        : kinds.question.many(questions),
    workflow === 0 ? undefined : workflow === 1 ? kinds.review.one : kinds.review.many(workflow),
  ].filter((part): part is string => part !== undefined);
  if (parts.length === 0) return HEALTH_COUNTS_COPY.nothingWaiting;
  const [first, ...rest] = parts;
  const lowered = rest.map((part) => `${part.charAt(0).toLowerCase()}${part.slice(1)}`);
  return joinWords([first ?? '', ...lowered]);
}

/**
 * The caption of the Runs started card. It says how the runs stand while any is waiting, failed,
 * running or canceled; when every run simply finished, "14 done" adds nothing to "14", so it says
 * how the day compares with the one before (row 76v) when that is known.
 */
export function startedCaption(summary: StartedSummary): string {
  const untroubled = summary.total > 0 && summary.waiting === 0 && summary.other.length === 0;
  if (untroubled && summary.before !== undefined) {
    return HEALTH_METRICS_COPY.comparedWithDayBefore(summary.total - summary.before);
  }
  return HEALTH_METRICS_COPY.runsCaption(summary.done, summary.waiting, summary.other);
}

const GIBIBYTE = 1024 ** 3;

/**
 * A storage size as the Storage use card and its chart say it: in gigabytes from about 50 MB up
 * ("0.4 GB", which the card keeps in the same unit as the "1.6 GB" the warning names), and in the
 * usual unit below that, where a gigabyte would read "0.0 GB".
 */
export function storageUseSize(bytes: number): string {
  return bytes >= GIBIBYTE / 20 && bytes < GIBIBYTE
    ? `${(bytes / GIBIBYTE).toFixed(1)} GB`
    : formatBytes(bytes);
}
