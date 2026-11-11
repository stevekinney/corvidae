/**
 * How the Workers page reads a worker (COR-2018, rows 78g to 79i): the status word it carries, the
 * name it is listed under, what line two of its row and the line under its heading say, and how
 * the list is filtered and ordered. Pure functions over the server's `WorkerSummary`, so every
 * state the board draws (connected, draining, disconnected, stopped) is tested without a page.
 */
import { formatTimeOfDay } from '@lostgradient/cinder';

import type { WorkerSummary } from './worker-catalog-types.ts';
import { WORKER_COPY } from './worker-copy.ts';

/** The status words a worker carries, the ones the design scopes to workers. */
export type WorkerStatusWord = 'Connected' | 'Draining' | 'Disconnected' | 'Stopped';

/**
 * How a worker stands, from what the server lists. A worker that went away reads Disconnected,
 * unless it had finished draining, when it reads Stopped: it was told to. A worker that finished
 * draining reads Stopped while it is still connected, since nothing more will reach it.
 */
export function workerStatusOf(worker: WorkerSummary): WorkerStatusWord {
  if (worker.health === 'drained') return 'Stopped';
  if (worker.disconnectedAt !== undefined) return 'Disconnected';
  return worker.health === 'draining' ? 'Draining' : 'Connected';
}

/** Whether the worker still holds a session and takes work. */
export function isConnectedWorker(worker: WorkerSummary): boolean {
  const status = workerStatusOf(worker);
  return status === 'Connected' || status === 'Draining';
}

/** Longer than this, an id is generated rather than chosen, and its end is what tells workers apart. */
const LONG_ID_LENGTH = 32;

/** Whether the worker's id is long enough that the list shows it, shortened, in place of its name. */
export function hasLongId(worker: Pick<WorkerSummary, 'id'>): boolean {
  return worker.id.length > LONG_ID_LENGTH;
}

