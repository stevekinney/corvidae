/**
 * The Recent activity section of Health: the latest things that happened, as single lines with
 * the time at the right. The lines are run-level and system events only (sweep S48): a server
 * starting, a provider key removed, a run starting or finishing, runs a schedule missed or ran, a
 * chat deleted, and a storage alert that is firing. Engine step noise (`tool.*`, `step.*`, a run's
 * cleanup) is the run's own timeline and is left out.
 *
 * A run is one line, in the state it is in. While it waits on a person it reads "Run started, …,
 * waiting on you" at the time it started; once it is over it reads "Run finished" at the time
 * its last review was decided or the run ended, whichever is later, because a run that paused for
 * an approval ended its first turn long before the person said yes. A run a schedule started is
 * told by the schedule's own line, "Schedule ran". The run the Bureau starts to continue a chat once
 * an approval is decided (COR-2016) is the same request going on, so its finish is the decided run's
 * "Run finished" line, and it adds none of its own.
 *
 * The audit trail does not record that an alert fired, so the one that is firing now comes from
 * what needs attention, at the time it started.
 */
import { runTitle } from '../../app/shell/command-palette-search.ts';
import type { AttentionItem } from '../../lib/bureau-attention.ts';
import type { AuditRecord } from '../../lib/bureau-audit.ts';
import { providerDisplayName } from '../settings/models/format-model.ts';
import { HEALTH_ACTIVITY_COPY as copy } from './health-copy.ts';
import type { WaitKind } from './health-overview-data.ts';
import { activityTime, clockTime } from './health-times.ts';

/** How many lines the section shows. */
export const ACTIVITY_LINE_LIMIT = 9;

/**
 * How soon after a decision a run of the same chat must start to be the run that continues it. The
 * Bureau starts that run as the decision commits, so it is milliseconds; a person's next message
 * comes later.
 */
const CONTINUATION_START_WINDOW_MILLISECONDS = 60_000;

/** One line of Recent activity. */
export interface ActivityLine {
  /** Stable across reads. */
  readonly id: string;
  /** When it happened, in epoch milliseconds. */
  readonly at: number;
  /** What it says. */
  readonly text: string;
  /** The time at the right: "10:45 AM", "Yesterday, 4:12 PM" or "Oct 29". */
  readonly time: string;
}

/** What the lines are worded from besides the records themselves. */
export interface ActivitySources {
  /** The trail's records, newest first. */
  readonly records: readonly AuditRecord[];
  /** What needs attention now, in the Bureau's order. */
  readonly attention: readonly AttentionItem[];
  /** Each chat's title, by session identifier. A chat that is gone has none. */
  readonly chatTitles: ReadonlyMap<string, string | null>;
  /** Each schedule's name, by schedule identifier. */
  readonly scheduleNames: ReadonlyMap<string, string>;
  /** The runs that wait on a person now, and what each waits on. */
  readonly waitingRuns: ReadonlyMap<string, WaitKind>;
  /** The reference time for "Yesterday" and "Today", in epoch milliseconds. */
  readonly now: number;
  /**
   * The tool's own sentence of a run's review, by run ("Refund order 4472"), which names a run that
   * is not the newest of its chat: a chat's title is the start of its latest message, so it names
   * only the latest run, and an earlier run's own message is not recorded.
   */
  readonly runSentences?: ReadonlyMap<string, string>;
}

/**
 * The runs that are not the newest of their chat, which the chat's title does not name. A run with
 * no chat is its own newest.
 */
export function olderRunsOf(records: readonly AuditRecord[]): ReadonlySet<string> {
  const newest = new Map<string, AuditRecord>();
  const starts = records.filter((record) => record.type === 'run.started');
  for (const record of starts) {
    const sessionId = stringOf(record, 'sessionId');
    if (sessionId === undefined) continue;
    const held = newest.get(sessionId);
    if (
      held === undefined ||
      Date.parse(record.timestamp) > Date.parse(held.timestamp) ||
      (record.timestamp === held.timestamp && (record.sequence ?? 0) > (held.sequence ?? 0))
    ) {
      newest.set(sessionId, record);
    }
  }
  const latest = new Set([...newest.values()].map((record) => record.resource));
  return new Set(
    starts
      .filter((record) => stringOf(record, 'sessionId') !== undefined)
      .map((record) => record.resource)
      .filter((run) => !latest.has(run)),
  );
}

