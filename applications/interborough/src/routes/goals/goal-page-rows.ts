/**
 * How a goal's page (`/goals/:goal`) reads its goal, with no DOM in it: the status word with its
 * qualifier, the attempts as rows (newest first, each with its word and line two), the note that
 * says how the goal ended or what it waits on, the Details panel's facts, and the actions the page
 * offers.
 *
 * Red is the goal's status alone, and only when it gave up or failed: an attempt that missed the
 * check reads "Check not met", which is neutral, and every note is neutral but the one that says
 * an attempt waits on you, which is amber.
 *
 * A goal's view carries neither its prompt nor its validator's feedback (`goals-operations.ts`), so
 * the page says neither: line two names the agent and how long the attempt took, and the check is
 * said from the validator's name.
 */
import type { StatusDotWordLabel } from '@lostgradient/cinder';

import { GOALS_COPY } from '../../app/copy/goals.ts';
import { goalHasEnded, type Goal } from '../../lib/bureau-goals.ts';
import type { BureauReview } from '../../lib/bureau-reviews.ts';
import type { TaskView } from '../../lib/bureau-tasks.ts';
import { clockTime } from '../../lib/format/clock.ts';
import { durationWords, waitedWords } from '../workflows/runs/run-rows.ts';
import { checkText, goalListWord } from './goal-rows.ts';

const copy = GOALS_COPY.detail;

/** One attempt of a goal, as the goal's view lists it. */
export type GoalAttempt = Goal['attempts'][number];

/** What an attempt that has not ended waits on: the review its run is parked on. */
export type AttemptWait = {
  /** An approval of a tool call, or a question for the person. */
  readonly kind: 'approval' | 'question';
  /** The tool the approval is for, in words ("Issue refund"), once the review has been read. */
  readonly tool: string | undefined;
  /** Epoch milliseconds the wait began, once the review has been read. */
  readonly since: number | undefined;
  /** The review's key in Reviews (`bureau:<id>`), which the address opens it by. */
  readonly reviewKey: string;
};

/**
 * What the attempt's run waits on, from the run (`bureau.tasks.get`) and the review it is parked on
 * (`bureau.reviews.get`), or `undefined` for a run that waits on nobody. The review is optional:
 * until it is read the wait is said without the tool's name and without how long it has waited.
 */
export function attemptWaitOf(
  task: Pick<TaskView, 'status' | 'openWaits'> | undefined,
  review: BureauReview | undefined,
): AttemptWait | undefined {
  if (task === undefined || task.status !== 'input-required') return undefined;
  const open = task.openWaits[0];
  if (open === undefined) return undefined;
  const read = review !== undefined && review.id === open.reviewId ? review : undefined;
  return {
    kind: open.kind === 'tool-approval' ? 'approval' : 'question',
    tool:
      read !== undefined && read.kind === 'tool-approval'
        ? checkText(read.approval.toolName)
        : undefined,
    since: read?.requestedAt,
    reviewKey: `bureau:${open.reviewId}`,
  };
}

/**
 * The goal's status word on its page. An ended goal reads as it does in the list (Done, Gave up,
 * Stopped, Failed). One that has not ended is Running, with a qualifier for what it is doing: being
 * stopped, checking an attempt's result, or about to make its next attempt (sweep S73). A goal whose
 * attempt waits on you still reads Running: the attempt says what it waits for (row 69a).
 */
export function goalPageWord(
  goal: Pick<Goal, 'status' | 'cancellation' | 'usage' | 'bounds'>,
): StatusDotWordLabel {
  if (goalHasEnded(goal.status) || goal.cancellation !== null) return goalListWord(goal);
  if (goal.status === 'evaluating') return `Running, ${copy.checkingQualifier}`;
  if (goal.status === 'retrying') {
    const next = Math.min(goal.usage.attempts + 1, goal.bounds.maximumAttempts);
    return `Running, ${copy.retryingQualifier(next, goal.bounds.maximumAttempts)}`;
  }
  return 'Running';
}

/**
 * An attempt's status word: Running (with "checking the result" while its result is checked),
 * Waiting on you while its run is parked on a review, Done when it met the check, "Check not met"
 * (neutral) when it did not, and Canceled when the goal was stopped while it ran.
 */
