/**
 * The rows of the Run inspector card under How it ran (COR-2424, row 54i): where the run's progress
 * stands, what it waits on, whether it still gives signs of life, whether the page's follow of it is
 * up to date, and where its cleanup stands. Written from the task the page already holds, so the
 * card needs no read of its own and no scope beyond the page's. Pure, so each state is a row in a
 * table test.
 */
import { RUN_DETAIL_COPY } from '../../../app/copy/runs.ts';
import type { TaskView } from '../../../lib/bureau-tasks.ts';
import { dayStamp } from '../../../lib/format/clock.ts';

/** What the card is made from. */
export type RunInspectorInput = {
  /** The Bureau's task. */
  readonly task: Pick<TaskView, 'status' | 'openWaits' | 'cleanup' | 'updatedAt'>;
  /** Where the page's follow of the task's stream stands. */
  readonly followState:
    'connecting' | 'live' | 'reconnecting' | 'ended' | 'unavailable' | 'not-found';
  /** The signals the engine says the run is parked on, when it holds the run. */
  readonly waitingForSignals?: readonly string[] | undefined;
};

/** One labelled row of the card. */
export type RunInspectorRow = {
  readonly key: 'progress' | 'waiting' | 'liveness' | 'stream' | 'cleanup';
  readonly label: string;
  readonly value: string;
};

/** The rows of the Run inspector, in the order the card draws them. */
export function runInspectorRows(input: RunInspectorInput): RunInspectorRow[] {
  const copy = RUN_DETAIL_COPY.inspector;
  const { task, followState } = input;
  const signals = input.waitingForSignals ?? [];
  const ended = Date.parse(task.updatedAt);

  let progress: string = copy.progressWorking;
  let liveness: string = copy.livenessWorking;
  switch (task.status) {
    case 'completed':
    case 'failed':
    case 'canceled':
      progress = copy.progressOver[task.status];
      liveness = copy.livenessOver(Number.isFinite(ended) ? dayStamp(ended) : undefined);
      break;
    case 'input-required':
      progress = copy.progressWaiting;
      liveness = copy.livenessWaiting;
      break;
    case 'submitted':
      progress = copy.progressSubmitted;
      break;
    case 'working':
      break;
  }

  const humanWait = task.openWaits.some((wait) => wait.kind === 'human-wait');
  const waiting =
    task.openWaits.length > 0
      ? humanWait
        ? copy.waitAnswer
        : copy.waitApproval
      : signals.length > 0
        ? copy.waitSignal(signals)
        : copy.nothing;

  // A run that is over has said everything its stream had to say, however the follow ended.
  const over =
    task.status === 'completed' || task.status === 'failed' || task.status === 'canceled';
  const stream =
    over && followState !== 'unavailable' && followState !== 'not-found'
      ? copy.stream.upToDate
      : copy.stream[followState === 'ended' ? 'upToDate' : followState];

  return [
    { key: 'progress', label: copy.rows.progress, value: progress },
    { key: 'waiting', label: copy.rows.waiting, value: waiting },
    { key: 'liveness', label: copy.rows.liveness, value: liveness },
    { key: 'stream', label: copy.rows.stream, value: stream },
    {
      key: 'cleanup',
      label: copy.rows.cleanup,
      value: task.cleanup === null ? copy.cleanupNone : copy.cleanup[task.cleanup],
    },
  ];
}
