/**
 * What started a workflow run (COR-2546): the one reader of a run's start, so no reader trusts the
 * shape of a run's input.
 *
 * A run's input is one of two things. A run Bureau started (`bureau.workflows.start`, a signal, a
 * hook) carries an envelope Bureau built, `{ kind, input, origin, … }`, tagged `origin:<kind>`. A
 * run a schedule fired carries the schedule's stored input, and a schedule a caller made for a code
 * workflow stores the caller's own value, which can be shaped like an envelope, an agent's input, or
 * anything else. Reading `origin` or `scheduleId` out of such an input would let its author name the
 * origin a person is shown, the owner of a task, or a schedule that is someone else's.
 *
 * So the schedule that fired a run is read from Weft's own record of the fire
 * (`engine.getScheduleProvenance`), which survives until the run is purged and which no input can
 * write, and the origin a start declared is read only from a run no schedule fired, and only when it
 * carries the tag Bureau set beside it.
 *
 * @module workflow-run-start
 */

import type { WorkflowScheduleProvenance } from '@lostgradient/weft';

import { isTaskOrigin, type TaskOrigin, taskOriginTag } from './task-origin';

/** The engine, as far as {@link startOfRun} reads it. */
export interface RunStartEngine {
  /** The schedule occurrence that launched a run, or `null` when no schedule did. */
  readonly getScheduleProvenance: (runId: string) => Promise<WorkflowScheduleProvenance | null>;
}

/** The parts of a run {@link startOfRun} reads. */
export interface RunStartSource {
  readonly id: string;
  /** The tags the run was started with. */
  readonly tags?: readonly string[] | undefined;
  /** The input the run was started with. */
  readonly input?: unknown;
}

/** What started a run. */
export interface RunStart {
  /** The origin a Bureau start declared, or `null` for a run Bureau did not start with one. */
  readonly origin: TaskOrigin | null;
  /** The schedule that fired the run, or `null` when none did. */
  readonly scheduleId: string | null;
  /** Present when a person triggered the schedule instead of its cadence firing. */
  readonly scheduleManual?: true;
}

/**
 * The origin the envelope of a run Bureau started declares. Read only when the run carries the tag
 * Bureau sets from the same origin, and never a `schedule` origin: Bureau never starts a workflow
 * declaring one, so a `schedule` origin in an input is always the input's author's.
 */
function declaredOrigin(run: RunStartSource): TaskOrigin | null {
  const input = run.input;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const origin: unknown = Reflect.get(input, 'origin');
  if (!isTaskOrigin(origin) || origin.kind === 'schedule') return null;
  return run.tags?.includes(taskOriginTag(origin)) === true ? origin : null;
}

/**
 * What started `run`: the schedule that fired it when one did, else the origin Bureau's own start
 * declared. A run a schedule fired declares no origin, whatever its input says.
 */
export async function startOfRun(engine: RunStartEngine, run: RunStartSource): Promise<RunStart> {
  const provenance = await engine.getScheduleProvenance(run.id);
  if (provenance !== null) {
    return {
      origin: null,
      scheduleId: provenance.scheduleId,
      ...(provenance.manual === true ? { scheduleManual: true } : {}),
    };
  }
  return { origin: declaredOrigin(run), scheduleId: null };
}