export function attemptWord(
  attempt: Pick<GoalAttempt, 'status'>,
  wait: AttemptWait | undefined,
): StatusDotWordLabel {
  switch (attempt.status) {
    case 'running':
      return wait === undefined ? 'Running' : 'Waiting on you';
    case 'evaluating':
      return `Running, ${copy.checkingQualifier}`;
    case 'passed':
      return 'Done';
    case 'failed':
      return 'Check not met';
    case 'aborted':
      return 'Canceled';
  }
}

/** Epoch milliseconds of a Bureau timestamp, or `null` when it does not read as one. */
function instant(timestamp: string | null): number | null {
  if (timestamp === null) return null;
  const at = Date.parse(timestamp);
  return Number.isNaN(at) ? null : at;
}

/** The time between two Bureau timestamps in the words of line two, or `undefined` when either is unreadable. */
function between(start: string, end: string | null): string | undefined {
  const from = instant(start);
  const to = instant(end);
  return from === null || to === null ? undefined : durationWords(to - from);
}

/** What line two needs besides the attempt: the agent's name, the zone, the clock, and the wait. */
export type AttemptLineContext = {
  /** The name the goal's agent goes by on screen. */
  readonly agent: string;
  /** The zone times are read in. */
  readonly zone: string;
  /** Epoch milliseconds now, for how long a wait or a running attempt has gone on. */
  readonly now: number;
  /** What the attempt waits on, when it does. */
  readonly wait: AttemptWait | undefined;
  /**
   * When the agent's part of an attempt whose result is being checked ended. The Bureau records an
   * attempt's `completedAt` only once its check has answered, and the move to checking is the
   * goal's last write, so this is the goal's `updatedAt` while it is `evaluating`.
   */
  readonly agentEndedAt?: string | undefined;
};

/** Why the agent stopped, in words, for the finish reasons that are not the agent's normal end. */
function agentStopWords(finishReason: string | null): string | undefined {
  if (finishReason === null) return undefined;
  const reasons: Readonly<Record<string, string>> = copy.agentStopReasons;
  return Object.hasOwn(reasons, finishReason) ? reasons[finishReason] : undefined;
}

/**
 * Line two of an attempt's row, agent first: "Assistant, took 8 s"; "Tool runner, canceled at
 * 10:08 AM after 1 min 12 s"; "Tool runner, Agent took 1 min 12 s" while its result is checked
 * (with "Agent stopped: …" when the agent did not end its own way); "Tool runner, Issue refund is
 * waiting for your approval, 4 min" while it waits on you.
 */
export function attemptLineTwo(attempt: GoalAttempt, context: AttemptLineContext): string {
  const parts: string[] = [context.agent];
  const took = between(attempt.startedAt, attempt.completedAt);
  switch (attempt.status) {
    case 'running': {
      const { wait } = context;
      if (wait !== undefined) {
        parts.push(
          wait.kind === 'approval'
            ? copy.line.waitingApproval(wait.tool ?? copy.line.aTool)
            : copy.line.waitingQuestion,
        );
        if (wait.since !== undefined) parts.push(waitedWords(context.now - wait.since));
        break;
      }
      const started = instant(attempt.startedAt);
      if (started !== null) parts.push(copy.line.runningFor(durationWords(context.now - started)));
      break;
    }
    case 'evaluating': {
      const agentTook = took ?? between(attempt.startedAt, context.agentEndedAt ?? null);
      if (agentTook !== undefined) parts.push(copy.line.agentTook(agentTook));
      const stopped = agentStopWords(attempt.finishReason);
      if (stopped !== undefined) parts.push(copy.line.agentStopped(stopped));
      break;
    }
    case 'aborted': {
      const ended = instant(attempt.completedAt);
      parts.push(
        ended === null || took === undefined
          ? copy.line.canceled
          : copy.line.canceledAt(clockTime(ended, context.zone), took),
      );
      break;
    }
    case 'passed':
    case 'failed':
      if (took !== undefined) parts.push(copy.line.took(took));
      break;
  }
  return parts.join(', ');
}

