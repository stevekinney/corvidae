/**
 * What the Run page says of a run that needs a look (COR-2528): one note for each state the Bureau
 * lists on the task, in the order the list says them. A stalled run says when it was seen to
 * stall, and so that it last made progress before then: the Bureau records the instant it saw
 * Operative judge the run `alive-but-stalled`, not the instant of the last pulse. Pure, so each
 * state is a row in a table test.
 */
import { RUN_ATTENTION_COPY } from '../../../app/copy/run-attention.ts';
import {
  isTerminalState,
  TASK_ATTENTION_KINDS,
  type TaskAttention,
  type TaskView,
} from '../../../lib/bureau-tasks.ts';
import { rowTime } from '../../../lib/format/clock.ts';
import { formatCost } from '../../../lib/format/cost.ts';

/** One note: the state it is for, its title, and the sentence under it. */
export type RunAttentionNote = {
  readonly state: TaskAttention;
  readonly title: string;
  readonly line: string;
};

/** A moment as it reads after "seen stalled": "at 9:05 AM", "yesterday at 4:12 PM", "on Thu, Oct 29, 4:12 PM". */
function whenSeen(at: number, now: number, zone: string): string {
  const label = rowTime(at, now, zone);
  const yesterday = 'Yesterday, ';
  if (label.startsWith(yesterday)) return `yesterday at ${label.slice(yesterday.length)}`;
  return /^\d/.test(label) ? `at ${label}` : `on ${label}`;
}

/**
 * The notes for a task: a state it is in and the Bureau lists, once each. A task from a Bureau
 * that reports no `attention` has none.
 *
 * @param task - The Bureau's view of the run.
 * @param now - The clock the time of a stall is said against, in epoch milliseconds.
 * @param zone - The IANA zone the time is written in: the viewer's.
 */
export function runAttentionNotes(
  task: Pick<TaskView, 'attention' | 'stalledSince' | 'status' | 'usage'>,
  now: number,
  zone: string,
): readonly RunAttentionNote[] {
  const states = task.attention ?? [];
  const over = isTerminalState(task.status);
  const notes = RUN_ATTENTION_COPY.note;
  const listed = TASK_ATTENTION_KINDS.filter((state) => states.includes(state)).map(
    (state): RunAttentionNote => {
      switch (state) {
        case 'stalled': {
          const seen = task.stalledSince == null ? Number.NaN : Date.parse(task.stalledSince);
          return {
            state,
            title: notes.stalled.title,
            line: notes.stalled.line(Number.isNaN(seen) ? undefined : whenSeen(seen, now, zone)),
          };
        }
        case 'looping':
          return { state, title: notes.looping.title, line: notes.looping.line };
        case 'overspending':
          return {
            state,
            title: notes.overspending.title,
            line: notes.overspending.line(formatCost(task.usage?.costUsd ?? null), over),
          };
      }
    },
  );
  // A run that is still going says once, under its last note, that it keeps going.
  const last = listed.at(-1);
  if (over || last === undefined) return listed;
  return [...listed.slice(0, -1), { ...last, line: `${last.line} ${notes.keepsRunning}` }];
}
