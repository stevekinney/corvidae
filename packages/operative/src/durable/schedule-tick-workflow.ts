/**
 * The schedule tick (COR-2009): an internal workflow whose short runs record what a Bureau's
 * scheduler did, so a run list shows the scheduler's own work beside the runs it started. It takes
 * no `services` and does nothing but check what it was given and return it as its result: an agent
 * schedule that came due (`came-due`), or occurrences the engine noticed a schedule missed
 * (`missed-runs`). The Bureau starts it; `createRunEngine` registers it.
 *
 * @module schedule-tick-workflow
 */

import { workflow } from '@lostgradient/weft';

import { RUN_ENGINE_WORKFLOW_TYPE } from './run-engine-workflow-types';

/** A schedule came due and its fire started. */
export interface ScheduleCameDueTick {
  /** Discriminant. */
  readonly event: 'came-due';
  /** The schedule. */
  readonly scheduleId: string;
  /** The schedule's description when the tick was recorded, or `null`. */
  readonly scheduleName: string | null;
  /** The run the fire started. */
  readonly fireRunId: string;
}

/** The engine noticed occurrences a schedule missed. */
export interface ScheduleMissedRunsTick {
  /** Discriminant. */
  readonly event: 'missed-runs';
  /** The schedule. */
  readonly scheduleId: string;
  /** The schedule's description when the tick was recorded, or `null`. */
  readonly scheduleName: string | null;
  /** How many occurrences it missed. */
  readonly missedRuns: number;
  /** `late` when the engine was down or too slow, `dst-gap` when the clock skipped the time. */
  readonly reason: 'late' | 'dst-gap';
  /** The start of the missed window, in epoch milliseconds. */
  readonly since: number;
  /** The end of the missed window, in epoch milliseconds. */
  readonly until: number;
  /** Whether the window began before this Bureau started: the catch-up after the host was off. */
  readonly whileStopped: boolean;
}

/** What one schedule tick records: its input, returned as its output. */
export type ScheduleTick = ScheduleCameDueTick | ScheduleMissedRunsTick;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `value` is a {@link ScheduleTick} as this release writes one. */
export function isScheduleTick(value: unknown): value is ScheduleTick {
  if (!isRecord(value) || typeof value['scheduleId'] !== 'string') return false;
  const name = value['scheduleName'];
  if (name !== null && typeof name !== 'string') return false;
  if (value['event'] === 'came-due') return typeof value['fireRunId'] === 'string';
  return (
    value['event'] === 'missed-runs' &&
    typeof value['missedRuns'] === 'number' &&
    (value['reason'] === 'late' || value['reason'] === 'dst-gap') &&
    typeof value['since'] === 'number' &&
    typeof value['until'] === 'number' &&
    typeof value['whileStopped'] === 'boolean'
  );
}

/** The schedule tick workflow: it checks what it was given and records it as its result. */
export function createScheduleTickWorkflow() {
  return (
    workflow({
      name: RUN_ENGINE_WORKFLOW_TYPE.scheduleTick,
      description:
        'Records what the scheduler did: a schedule came due, or missed runs were noticed.',
    })
      // eslint-disable-next-line @typescript-eslint/require-await -- Weft durable generator: the record is made through yield*, not a top-level await.
      .execute(async function* (ctx, input: unknown): AsyncGenerator<unknown, ScheduleTick> {
        if (!isScheduleTick(input)) {
          throw new TypeError('A schedule tick records a schedule that came due or missed runs.');
        }
        return yield* ctx.run(() => Promise.resolve(input));
      })
  );
}
