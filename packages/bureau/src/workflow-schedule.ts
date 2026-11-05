import { readRunWorkspaceAuthority, type RunWorkspaceAuthority } from 'armorer';
import type { WorkspaceRuntimeAuthority } from './http/workspace-principal.ts';
import { captureRunWorkspaceAuthority, validateRunWorkspaceAuthority } from './run-authority.ts';
/**
 * The native schedule a workflow file with a `schedule` trigger owns (COR-1527). The file is the
 * only source of truth: every scan and every startup puts the schedule back to match it. A file
 * that stops parsing keeps the schedule its last good version made, held so it starts nothing
 * until the file parses again (COR-2009, `workflow-schedule-holds.ts`).
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

import { isDeepStrictEqual } from 'node:util';

import {
  decode,
  type Engine,
  KEYS,
  normalizeScheduleSpec,
  type NormalizedScheduleSpec,
  type ScheduleSummary,
} from '@lostgradient/weft';

import { toScheduleSpec } from './schedule-spec';
import { weftNameOf } from './namespaced-identifier';
import { WORKFLOW_IDENTIFIER_PATTERN } from './workflow-file';
import type { ScheduleOverlapPolicy } from './workflow-host';
import type { WorkflowScheduleHolds } from './workflow-schedule-holds';

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
  /** The IANA zone a cron `spec` is read in: the trigger's `timezone`, or `UTC` when it has none. */
  readonly timeZone: string;
  /** Whether runs missed while the host was off are caught up: the trigger's `catchUp`, Weft's `backfill`. */
  readonly backfill: boolean;
  /**
   * The schedule's display name, which Weft keeps as its `description`: the trigger's `name`. When
   * it is absent the schedule is described as {@link defaultWorkflowScheduleDescription} says.
   */
  readonly description?: string | undefined;
  /**
   * The fixed value every fire starts its instance with: the trigger's `input`. When it is absent a
   * fire starts with `null`. Weft fixes a schedule's input when it is created, so a changed one
   * replaces the schedule with the next generation.
   */
  readonly input?: unknown;
  readonly paused: boolean;
}

/** The `description` of the schedule of workflow `identifier` whose trigger gives no `name`. */
export function defaultWorkflowScheduleDescription(identifier: string): string {
  return `Workflow ${identifier}`;
}

/** The zone a schedule whose trigger names none runs in, which is Weft's default. */
export const DEFAULT_WORKFLOW_SCHEDULE_TIME_ZONE = 'UTC';

/** The trigger a fire starts its instance with: Weft fixes a schedule's input when it is created. */
export interface WorkflowScheduleTrigger {
  readonly workspaceAuthority?: RunWorkspaceAuthority;
  readonly authorityHold?: 'revoked' | 'reassigned' | 'resuming';
  readonly kind: 'schedule';
  /** The schedule that fired. */
  readonly scheduleId: string;
  /** The file trigger's `input` (COR-2009), present only when the trigger gives one. */
  readonly input?: unknown;
}

/**
 * The trigger a fire of `scheduleId` starts the instance with, carrying `input` when the file's
 * trigger gives one. Static: a schedule's input is fixed at creation.
 */
export function scheduleTrigger(
  scheduleId: string,
  input?: unknown,
  binding: Pick<WorkflowScheduleTrigger, 'workspaceAuthority' | 'authorityHold'> = {},
): WorkflowScheduleTrigger {
  return { kind: 'schedule', scheduleId, ...(input === undefined ? {} : { input }), ...binding };
}

/** Read only the host-owned authority portion; malformed persisted records fail closed. */
export function workflowScheduleBinding(
  input: unknown,
): Pick<WorkflowScheduleTrigger, 'workspaceAuthority' | 'authorityHold'> {
  if (typeof input !== 'object' || input === null) return {};
  const value: unknown = Reflect.get(input, 'workspaceAuthority');
  const hold: unknown = Reflect.get(input, 'authorityHold');
  const workspaceAuthority = readRunWorkspaceAuthority(value);
  if (
    (value !== undefined && workspaceAuthority === undefined) ||
    (hold !== undefined && hold !== 'revoked' && hold !== 'reassigned' && hold !== 'resuming')
  )
    throw new Error('Invalid workflow schedule authority');
  return {
    ...(workspaceAuthority === undefined ? {} : { workspaceAuthority }),
    ...(hold === undefined ? {} : { authorityHold: hold }),
  };
}

/** The `description` the schedule of workflow `identifier` carries when `want` is its file's. */
function descriptionOf(identifier: string, want: DesiredWorkflowSchedule): string {
  return want.description ?? defaultWorkflowScheduleDescription(identifier);
}

/**
 * The Weft options for `want`, the file of workflow `identifier`: its description, overlap and
 * backfill, and its zone when the spec is a cron one.
 */