/** One attempt as a row of the goal's Attempts list. */
export type AttemptRow = {
  readonly id: string;
  /** The run the attempt is, which the row links to. */
  readonly runId: string;
  /** The attempt's number, counting from 1. */
  readonly number: number;
  /** "Attempt 3". */
  readonly title: string;
  readonly word: StatusDotWordLabel;
  /** Epoch milliseconds the attempt began, or `null` when the Bureau's time is unreadable. */
  readonly startedAt: number | null;
  readonly lineTwo: string;
};

/**
 * The goal's attempts as rows, newest first. `liveWait` is what the attempt that is still running
 * waits on, when it does; only that attempt's run is read for it.
 */
export function attemptRows(
  goal: Pick<Goal, 'attempts' | 'status' | 'updatedAt'>,
  context: Omit<AttemptLineContext, 'wait'> & { readonly liveWait: AttemptWait | undefined },
): AttemptRow[] {
  return goal.attempts
    .toSorted((left, right) => right.attemptIndex - left.attemptIndex)
    .map((attempt) => {
      const wait = attempt.status === 'running' ? context.liveWait : undefined;
      const checking = attempt.status === 'evaluating' && goal.status === 'evaluating';
      const agentEndedAt = checking ? goal.updatedAt : undefined;
      const number = attempt.attemptIndex + 1;
      return {
        id: attempt.attemptId,
        runId: attempt.runId,
        number,
        title: copy.attemptTitle(number),
        word: attemptWord(attempt, wait),
        startedAt: instant(attempt.startedAt),
        lineTwo: attemptLineTwo(attempt, { ...context, wait, agentEndedAt }),
      };
    });
}

/**
 * The attempt whose run is still going, which is the one the page reads the run of to learn
 * whether it waits on you. A goal runs one attempt at a time, so it is the newest that is running.
 */
export function liveAttempt(goal: Pick<Goal, 'attempts'>): GoalAttempt | undefined {
  return goal.attempts
    .filter((attempt) => attempt.status === 'running')
    .toSorted((left, right) => right.attemptIndex - left.attemptIndex)[0];
}

/** The newest attempt of the goal, or `undefined` for one that has made none. */
function newestAttempt(goal: Pick<Goal, 'attempts'>): GoalAttempt | undefined {
  return goal.attempts.toSorted((left, right) => right.attemptIndex - left.attemptIndex)[0];
}

/** A day as a line of details says it: "Fri, Oct 30". */
export function shortDay(at: number, zone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: zone,
  }).format(at);
}

/** "Fri, Oct 30 at 10:08 AM", the moment a note says something happened. */
function noteWhen(at: number, zone: string): string {
  return copy.when(shortDay(at, zone), clockTime(at, zone));
}

/** Where a note's link goes: an attempt's run, or the review in Reviews. */
export type GoalNoteTarget =
  | { readonly kind: 'run'; readonly runId: string }
  | { readonly kind: 'review'; readonly reviewKey: string };

/** The note under the goal's header: what happened, or what the goal waits on, and the way forward. */
export type GoalNote = {
  /** Neutral for every note but an attempt that waits on you, which is amber. */
  readonly tone: 'neutral' | 'warning';
  readonly text: string;
  readonly link: { readonly label: string; readonly target: GoalNoteTarget } | undefined;
};

/**
 * The note the goal's page shows under its header, or `undefined` for a goal that is working with
 * nothing to say. An ended goal says how it ended and links to its last attempt; it never says who
 * stopped it, because the cancel records no actor (row 67q). A goal whose attempt waits on you says
 * so in amber and links to the review, which is answered in Reviews (row 69b).
 */