/** An id as a sentence: `reports-worker` is "Reports worker". */
export function humanizeWorkerId(id: string): string {
  const words = id.replaceAll(/[-_.]+/gu, ' ').trim();
  return words.length === 0 ? id : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** The worker's name as a person reads it: the one it advertised, or its id as a sentence. */
export function workerName(worker: Pick<WorkerSummary, 'id' | 'name'>): string {
  return worker.name ?? humanizeWorkerId(worker.id);
}

/**
 * What a row is titled: the worker's name, or, when its id is long, the id cut from the middle,
 * because the end of a generated id is what tells two workers apart. The id is whole here: the row
 * cuts it from the middle once, at its own width (`Text truncate="middle"`).
 */
export function workerRowTitle(worker: WorkerSummary): string {
  return hasLongId(worker) ? worker.id : workerName(worker);
}

/** Line two of a worker's row. */
export function workerRowMeta(worker: WorkerSummary): string {
  const copy = WORKER_COPY.list.meta;
  switch (workerStatusOf(worker)) {
    case 'Disconnected':
      return copy.disconnected(worker.queue);
    case 'Draining':
      return copy.draining(worker.inFlight);
    case 'Stopped':
      return copy.stopped(worker.drainFinishedTasks ?? 0);
    default:
      return copy.connected(worker.queue, worker.inFlight);
  }
}

/** The moment at the end of line one of a row: when the worker was last heard from, or finished draining. */
export function workerRowTime(worker: WorkerSummary): number {
  return worker.health === 'drained' && worker.drainedAt !== undefined
    ? worker.drainedAt
    : worker.lastHeartbeatAt;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function count(value: number, unit: string): string {
  return `${String(value)} ${unit}${value === 1 ? '' : 's'}`;
}

/**
 * How long ago a worker was last heard from, in words: "just now", "40 seconds ago", "a minute
 * ago", "an hour ago", "3 hours ago", "2 days ago".
 */
export function heardAgoPhrase(ageMs: number): string {
  if (ageMs < 10_000) return 'just now';
  if (ageMs < MINUTE) return `${count(Math.floor(ageMs / 1000), 'second')} ago`;
  if (ageMs < HOUR) {
    const minutes = Math.floor(ageMs / MINUTE);
    return minutes === 1 ? 'a minute ago' : `${count(minutes, 'minute')} ago`;
  }
  if (ageMs < DAY) {
    const hours = Math.floor(ageMs / HOUR);
    return hours === 1 ? 'an hour ago' : `${count(hours, 'hour')} ago`;
  }
  const days = Math.floor(ageMs / DAY);
  return days === 1 ? 'a day ago' : `${count(days, 'day')} ago`;
}

/**
 * The words after "Last heard from": "just now" for a worker that answered a moment ago, and "an
 * hour ago, at 9:41 AM" once it has been a minute, since the clock is what an operator looks for.
 */
export function lastHeardPhrase(lastHeardAt: number, now: number): string {
  const age = Math.max(0, now - lastHeardAt);
  const ago = heardAgoPhrase(age);
  return age < MINUTE ? ago : `${ago}, at ${formatTimeOfDay(lastHeardAt)}`;
}

/** The sentence after the status word in the open worker's header. */
export function workerStatusLine(worker: WorkerSummary, now: number): string {
  const copy = WORKER_COPY.detail.statusLine;
  switch (workerStatusOf(worker)) {
    case 'Draining':
      return copy.draining(worker.inFlight);
    case 'Stopped':
      return copy.stopped(worker.drainFinishedTasks ?? 0);
    default:
      return copy.lastHeard(lastHeardPhrase(worker.lastHeartbeatAt, now));
  }
}

/** Whether `worker` matches what was typed in the filter: its name, its id, or its queue. */
export function matchesWorkerFilter(worker: WorkerSummary, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (needle.length === 0) return true;
  return [workerName(worker), worker.id, worker.queue].some((field) =>
    field.toLowerCase().includes(needle),
  );
}

const STATUS_ORDER: Readonly<Record<WorkerStatusWord, number>> = {
  Disconnected: 0,
  Connected: 1,
  Draining: 1,
  Stopped: 2,
};

/**
 * The list's order: a worker that went away first, since it is the one to look at, then the
 * workers that take work, then the ones that stopped; by name within each.
 */
export function orderWorkers(workers: readonly WorkerSummary[]): WorkerSummary[] {
  return workers.toSorted(
    (left, right) =>
      STATUS_ORDER[workerStatusOf(left)] - STATUS_ORDER[workerStatusOf(right)] ||
      workerName(left).localeCompare(workerName(right), 'en', { numeric: true }) ||
      left.id.localeCompare(right.id),
  );
}

/**
 * Who takes a drained worker's new tasks: the name of the one other connected worker on its queue
 * that still takes work, `null` when none does, and "the other {queue} workers" when several do.
 */
export function drainSuccessor(
  workers: readonly WorkerSummary[],
  worker: WorkerSummary,
): string | null {
  const others = workers.filter(
    (candidate) =>
      candidate.id !== worker.id &&
      candidate.queue === worker.queue &&
      workerStatusOf(candidate) === 'Connected',
  );
  if (others.length === 0) return null;
  const [only] = others;
  return others.length === 1 && only !== undefined
    ? workerName(only)
    : WORKER_COPY.drain.others(worker.queue);
}

/** Whether nothing else is running the worker's queue: no other worker on it still takes work. */
export function queueHasNoRunner(
  workers: readonly WorkerSummary[],
  worker: WorkerSummary,
): boolean {
  return !workers.some(
    (candidate) =>
      candidate.id !== worker.id &&
      candidate.queue === worker.queue &&
      isConnectedWorker(candidate),
  );
}

/** A workflow type as a person reads it: `release-notes` is "Release notes". */
export function humanizeWorkflowType(workflowType: string): string {
  return humanizeWorkerId(workflowType);
}

/** The version a worker reports: its build, or its runtime when it names no build. */
export function workerVersion(worker: WorkerSummary): string | undefined {
  return worker.buildId ?? worker.runtimeVersion;
}