function scheduleOptionsOf(
  identifier: string,
  want: DesiredWorkflowSchedule,
): {
  description: string;
  overlap: ScheduleOverlapPolicy;
  backfill: boolean;
  timeZone?: string;
} {
  // Weft refuses a zone for an interval, which counts elapsed time.
  const cron = 'cron' in toScheduleSpec(want.spec);
  return {
    description: descriptionOf(identifier, want),
    overlap: want.overlap,
    backfill: want.backfill,
    ...(cron ? { timeZone: want.timeZone } : {}),
  };
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

/**
 * The input schedule `scheduleId` starts each fire with, read from its stored state: Weft's
 * `getSchedule` answers a summary, which leaves the input out. `undefined` when nothing is stored.
 */
export async function storedScheduleInput(
  engine: Pick<Engine, 'storage'>,
  scheduleId: string,
): Promise<unknown> {
  const bytes = await engine.storage.get(KEYS.schedule(scheduleId));
  if (bytes === null || bytes === undefined) return undefined;
  const state: unknown = decode(bytes);
  return typeof state === 'object' && state !== null
    ? (state as { readonly input?: unknown }).input
    : undefined;
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
  /** The schedules held because their workflow file stopped parsing (paused, and recorded). */
  readonly held: readonly string[];
}

/**
 * The workflows whose file is there but does not parse (COR-2009), and where a hold is recorded.
 * Their schedules are kept from the last good version and held: see `workflow-schedule-holds.ts`.
 */
export interface BrokenWorkflowFiles {
  readonly workspace?: WorkspaceRuntimeAuthority | undefined;
  /** The identifiers whose file has a problem other than a key this host does not know. */
  readonly broken: ReadonlySet<string>;
  /** The hold records. */
  readonly holds: WorkflowScheduleHolds;
}

/**
 * Put every Bureau workflow schedule in `engine` back to match `desired`, keyed by workflow
 * identifier: create what is missing, update a changed `spec`, `overlap`, `timeZone`, `backfill`, or
 * `description`, pause or resume to match `paused`, and cancel a schedule whose file is gone or
 * has no `schedule` trigger, along with any extra live schedule of a workflow. A file that no
 * longer parses keeps its schedule, held (`files` below), when the caller names it. A
 * changed `input` cannot be updated, because Weft fixes a schedule's input when it is created, so
 * the schedule is cancelled and the next generation created with the new one. Idempotent: a second
 * call changes nothing.
 *
 * `unreadable` names the workflows whose file this host cannot read because it holds a key it does
 * not know, which a newer Bureau wrote (COR-1927). Their schedules are not this host's to judge, so
 * none is created, updated, paused, resumed, or cancelled: the file is neither wanting a schedule
 * nor refusing one as far as this host can tell.
 *
 * `files.broken` names the workflows whose file is there but does not parse (COR-2009). Their
 * schedule is the one the last good version made, so it is kept: never cancelled, created, or
 * updated. An active one is held: the hold is recorded, then the schedule paused, so it starts
 * nothing until the file parses again. Once it does, the file wants its schedule again and the
 * paused schedule is resumed as any other is, and the hold record goes.
 */
export async function reconcileWorkflowSchedules(
  engine: Engine,
  desired: ReadonlyMap<string, DesiredWorkflowSchedule>,
  unreadable: ReadonlySet<string> = new Set(),
  files?: BrokenWorkflowFiles,
): Promise<ScheduleReconciliation> {
  const created: string[] = [];
  const held: string[] = [];
  const updated: string[] = [];
  const paused: string[] = [];
  const resumed: string[] = [];
  const cancelled: string[] = [];
  const existing = await allWorkflowSchedules(engine);
  const bindings = new Map<
    string,
    Pick<WorkflowScheduleTrigger, 'workspaceAuthority' | 'authorityHold'>
  >();
  {
    for (const identifier of desired.keys()) {
      const latest = existing
        .get(identifier)
        ?.toSorted((left, right) => generationOf(right) - generationOf(left))[0];
      const binding = workflowScheduleBinding(
        latest === undefined ? undefined : await storedScheduleInput(engine, latest.id),
      );
      if (files?.workspace === undefined) {
        bindings.set(identifier, binding);
        continue;
      }
      const authority =
        binding.workspaceAuthority ??
        (await captureRunWorkspaceAuthority(files.workspace, 'anonymous:local'));
      const current = await validateRunWorkspaceAuthority(files.workspace, authority);
      bindings.set(identifier, {
        ...binding,
        ...(authority === undefined ? {} : { workspaceAuthority: authority }),
        ...(current === undefined ? { authorityHold: 'revoked' as const } : {}),
      });
    }
  }
  /** Workflows whose live schedule was cancelled for a changed `input`, to be created again below. */
  const replaced = new Set<string>();

  for (const [identifier, group] of existing) {
    if (unreadable.has(identifier)) continue;
    const want = desired.get(identifier);
    const live = group
      .filter((summary) => summary.status !== 'cancelled')
      .toSorted((left, right) => generationOf(right) - generationOf(left));
    if (files?.broken.has(identifier) === true) {
      const kept = live[0];
      if (kept?.status === 'active') {
        // Recorded first: a pause with no record would read as the file's own `paused`.
        await files.holds.hold(identifier, kept.id);
        await engine.pauseSchedule(kept.id);
        paused.push(kept.id);
        held.push(kept.id);
      }
      continue;
    }
    // The file parses again, or is gone: a hold, if there was one, is over. The paused schedule is
    // resumed below when the file wants it active, and cancelled when the file no longer wants it.
    if (files !== undefined && (await files.holds.held(identifier)) !== undefined) {
      await files.holds.release(identifier);
    }
    // The newest live schedule is the one that stays, and only when the file still wants one.
    let keep = want === undefined ? undefined : live[0];
    const extras = want === undefined ? live : live.slice(1);
    for (const extra of extras) {
      await engine.cancelSchedule(extra.id, { expectedRevision: extra.revision });
      cancelled.push(extra.id);
    }
    if (want === undefined || keep === undefined) continue;
    let storedInput = await storedScheduleInput(engine, keep.id);
    const binding = bindings.get(identifier) ?? workflowScheduleBinding(storedInput);
    if (
      !isDeepStrictEqual(workflowScheduleBinding(storedInput), binding) ||
      (binding.authorityHold !== undefined && keep.status === 'active')
    ) {
      const heldInput = {
        ...(typeof storedInput === 'object' && storedInput !== null ? storedInput : {}),
        ...binding,
      };
      await engine.replaceScheduleInput(keep.id, heldInput, {
        expectedRevision: keep.revision,
        status:
          binding.authorityHold === undefined && keep.status === 'active' ? 'active' : 'paused',
      });
      storedInput = heldInput;
      keep = (await engine.getSchedule(keep.id))!;
      paused.push(keep.id);
    }
    const compared =
      typeof storedInput === 'object' && storedInput !== null
        ? { ...storedInput, ...binding }
        : storedInput;
    if (!isDeepStrictEqual(compared, scheduleTrigger(keep.id, want.input, binding))) {
      await engine.cancelSchedule(keep.id, { expectedRevision: keep.revision });
      cancelled.push(keep.id);
      replaced.add(identifier);
      continue;
    }
    const wanted = normalizeScheduleSpec(toScheduleSpec(want.spec));
    if (
      !sameCadence(keep, wanted) ||
      keep.overlap !== want.overlap ||
      keep.backfill !== want.backfill ||
      keep.description !== descriptionOf(identifier, want) ||
      (wanted.kind === 'cron' && keep.timeZone !== want.timeZone)
    ) {
      await engine.updateSchedule(keep.id, toScheduleSpec(want.spec), {
        ...scheduleOptionsOf(identifier, want),
        expectedRevision: keep.revision,
      });
      updated.push(keep.id);
      keep = (await engine.getSchedule(keep.id))!;
    }
    if ((want.paused || binding.authorityHold !== undefined) && keep.status === 'active') {
      await engine.pauseSchedule(keep.id, { expectedRevision: keep.revision });
      paused.push(keep.id);
    } else if (!want.paused && binding.authorityHold === undefined && keep.status === 'paused') {
      await engine.resumeSchedule(keep.id, { expectedRevision: keep.revision });
      resumed.push(keep.id);
    }
  }

  for (const [identifier, want] of desired) {
    if (unreadable.has(identifier)) continue;
    const group = existing.get(identifier) ?? [];
    if (!replaced.has(identifier) && group.some((summary) => summary.status !== 'cancelled')) {
      continue;
    }
    const generation =
      group.reduce((highest, summary) => Math.max(highest, generationOf(summary)), 0) + 1;
    const id = workflowScheduleId(identifier, generation);
    await engine.schedule(
      weftNameOf(identifier),
      scheduleTrigger(id, want.input, bindings.get(identifier)),
      toScheduleSpec(want.spec),
      {
        id,
        ...scheduleOptionsOf(identifier, want),
        initialStatus:
          want.paused || bindings.get(identifier)?.authorityHold !== undefined
            ? 'paused'
            : 'active',
      },
    );
    created.push(id);
    if (want.paused || bindings.get(identifier)?.authorityHold !== undefined) {
      paused.push(id);
    }
  }
  return { created, updated, paused, resumed, cancelled, held };
}
