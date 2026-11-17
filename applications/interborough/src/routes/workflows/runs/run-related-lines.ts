/**
 * The related runs of a run a goal or a schedule started, in the Details rail (COR-2424, rows 55h
 * and 55m): the other attempts of the goal, each said as "Attempt 1 of 5 (Check not met)", and, for
 * a schedule's run, whether it was the schedule's last and how many occurrences the schedule has
 * missed since. Pure, so each rule is a table test.
 */
import { RUN_DETAIL_COPY } from '../../../app/copy/runs.ts';
import type { Goal } from '../../../lib/bureau-goals.ts';
import type { BureauSchedule } from '../../../lib/bureau-schedules.ts';

/** One other attempt of a goal, as a line that links to its run's page. */
export type RelatedAttempt = {
  readonly runId: string;
  readonly label: string;
};

/** The goal's other attempts, in the order they were made, each with how its check went. */
export function otherAttempts(goal: Goal, runId: string): RelatedAttempt[] {
  const copy = RUN_DETAIL_COPY.related;
  return goal.attempts
    .filter((attempt) => attempt.runId !== runId && attempt.runId !== '')
    .toSorted((left, right) => left.attemptIndex - right.attemptIndex)
    .map((attempt) => ({
      runId: attempt.runId,
      label: copy.attempt(
        attempt.attemptIndex + 1,
        Math.max(goal.bounds.maximumAttempts, attempt.attemptIndex + 1),
        copy.attemptOutcome[attempt.status],
      ),
    }));
}

/**
 * What the Details rail says of a run a schedule started, by which kind of run it is. A schedule's
 * chat run, which the Bureau has a task for (row 55m), has a Schedule row, no Tags row, and says
 * under Related runs whether it was the schedule's last run. An instance of a workflow file a
 * schedule started (row 55d) says the schedule once, in Started by, keeps its Tags, and says what
 * came from it under Related runs ("No other runs came from this one."), not the schedule's sentence.
 */
export function scheduleRailRules(input: {
  readonly hasTask: boolean;
  readonly scheduled: boolean;
}): {
  readonly scheduleRow: boolean;
  readonly tags: boolean;
  readonly scheduleRelated: boolean;
} {
  const chatRun = input.scheduled && input.hasTask;
  return { scheduleRow: chatRun, tags: !chatRun, scheduleRelated: chatRun };
}

/** How far a run's start may be from the schedule's last fire and still be that fire's run. */
const SAME_FIRE_MILLISECONDS = 60_000;

/**
 * What the Related runs of a schedule's run say: that it was the schedule's last run and how many
 * occurrences the schedule has missed since, or that the schedule has run since. `undefined` when
 * the schedule has not recorded a fire to compare with. `missedSince` is what the Bureau's attention
 * list says of the schedule: how many occurrences it missed and has not fired since, so it is read
 * only for the schedule's last run (the schedule's own `missedFireCount` is a lifetime count, not
 * "since").
 */
export function scheduleRelatedSentence(
  schedule: Pick<BureauSchedule, 'lastFireAt'>,
  startedAt: number,
  missedSince: number | undefined,
): string | undefined {
  const copy = RUN_DETAIL_COPY.related;
  if (schedule.lastFireAt === null) return undefined;
  const last = Date.parse(schedule.lastFireAt);
  if (!Number.isFinite(last)) return undefined;
  if (last - startedAt > SAME_FIRE_MILLISECONDS) return copy.scheduleNotLast;
  if (Math.abs(last - startedAt) > SAME_FIRE_MILLISECONDS) return undefined;
  const missed = missedSince ?? 0;
  return missed > 0
    ? `${copy.scheduleLastRun} ${copy.scheduleMissedSince(missed)}`
    : copy.scheduleLastRun;
}
