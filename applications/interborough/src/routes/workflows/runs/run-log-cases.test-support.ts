import type { RunLogLine } from './run-logs-data.ts';

/** One run as the engine recorded it: its timeline entries, its lines, and where each line belongs. */
export interface RunLogCase {
  readonly name: string;
  /** `step` is the checkpoint key and `stepIndex` the index its lines carry. */
  readonly entries: ReadonlyArray<{ readonly step: number; readonly stepIndex: number }>;
  /** Each line as `[message, step]`, in the order it was logged. */
  readonly lines: ReadonlyArray<readonly [string, number | null]>;
  /** The messages logged before every entry. */
  readonly beforeFirst: readonly string[];
  /** The messages placed under each entry, by checkpoint key, for the entries that have any. */
  readonly byStep: ReadonlyArray<readonly [number, readonly string[]]>;
}

/** A stored line, named after what it was logged in front of. */
export function logLine(sequence: number, step: number | null, message: string): RunLogLine {
  return {
    sequence,
    step,
    level: 'info',
    message,
    timestamp: 1_000 + sequence,
    workflowType: 'work',
    truncated: false,
  };
}

/** The lines of a case, as the engine returns them. */
export function linesOf(runCase: RunLogCase): RunLogLine[] {
  return runCase.lines.map(([message, step], sequence) => logLine(sequence, step, message));
}

/**
 * The cases COR-1988 names, each the timeline and the lines the engine produced for it
 * (`packages/weft/src/core/engine/timeline-step-index.test.ts`), with arbitrary checkpoint keys.
 */
export const RUN_LOG_CASES: readonly RunLogCase[] = [
  {
    name: 'a signal resume',
    entries: [
      { step: 0, stepIndex: 0 },
      { step: 1, stepIndex: 1 },
    ],
    lines: [
      ['before-wait', 0],
      ['after-wait', 1],
      ['end', 2],
    ],
    beforeFirst: [],
    byStep: [
      [0, ['before-wait']],
      [1, ['after-wait', 'end']],
    ],
  },
  {
    name: 'a recovered run that resumes from a parked signal wait',
    entries: [
      { step: 0, stepIndex: 0 },
      { step: 1, stepIndex: 1 },
      { step: 2, stepIndex: 2 },
    ],
    lines: [
      ['before-step', 0],
      ['after-wait', 2],
    ],
    beforeFirst: [],
    byStep: [
      [0, ['before-step']],
      [2, ['after-wait']],
    ],
  },
  {
    name: 'a retried activity and the sleeps between its attempts',
    entries: [
      { step: 0, stepIndex: 0 },
      { step: 1, stepIndex: 1 },
      { step: 2, stepIndex: 0 },
      { step: 3, stepIndex: 2 },
      { step: 4, stepIndex: 0 },
      { step: 5, stepIndex: 3 },
    ],
    lines: [
      ['before-flaky', 0],
      ['after-flaky', 3],
    ],
    beforeFirst: [],
    byStep: [
      [0, ['before-flaky']],
      [5, ['after-flaky']],
    ],
  },
  {
    name: 'runAll and groups nested to depth two',
    entries: [
      { step: 0, stepIndex: 0 },
      { step: 1, stepIndex: 3 },
      { step: 2, stepIndex: 4 },
      { step: 3, stepIndex: 8 },
      { step: 4, stepIndex: 15 },
    ],
    lines: [
      ['before-all', 0],
      ['before-run-all', 3],
      ['before-race', 4],
      ['before-nested', 8],
      ['before-last', 15],
      ['end', 16],
    ],
    beforeFirst: [],
    byStep: [
      [0, ['before-all']],
      [1, ['before-run-all']],
      [2, ['before-race']],
      [3, ['before-nested']],
      [4, ['before-last', 'end']],
    ],
  },
  {
    name: 'a speculate that committed and one that rolled back',
    entries: [
      { step: 0, stepIndex: 0 },
      { step: 1, stepIndex: 3 },
      { step: 2, stepIndex: 4 },
    ],
    lines: [
      ['before-commit', 0],
      ['inside-commit', 0],
      ['before-rollback', 3],
      ['inside-rollback', 3],
      ['before-last', 4],
    ],
    beforeFirst: [],
    byStep: [
      [0, ['before-commit', 'inside-commit']],
      [1, ['before-rollback', 'inside-rollback']],
      [2, ['before-last']],
    ],
  },
  {
    name: 'session state writes, which take an index and write no entry',
    entries: [{ step: 0, stepIndex: 2 }],
    lines: [
      ['before-writes', 0],
      ['after-writes', 2],
    ],
    beforeFirst: ['before-writes'],
    byStep: [[0, ['after-writes']]],
  },
  {
    name: 'a repeated memo key, which takes an index and writes no entry',
    entries: [
      { step: 0, stepIndex: 0 },
      { step: 1, stepIndex: 2 },
    ],
    lines: [
      ['before-memo', 0],
      ['between-memos', 1],
      ['after-memos', 2],
    ],
    beforeFirst: [],
    byStep: [
      [0, ['before-memo', 'between-memos']],
      [1, ['after-memos']],
    ],
  },
  {
    name: 'a fork, whose entries start at the step it replayed to',
    entries: [
      { step: 0, stepIndex: 1 },
      { step: 1, stepIndex: 2 },
    ],
    lines: [
      ['before-wait', 1],
      ['after-wait', 2],
    ],
    beforeFirst: [],
    byStep: [
      [0, ['before-wait']],
      [1, ['after-wait']],
    ],
  },
];
