/**
 * The run timeline's view model (COR-2542): what `bureau.runs.timeline` answered, laid out as one
 * row per step with its status, duration, tries and waterfall bar. Pure data in, pure data out, so
 * the rules that matter are tested without a browser: the bars come from the one layout function the
 * run page uses, a step the run is still in is said to be running, and an answer of an unexpected
 * shape is refused rather than drawn.
 */
import {
  openStepNumbers,
  stepWaterfall,
  type WaterfallBar,
} from '@lostgradient/interborough-plugin/step-waterfall';

/** The status of a step as the engine reports it. */
type StepStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out';

/** One step of a run, as `bureau.runs.timeline` serves it: names and timings, never a payload. */
type TimelineEntry = {
  readonly step: number;
  readonly label: string;
  readonly operationType: string;
  readonly status: string;
  /** When the step started, in epoch milliseconds. */
  readonly timestamp: number;
  /** How long the step ran, in milliseconds; absent while it runs. */
  readonly duration?: number | undefined;
  /** How many times the engine tried the step, this attempt included. */
  readonly tries: number;
};

/** What `bureau.runs.timeline` answers. */
export type Timeline = {
  readonly runId: string;
  readonly kind: string;
  /**
   * Where the run stands: `pending`, `running`, `suspended`, `completed`, `failed`, `cancelled` or
   * `timed-out`; `undefined` from a host that does not say. A finished run has no step still going.
   */
  readonly runStatus: string | undefined;
  readonly entries: readonly TimelineEntry[];
  /** True when the run has more steps than the read returns. */
  readonly truncated: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function readEntry(value: unknown): TimelineEntry | undefined {
  if (!isRecord(value)) return undefined;
  const { step, label, operationType, status, timestamp, duration, tries } = value;
  // Weft numbers a run's steps with whole numbers from 1 (`isTimelineStep`), and the page keys its
  // rows and looks up its bars by that number, so any other step is not one the engine wrote.
  if (typeof step !== 'number' || !Number.isSafeInteger(step) || step < 1) return undefined;
  if (!finite(timestamp)) return undefined;
  if (
    typeof label !== 'string' ||
    typeof operationType !== 'string' ||
    typeof status !== 'string'
  ) {
    return undefined;
  }
  return {
    step,
    label,
    operationType,
    status,
    timestamp,
    ...(finite(duration) ? { duration } : {}),
    tries: finite(tries) && tries >= 1 ? Math.floor(tries) : 1,
  };
}

/**
 * The timeline a host answered, or `undefined` when the value is not one. A single entry the page
 * cannot read refuses the whole answer: a waterfall with a step missing would mislead more than
 * one that says it could not be read.
 */
function readTimeline(value: unknown): Timeline | undefined {
  if (!isRecord(value) || !Array.isArray(value['entries'])) return undefined;
  const { runId, kind, runStatus, truncated } = value;
  if (typeof runId !== 'string') return undefined;
  const entries: TimelineEntry[] = [];
  for (const raw of value['entries'] as unknown[]) {
    const entry = readEntry(raw);
    if (entry === undefined) return undefined;
    entries.push(entry);
  }
  return {
    runId,
    kind: typeof kind === 'string' ? kind : 'workflow',
    runStatus: typeof runStatus === 'string' ? runStatus : undefined,
    entries,
    truncated: truncated === true,
  };
}

/**
 * The timeline a tool result carries: its structured content, which Chat hands a panel as the
 * agent tool's result in JSON text, or failing that its first text block.
 */
export function timelineOfResult(result: {
  readonly structuredContent?: unknown;
  readonly content?: unknown;
  readonly isError?: boolean | undefined;
}): Timeline | undefined {
  if (result.isError === true) return undefined;
  const { structuredContent } = result;
  if (typeof structuredContent === 'string') {
    try {
      return readTimeline(JSON.parse(structuredContent));
    } catch {
      return undefined;
    }
  }
  return readTimeline(structuredContent);
}

/**
 * The run a page is pointed at. The run page opens a panel with `taskId`, the timeline tool takes
 * `runId`; either names the run.
 */
export function runIdOf(argumentsOfCall: unknown): string | undefined {
  if (!isRecord(argumentsOfCall)) return undefined;
  for (const key of ['runId', 'taskId']) {
    if (!Object.hasOwn(argumentsOfCall, key)) continue;
    const value = argumentsOfCall[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/** A Cinder badge variant. */
type StatusVariant = 'success' | 'danger' | 'info' | 'neutral';

/** One step as the page draws it. */
type TimelineRow = {
  readonly step: number;
  /** What the step is: an activity's name, `sleep`, `await-signal`. */
  readonly label: string;
  readonly operationType: string;
  /** The status as the engine reported it, for the bar's styling. */
  readonly status: string;
  /** What the badge says. */
  readonly statusLabel: string;
  readonly statusVariant: StatusVariant;
  /** True while the run is still in the step. */
  readonly open: boolean;
  /** How long the step took, in words. */
  readonly durationText: string;
  /** How many tries it took, in words. */
  readonly triesText: string;
  /** Where the bar sits on the run's scale; `undefined` for a step with no usable start. */
  readonly bar: WaterfallBar | undefined;
  /** What the bar says to a reader who cannot see it. */
  readonly barLabel: string;
};

/** What the page shows of a timeline. */
export type TimelineModel = {
  readonly runId: string;
  readonly rows: readonly TimelineRow[];
  /** Where the run stands in words (`Run completed.`), or `undefined` from a host that does not say. */
  readonly runStatusText: string | undefined;
  readonly truncated: boolean;
  /** One line over the steps: how many, and how many failed or are running. */
  readonly summary: string;
};

/** A length of time in the largest two units: `340 ms`, `1.2 s`, `2 min 5 s`, `1 h 3 min`. */
function formatMilliseconds(milliseconds: number): string {
  const value = Math.max(0, milliseconds);
  if (value < 1000) return `${String(Math.round(value))} ms`;
  if (value < 60_000) {
    const seconds = Math.round(value / 100) / 10;
    return `${String(seconds)} s`;
  }
  const totalSeconds = Math.round(value / 1000);
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${String(minutes)} min` : `${String(minutes)} min ${String(seconds)} s`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return minutes === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(minutes)} min`;
}

const STATUS_WORDS: Readonly<Record<StepStatus, { label: string; variant: StatusVariant }>> = {
  running: { label: 'Running', variant: 'info' },
  completed: { label: 'Succeeded', variant: 'success' },
  failed: { label: 'Failed', variant: 'danger' },
  cancelled: { label: 'Cancelled', variant: 'neutral' },
  'timed-out': { label: 'Timed out', variant: 'danger' },
};

function statusOf(status: string, open: boolean): { label: string; variant: StatusVariant } {
  // A `running` entry the run has since left ended, and how is not recorded.
  if (status === 'running' && !open) return { label: 'Ended', variant: 'neutral' };
  return Object.hasOwn(STATUS_WORDS, status)
    ? STATUS_WORDS[status as StepStatus]
    : { label: status, variant: 'neutral' };
}

const plural = (count: number, one: string, many: string): string =>
  `${String(count)} ${count === 1 ? one : many}`;

function summaryOf(rows: readonly TimelineRow[], truncated: boolean): string {
  if (rows.length === 0) return 'No steps yet.';
  const failed = rows.filter((row) => row.statusVariant === 'danger').length;
  const running = rows.filter((row) => row.open).length;
  const parts = [plural(rows.length, 'step', 'steps')];
  if (failed > 0) parts.push(`${String(failed)} failed or timed out`);
  if (running > 0) parts.push(`${String(running)} running`);
  return `${parts.join(', ')}${truncated ? ', and more than the page shows' : ''}.`;
}

/**
 * The model of `timeline` at time `now`. The layout is `stepWaterfall`, the function the run page
 * lays out the engine's entries with, given the run's status: a run that has finished has no step
 * still going, so a step the engine left `running` is drawn as ended, not running. The timeline
 * carries no start for the run, so the origin is the first step's start.
 */
export function buildTimelineModel(timeline: Timeline, now: number): TimelineModel {
  const { runStatus } = timeline;
  const bars = stepWaterfall(timeline.entries, { now, runStatus });
  const open = openStepNumbers(timeline.entries, runStatus);
  const rows = timeline.entries
    .toSorted((a, b) => a.step - b.step)
    .map((entry): TimelineRow => {
      const bar = bars.get(entry.step);
      const isOpen = open.has(entry.step);
      const status = statusOf(entry.status, isOpen);
      const durationText = isOpen
        ? 'running'
        : entry.duration === undefined
          ? 'no duration kept'
          : formatMilliseconds(entry.duration);
      const barLabel =
        bar === undefined
          ? 'no start time kept'
          : `Started ${formatMilliseconds(bar.startedAfter)} into the run, ${
              isOpen
                ? 'still running'
                : entry.duration === undefined
                  ? 'no duration kept'
                  : `took ${formatMilliseconds(entry.duration)}`
            }`;
      return {
        step: entry.step,
        label: entry.label,
        operationType: entry.operationType,
        status: entry.status,
        statusLabel: status.label,
        statusVariant: status.variant,
        open: isOpen,
        durationText,
        triesText: plural(entry.tries, 'try', 'tries'),
        bar,
        barLabel,
      };
    });
  return {
    runId: timeline.runId,
    rows,
    runStatusText: runStatus === undefined ? undefined : `Run ${runStatus}.`,
    truncated: timeline.truncated,
    summary: summaryOf(rows, timeline.truncated),
  };
}

/**
 * What the polite live region says about the change from `before` to `after`, or `null` when a
 * read changed nothing a listener needs: a new step, or a step that has now failed.
 */
export function describeChange(
  before: TimelineModel | undefined,
  after: TimelineModel,
): string | null {
  if (before === undefined || before.runId !== after.runId) return null;
  const previous = new Map(before.rows.map((row) => [row.step, row]));
  const sentences: string[] = [];
  for (const row of after.rows) {
    const earlier = previous.get(row.step);
    if (earlier === undefined) {
      sentences.push(`Step ${String(row.step)}, ${row.label}, ${row.statusLabel.toLowerCase()}.`);
    } else if (earlier.statusLabel !== row.statusLabel) {
      sentences.push(`Step ${String(row.step)}, ${row.label}, ${row.statusLabel.toLowerCase()}.`);
    }
  }
  return sentences.length === 0 ? null : sentences.join(' ');
}
