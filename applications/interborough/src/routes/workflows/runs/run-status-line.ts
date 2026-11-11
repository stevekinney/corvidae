/**
 * The words of a run page's status line that are made from the run's state (rows 54l, 54s, 55n, 56g
 * and 56i): the one status word, with the qualifier a goal's attempt checking its result carries,
 * and the parts that follow the day and the time of a run that has not ended. A run still going
 * says how long it has run; a run that waits on a person says how long, and what the person does
 * for it to go on; a run that waits for a signal reads Waiting, a hollow neutral ring and no amber,
 * because it needs nobody; and an attempt checking its result reads Running with that qualifier, and
 * says which attempt it is and how long the agent took.
 *
 * Pure, so each state is a row in a table test, and the page only hands it what it has read.
 */
import type { StatusDotWordLabel } from '@lostgradient/cinder';

import { RUN_DETAIL_COPY } from '../../../app/copy.ts';
import { isTerminalState, type TaskView } from '../../../lib/bureau-tasks.ts';
import type { StatusWord } from '../../../lib/status.ts';
import { durationWords, waitedWords } from './run-rows.ts';

/** What the status line is made from. */
export type RunStatusLineInput = {
  /** The run's one status word, from the first source that knows the run. */
  readonly status: StatusWord;
  /** When the run started, in epoch milliseconds. */
  readonly startedAt: number;
  /** Whether the run is over. */
  readonly over: boolean;
  /** The clock the durations are counted to, in epoch milliseconds. */
  readonly now: number;
  /** The Bureau's task, when the run is one. */
  readonly task?: Pick<TaskView, 'status' | 'openWaits' | 'createdAt' | 'updatedAt'> | undefined;
  /** The signals the workflow engine says the run is parked on, when the engine holds it. */
  readonly waitingForSignals?: readonly string[] | undefined;
  /** The goal attempt the run is, when it is one. */
  readonly attempt?:
    | {
        readonly number: number;
        readonly of: number;
        /** Whether the attempt's agent has finished and its result is being checked. */
        readonly checking: boolean;
      }
    | undefined;
};

/** The status line: the word, the parts after the time, and the signals a run waits for. */
export type RunStatusLine = {
  readonly word: StatusDotWordLabel;
  /** Parts of the line after the day, the time and the duration, each set off by a comma. */
  readonly phrases: readonly string[];
  /** The signals the run waits for, each said in code after "waiting for signal". */
  readonly signals: readonly string[];
};

/** The milliseconds of the agent's work inside an attempt: its task's, or the time so far. */
function agentMilliseconds(input: RunStatusLineInput): number {
  const { task } = input;
  if (task === undefined) return Math.max(0, input.now - input.startedAt);
  const began = Date.parse(task.createdAt);
  const ended = isTerminalState(task.status) ? Date.parse(task.updatedAt) : input.now;
  return Math.max(0, ended - began);
}

/** The status word and the parts that follow the time for a run in the state `input` describes. */
export function runStatusLine(input: RunStatusLineInput): RunStatusLine {
  const copy = RUN_DETAIL_COPY.status;
  const { attempt, task } = input;
  if (attempt?.checking === true) {
    return {
      word: 'Running, checking the result',
      phrases: [
        copy.attempt(attempt.number, attempt.of),
        copy.agentTook(durationWords(agentMilliseconds(input))),
      ],
      signals: [],
    };
  }
  if (input.status === 'Waiting on you' && task !== undefined) {
    const asksAnswer = task.openWaits.some((wait) => wait.kind === 'human-wait');
    return {
      word: input.status,
      phrases: [
        copy.waiting(waitedWords(input.now - Date.parse(task.updatedAt))),
        asksAnswer ? copy.needsAnswer : copy.needsApproval,
      ],
      signals: [],
    };
  }
  // A run a person answers is the task's and reads Waiting on you above; a run the engine parked on
  // a signal needs nobody to be at the page, so it reads Waiting.
  const signals = input.waitingForSignals ?? [];
  if (!input.over && task === undefined && input.status === 'Running' && signals.length > 0) {
    return { word: 'Waiting', phrases: [], signals };
  }
  if (!input.over && input.status === 'Running') {
    return {
      word: input.status,
      phrases: [copy.soFar(durationWords(input.now - input.startedAt))],
      signals: [],
    };
  }
  return { word: input.status, phrases: [], signals: [] };
}