export function goalNote(
  goal: Pick<Goal, 'status' | 'attempts' | 'usage' | 'bounds' | 'closedAt'>,
  context: { readonly zone: string; readonly liveWait: AttemptWait | undefined },
): GoalNote | undefined {
  const last = newestAttempt(goal);
  const made = goal.usage.attempts;
  const allowed = goal.bounds.maximumAttempts;
  if (!goalHasEnded(goal.status)) {
    const live = liveAttempt(goal);
    const wait = context.liveWait;
    if (live === undefined || wait === undefined) return undefined;
    const what =
      wait.kind === 'approval'
        ? copy.note.approvalNeeded(wait.tool ?? copy.note.aTool)
        : copy.note.questionNeeded;
    return {
      tone: 'warning',
      text: copy.note.waiting(live.attemptIndex + 1, what),
      link: {
        label: copy.note.openInReviews,
        target: { kind: 'review', reviewKey: wait.reviewKey },
      },
    };
  }
  const closed = instant(goal.closedAt) ?? instant(last?.completedAt ?? null);
  const when = closed === null ? undefined : noteWhen(closed, context.zone);
  const link =
    last === undefined
      ? undefined
      : {
          label: copy.note.openAttempt(last.attemptIndex + 1),
          target: { kind: 'run', runId: last.runId } as const,
        };
  let text: string;
  switch (goal.status) {
    case 'succeeded':
      text = copy.note.done(last === undefined ? made : last.attemptIndex + 1, allowed, when);
      break;
    case 'exhausted':
      text = copy.note.gaveUp(made, allowed, when);
      break;
    case 'canceled':
      text = copy.note.stopped(made, allowed, when);
      if (last?.status === 'aborted') {
        text = `${text} ${copy.note.attemptCanceled(last.attemptIndex + 1)}`;
      }
      break;
    default:
      text = copy.note.failed(made, allowed, when);
  }
  return { tone: 'neutral', text, link };
}

/** One fact of the Details panel beside the attempts. */
export type GoalFact = { readonly term: string; readonly definition: string };

/**
 * The Details panel: the check, the agent, the attempt limit, when it stops, and when it was made
 * and by whom ("Fri, Oct 30, 8:12 AM by you"). The prompt is not among them: the goal's view does
 * not carry it.
 */
export function goalFacts(
  goal: Pick<Goal, 'validator' | 'bounds' | 'createdAt' | 'owner'>,
  context: {
    readonly agent: string;
    readonly zone: string;
    /** Who the caller is, so a goal the caller made reads "by you". */
    readonly viewer: string | null | undefined;
  },
): GoalFact[] {
  const created = instant(goal.createdAt);
  const by = context.viewer === goal.owner ? copy.createdByYou : goal.owner;
  return [
    { term: copy.checkFact, definition: checkText(goal.validator.name) },
    { term: copy.agentFact, definition: context.agent },
    { term: copy.limitFact, definition: copy.attemptLimit(goal.bounds.maximumAttempts) },
    { term: copy.stopsFact, definition: copy.stops },
    {
      term: copy.createdFact,
      definition:
        created === null
          ? copy.created(goal.createdAt, by)
          : copy.created(
              `${shortDay(created, context.zone)}, ${clockTime(created, context.zone)}`,
              by,
            ),
    },
  ];
}

/** The actions the goal's header offers. Edit is on every goal's page (row 68o). */
export type GoalActions = {
  /** Stop goal, the page's main action while the goal is working and has not been asked to stop. */
  readonly stop: boolean;
  /**
   * Start again, on a goal that ended without meeting its check: it gave up, was stopped or failed.
   * A goal that is done has nothing left to try (row 67t).
   */
  readonly startAgain: boolean;
};

/** Which of Stop goal and Start again the goal's header offers. */
export function goalActions(goal: Pick<Goal, 'status' | 'cancellation'>): GoalActions {
  const ended = goalHasEnded(goal.status);
  return {
    stop: !ended && goal.cancellation === null,
    startAgain: ended && goal.status !== 'succeeded',
  };
}

/**
 * The body of the Stop goal confirmation, for what the goal is doing: checking an attempt's result,
 * running one, or between attempts.
 */
export function stopDescription(goal: Pick<Goal, 'status' | 'attempts'>): string {
  const newest = newestAttempt(goal);
  if (newest?.status === 'evaluating') return copy.stop.checking(newest.attemptIndex + 1);
  if (newest?.status === 'running') return copy.stop.running(newest.attemptIndex + 1);
  return copy.stop.between;
}

/** The goal's Edit page, which the goal form serves (`/goals/:goal/edit`). */
export function goalEditPath(goalRunId: string): string {
  return `/goals/${encodeURIComponent(goalRunId)}/edit`;
}

/** New goal, prefilled from the goal `goalRunId` (Start again). */
export function startAgainPath(goalRunId: string): string {
  return `/goals/new?${new URLSearchParams({ from: goalRunId }).toString()}`;
}

/** Reviews, with the review `reviewKey` open. */
export function reviewPath(reviewKey: string): string {
  return `/reviews?${new URLSearchParams({ review: reviewKey }).toString()}`;
}
