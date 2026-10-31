/**
 * The native schedule a workflow file with a `schedule` trigger owns (COR-1527). The file is the
 * only source of truth: every scan and every startup puts the schedule back to match it.
 *
 * ## The id
 *
 * `bureau-workflow-schedule:<identifier>:<generation>`. Weft keeps a cancelled schedule's record
 * and refuses to create another under its id, so deleting a file and creating it again could never
 * schedule again under an id that was only a function of the identifier. The generation is one
 * more than the highest generation among every schedule of this identifier, cancelled ones
 * included, read from the engine each time and never stored on its own. "One schedule" means one
 * that is not cancelled. A `:` is allowed in a Weft id (the key encodes it), and the identifier is
 * capped at 64 characters, which keeps the id inside Weft's 128.
 *
 * @module workflow-schedule
 */

import {
  type Engine,
  normalizeScheduleSpec,
  type NormalizedScheduleSpec,
  type ScheduleSummary,
} from '@lostgradient/weft';

import { toScheduleSpec } from './schedule-spec';
import { weftNameOf } from './namespaced-identifier';
import { WORKFLOW_IDENTIFIER_PATTERN } from './workflow-file';
import type { ScheduleOverlapPolicy } from './workflow-host';

export const WORKFLOW_SCHEDULE_ID_PREFIX = 'bureau-workflow-schedule:';

/** The id of generation `generation` of the schedule of workflow `identifier`. */
export function workflowScheduleId(identifier: string, generation: number): string {
  return `${WORKFLOW_SCHEDULE_ID_PREFIX}${identifier}:${String(generation)}`;
}

/** The workflow and generation a Bureau workflow schedule id names, or `undefined` for any other id. */
export function parseWorkflowScheduleId(
  id: string,
): { readonly identifier: string; readonly generation: number } | undefined {
  if (!id.startsWith(WORKFLOW_SCHEDULE_ID_PREFIX)) return undefined;
  const rest = id.slice(WORKFLOW_SCHEDULE_ID_PREFIX.length);
  // A plugin's identifier holds a colon (`linear:sync`), so the generation is what follows the last one.
  const match = /^(.+):(\d+)$/.exec(rest);
  if (match === null || !WORKFLOW_IDENTIFIER_PATTERN.test(match[1] as string)) return undefined;
  return { identifier: match[1] as string, generation: Number(match[2]) };
}

/** What a ready workflow file says its schedule must be. */
export interface DesiredWorkflowSchedule {
  /** The trigger's `spec`: a cron expression or a duration. */
  readonly spec: string;
  readonly overlap: ScheduleOverlapPolicy;
  readonly paused: boolean;
}

/** The trigger a fire starts the instance with. Static: a schedule's input is fixed at creation. */
export function scheduleTrigger(scheduleId: string): { kind: 'schedule'; scheduleId: string } {
  return { kind: 'schedule', scheduleId };
}

function sameCadence(summary: ScheduleSummary, wanted: NormalizedScheduleSpec): boolean {
  return wanted.kind === 'cron'
    ? summary.cronExpression === wanted.cronExpression && summary.intervalMs === undefined
    : summary.intervalMs === wanted.intervalMs && summary.cronExpression === undefined;
}

async function allWorkflowSchedules(engine: Engine): Promise<Map<string, ScheduleSummary[]>> {
  const byIdentifier = new Map<string, ScheduleSummary[]>();
  for (let offset = 0; ;) {
    const page = await engine.listSchedules({ limit: 100, offset });
    for (const summary of page.items) {
      const parsed = parseWorkflowScheduleId(summary.id);
      if (parsed === undefined) continue;
      const group = byIdentifier.get(parsed.identifier) ?? [];
      group.push(summary);
      byIdentifier.set(parsed.identifier, group);
    }
    offset += page.items.length;
    if (page.items.length === 0 || offset >= page.total) break;
  }
  return byIdentifier;
}

function generationOf(summary: ScheduleSummary): number {
  return parseWorkflowScheduleId(summary.id)?.generation ?? 0;
}

/** What a reconcile did, for the tests and the diagnostics. */
export interface ScheduleReconciliation {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly paused: readonly string[];
  readonly resumed: readonly string[];
  readonly cancelled: readonly string[];
}

/**
 * Put every Bureau workflow schedule in `engine` back to match `desired`, keyed by workflow
 * identifier: create what is missing, update a changed `spec` or `overlap`, pause or resume to match
 * `paused`, and cancel a schedule whose file is gone, invalid, or has no `schedule` trigger, along
 * with any extra live schedule of a workflow. Idempotent: a second call changes nothing.
 *
 * `unreadable` names the workflows whose file this host cannot read because it holds a key it does
 * not know, which a newer Bureau wrote (COR-1927). Their schedules are not this host's to judge, so
 * none is created, updated, paused, resumed, or cancelled: the file is neither wanting a schedule
 * nor refusing one as far as this host can tell.
 */
export async function reconcileWorkflowSchedules(
  engine: Engine,
  desired: ReadonlyMap<string, DesiredWorkflowSchedule>,
  unreadable: ReadonlySet<string> = new Set(),
): Promise<ScheduleReconciliation> {
  const created: string[] = [];
  const updated: string[] = [];
  const paused: string[] = [];
  const resumed: string[] = [];
  const cancelled: string[] = [];
  const existing = await allWorkflowSchedules(engine);

  for (const [identifier, group] of existing) {
    if (unreadable.has(identifier)) continue;
    const want = desired.get(identifier);
    const live = group
      .filter((summary) => summary.status !== 'cancelled')
      .toSorted((left, right) => generationOf(right) - generationOf(left));
    // The newest live schedule is the one that stays, and only when the file still wants one.
    const keep = want === undefined ? undefined : live[0];
    const extras = want === undefined ? live : live.slice(1);
    for (const extra of extras) {
      await engine.cancelSchedule(extra.id);
      cancelled.push(extra.id);
    }
    if (want === undefined || keep === undefined) continue;
    const wanted = normalizeScheduleSpec(toScheduleSpec(want.spec));
    if (!sameCadence(keep, wanted) || keep.overlap !== want.overlap) {
      await engine.updateSchedule(keep.id, toScheduleSpec(want.spec), { overlap: want.overlap });
      updated.push(keep.id);
    }
    if (want.paused && keep.status === 'active') {
      await engine.pauseSchedule(keep.id);
      paused.push(keep.id);
    } else if (!want.paused && keep.status === 'paused') {
      await engine.resumeSchedule(keep.id);
      resumed.push(keep.id);
    }
  }

  for (const [identifier, want] of desired) {
    if (unreadable.has(identifier)) continue;
    const group = existing.get(identifier) ?? [];
    if (group.some((summary) => summary.status !== 'cancelled')) continue;
    const generation =
      group.reduce((highest, summary) => Math.max(highest, generationOf(summary)), 0) + 1;
    const id = workflowScheduleId(identifier, generation);
    await engine.schedule(weftNameOf(identifier), scheduleTrigger(id), toScheduleSpec(want.spec), {
      id,
      overlap: want.overlap,
      description: `Workflow ${identifier}`,
    });
    created.push(id);
    if (want.paused) {
      await engine.pauseSchedule(id);
      paused.push(id);
    }
  }
  return { created, updated, paused, resumed, cancelled };
}