/**
 * The runs that continue a chat after a decision on an earlier run of it (COR-2016), each mapped to
 * the run it continues: the first run of the chat to start after the run's last review was decided,
 * and within {@link CONTINUATION_START_WINDOW_MILLISECONDS} of it.
 */
export function continuationsOf(records: readonly AuditRecord[]): ReadonlyMap<string, string> {
  const starts = records
    .filter(
      (record) => record.type === 'run.started' && stringOf(record, 'sessionId') !== undefined,
    )
    .toSorted((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  const decided = new Map<string, number>();
  for (const record of records) {
    if (!record.type.startsWith('review.')) continue;
    const when = Date.parse(record.timestamp);
    decided.set(record.resource, Math.max(decided.get(record.resource) ?? 0, when));
  }
  const continuations = new Map<string, string>();
  for (const start of starts) {
    const decidedAt = decided.get(start.resource);
    if (decidedAt === undefined) continue;
    const sessionId = stringOf(start, 'sessionId');
    const next = starts.find(
      (candidate) =>
        candidate.resource !== start.resource &&
        stringOf(candidate, 'sessionId') === sessionId &&
        Date.parse(candidate.timestamp) >= decidedAt,
    );
    if (
      next !== undefined &&
      Date.parse(next.timestamp) - decidedAt <= CONTINUATION_START_WINDOW_MILLISECONDS
    ) {
      continuations.set(next.resource, start.resource);
    }
  }
  return continuations;
}

/** The records that name a chat or a schedule the lines need to look up, so the loader can ask for exactly those. */
export function lookupsFor(records: readonly AuditRecord[]): {
  readonly sessionIds: readonly string[];
  readonly scheduleIds: readonly string[];
} {
  const sessionIds = new Set<string>();
  const scheduleIds = new Set<string>();
  for (const record of records) {
    const sessionId = record.detail?.['sessionId'];
    if (record.type === 'run.started' && typeof sessionId === 'string') sessionIds.add(sessionId);
    const scheduleId = record.detail?.['scheduleId'];
    if (
      (record.type === 'schedule.missed' || record.type === 'schedule.fired') &&
      typeof scheduleId === 'string'
    ) {
      scheduleIds.add(scheduleId);
    }
  }
  return { sessionIds: [...sessionIds], scheduleIds: [...scheduleIds] };
}

/** The records of a trail that are about a run. */
const RUN_ENDS = new Set(['run.completed', 'run.error', 'run.aborted']);

function stringOf(record: AuditRecord, key: string): string | undefined {
  const value = record.detail?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** The lines of Recent activity, newest first, at most {@link ACTIVITY_LINE_LIMIT}. */
export function activityLines(
  sources: ActivitySources,
  limit: number = ACTIVITY_LINE_LIMIT,
): readonly ActivityLine[] {
  const { records, attention, chatTitles, scheduleNames, waitingRuns, now } = sources;
  const older = olderRunsOf(records);
  const at = (record: AuditRecord): number => Date.parse(record.timestamp);

  // A run's start, its end, when its last review was decided, and whether a schedule started it.
  const started = new Map<string, AuditRecord>();
  const ended = new Map<string, AuditRecord>();
  const decided = new Map<string, number>();
  const fired = new Set<string>();
  // The server runs from its latest start; the starts before it are history in the audit log.
  const latestStart = records.find((record) => record.type === 'host.started');
  for (const record of records) {
    const run = record.resource;
    if (record.type === 'run.started') started.set(run, record);
    else if (RUN_ENDS.has(record.type) && !ended.has(run)) ended.set(run, record);
    else if (record.type === 'schedule.fired') fired.add(run);
    else if (record.type.startsWith('review.')) {
      decided.set(run, Math.max(decided.get(run) ?? 0, at(record)));
    }
  }

  const continuations = continuationsOf(records);
  const titleOf = (asked: string): string => {
    // A continuation is named as the run it continues.
    const run = continuations.get(asked) ?? asked;
    const begin = started.get(run);
    const sessionId = begin === undefined ? undefined : stringOf(begin, 'sessionId');
    const agent = begin === undefined ? undefined : stringOf(begin, 'agentName');
    // An earlier run of a chat is named by its own review, never by the chat's latest message.
    if (older.has(run)) {
      const sentence = sources.runSentences?.get(run);
      return sentence ?? runTitle(undefined, agent);
    }
    const title = sessionId === undefined ? undefined : chatTitles.get(sessionId);
    return runTitle(title === undefined || title === null ? undefined : { title }, agent);
  };

  const lines: ActivityLine[] = [];
  const push = (id: string, when: number, text: string): void => {
    lines.push({ id, at: when, text, time: activityTime(when, now) });
  };

  for (const record of records) {
    const when = at(record);
    const run = record.resource;
    switch (record.type) {
      case 'host.started':
        if (record !== latestStart) break;
        push(
          `${record.type}:${record.timestamp}:${String(record.sequence)}`,
          when,
          copy.serverStarted,
        );
        break;
      case 'provider.disconnected': {
        const provider = stringOf(record, 'provider');
        push(
          `${record.type}:${record.timestamp}`,
          when,
          copy.removedProviderKey(
            provider === undefined ? 'provider' : providerDisplayName(provider),
          ),
        );
        break;
      }
      case 'schedule.missed': {
        const scheduleId = stringOf(record, 'scheduleId');
        const missed = attention.find(
          (item) => item.kind === 'missed-runs' && item.scheduleId === scheduleId,
        );
        const name =
          (scheduleId === undefined ? undefined : scheduleNames.get(scheduleId)) ??
          (missed?.kind === 'missed-runs' ? missed.scheduleName : null) ??
          copy.unnamedSchedule;
        const latest = missed?.kind === 'missed-runs' ? missed.occurrences.at(-1) : undefined;
        push(
          `${record.type}:${record.timestamp}:${scheduleId ?? ''}`,
          when,
          copy.missedRunsNoticed(name, latest === undefined ? null : clockTime(latest.occurrence)),
        );
        break;
      }
      case 'schedule.fired': {
        const scheduleId = stringOf(record, 'scheduleId');
        const name =
          (scheduleId === undefined ? undefined : scheduleNames.get(scheduleId)) ??
          copy.unnamedSchedule;
        push(`${record.type}:${run}`, when, copy.scheduleRan(name));
        break;
      }
      case 'session.deleted': {
        const title = stringOf(record, 'title');
        push(
          `${record.type}:${record.timestamp}:${record.resource}`,
          when,
          title === undefined ? copy.deletedChatUntitled : copy.deletedChat(title),
        );
        break;
      }
      case 'run.started': {
        if (fired.has(run)) break;
        // Over and nobody is waiting: the finished line stands for the run.
        if (ended.has(run) && !waitingRuns.has(run)) break;
        // A question that waits is Reviews' and Home's to say; a run that stopped at an approval
        // is the news here, because it has not done what it was asked to.
        if (waitingRuns.has(run) && waitingRuns.get(run) !== 'approval') break;
        push(`run:${run}`, when, copy.runStarted(titleOf(run), waitingRuns.has(run)));
        break;
      }
      default:
        if (RUN_ENDS.has(record.type) && ended.get(run) === record) {
          if (fired.has(run) || waitingRuns.has(run)) break;
          // The decided run's "Run finished" stands for the continuation that finished it.
          if (record.type === 'run.completed' && continuations.has(run)) break;
          const finished = Math.max(when, decided.get(run) ?? 0);
          const title = titleOf(run);
          push(
            `run:${run}`,
            finished,
            record.type === 'run.completed'
              ? copy.runFinished(title)
              : record.type === 'run.error'
                ? copy.runFailed(title)
                : copy.runStopped(title),
          );
        }
    }
  }

  for (const item of attention) {
    if (item.kind !== 'alert') continue;
    push(
      `alert:${item.metric}`,
      item.at,
      item.metric === 'storage.size' ? copy.storageAlertFiring : copy.alertFiring(item.metric),
    );
  }

  // Newest first; two lines of one moment keep the order the trail gave them.
  return lines.toSorted((left, right) => right.at - left.at).slice(0, limit);
}
