/**
 * What a row of the Schedules list says, worked out from what the engine and the Bureau say of a
 * schedule, with no DOM in it. A row is a status word, a title, the next run, and a line that is
 * kind first: `Workflow · Chat with an agent · Assistant · Every day at 3:00 AM (9:00 AM UTC) ·
 * Last run Oct 29`. A reason the schedule will not start comes straight after the kind and the
 * cadence comes after it, so when the line is too long for its row the cadence is what is cut,
 * never the reason. On a phone the status moves to line two beside the kind, and a third line says
 * the reason, what happened last, and the cadence last, wrapping instead of being cut.
 *
 * Three things keep a schedule from starting, and the row says the first that applies: its
 * workflow's file cannot load, its workflow was deleted, or no model provider is connected and an
 * agent it runs needs a model. Assistant and Echo are scripted and need none, so a schedule that
 * runs only them is never blocked by a provider. A schedule's status is one word: Can't find
 * workflow (it cannot run at all), Paused, Missed runs · N (it missed occurrences and has not fired
 * since), or Active.
 */
import {
  formatDate,
  formatDateTime,
  formatTimeOfDay,
  humanizeIdentifier,
  type StatusDotWordLabel,
} from '@lostgradient/cinder';

import type { ScheduleSummary } from '@lostgradient/weft';

import { agentLabel } from '../../lib/agent-label.ts';
import type { ScheduleAttention } from '../../lib/bureau-attention.ts';
import type { AgentSummary } from '../../lib/bureau-client.ts';
import {
  AGENT_RUN_TYPE,
  kindOf,
  type ScheduleKind,
  type ScheduleOverlay,
} from '../../lib/schedule-kinds.ts';
import type { WorkflowFileListing } from '../../lib/workflow-files.ts';
import { cadenceText } from './schedule-cadence-text.ts';
import { scheduleName } from './schedule-presentation.ts';

/** A run of words in one style: plain, an identifier in monospace, or a reason in a tone. */
export type RowPart = {
  readonly text: string;
  /** `danger` is a workflow that cannot load; `warning` is a schedule that will not start. */
  readonly tone?: 'danger' | 'warning';
  /** An identifier (a workflow's file name), set small and monospaced. */
  readonly monospace?: boolean;
};

/** One thing a line says, which the line joins to the next with a middle dot. */
export type RowSegment = readonly RowPart[];

/** The reason a schedule will not start. */
export type RowBlocker =
  /** The workflow's file cannot load: the file is the problem. */
  | { readonly kind: 'cannot-load'; readonly workflowType: string; readonly label: string }
  /** The workflow's file is gone, and nothing else defines it. */
  | { readonly kind: 'deleted'; readonly workflowType: string }
  /** An agent it runs needs a model and none is connected. */
  | { readonly kind: 'provider' };

/** The one word a schedule's status reads as. */
export type RowStatusKey = 'active' | 'missed' | 'paused' | 'cannot-find';

/** Everything a row of the list needs to draw itself, in the forms of both widths. */
export type ScheduleRow = {
  readonly id: string;
  readonly schedule: ScheduleSummary;
  /**
   * The schedule's status as the Bureau reads it, which the segments count by. It differs from the
   * engine's for a schedule held because its workflow's file cannot load: the engine holds it
   * paused and it is still the Active schedule it was.
   */
  readonly status: 'active' | 'paused' | 'cancelled';
  readonly kind: ScheduleKind;
  readonly title: string;
  /** The status word as the row shows it: `Missed runs · 4`, `Active`, `Paused`, `Can't find workflow`. */
  readonly statusWord: StatusDotWordLabel;
  readonly statusKey: RowStatusKey;
  /** How many occurrences it missed and has not caught up on: 0 for a schedule that did not. */
  readonly missedCount: number;
  /** The first occurrence it missed, in milliseconds, when the Bureau said. */
  readonly missedSince: number | undefined;
  readonly blockers: readonly RowBlocker[];
  /**
   * Every reason it will not start, not only the first: the workflow's file that cannot load and
   * the missing provider are both said on the schedule's own page, in that order.
   */
  readonly allBlockers: readonly RowBlocker[];
  /** The agents the schedule runs, by identifier. */
  readonly agentIds: readonly string[];
  /** The workflow type it starts, which the Workflow filter reads. */
  readonly workflowType: string;
  /** What the workflow is called where a person reads it: "Chat with an agent", "Release notes". */
  readonly workflowLabel: string;
  /** The next run as the right of line one says it. */
  readonly next: { readonly text: string; readonly tone?: 'warning' };
  /** The next run on a phone, where a schedule with none says only a dash. */
  readonly nextPhone: { readonly text: string; readonly tone?: 'warning' };
  /**
   * Line two before its tail: the kind, the workflow (with the reason it will not start), the
   * agents or where the schedule is defined, and the cadence. The last run follows it.
   */
  readonly lineTwo: readonly RowSegment[];
  /** Line two on a phone: the kind, the workflow and the agents, after the status. */
  readonly phoneLineTwo: readonly RowSegment[];
  /** The phone's third line before the last run: the reasons and what happened. */
  readonly phoneLineThree: readonly RowSegment[];
  /** The cadence, the last thing the phone's third line says. */
  readonly phoneCadence: string;
  /** When it last fired, in milliseconds. */
  readonly lastFireAt: number | undefined;
};

/** What the rows are made from, each source as far as it answered. */
export type ScheduleRowContext = {
  readonly overlay: ScheduleOverlay | undefined;
  /** The agents the Bureau lists, with the display name of each and whether it names a model. */
  readonly agents: readonly AgentSummary[] | undefined;
  /** Who missed runs and whether a provider is connected, or `undefined` when the Bureau did not say. */
  readonly attention: ScheduleAttention | undefined;
  /** The workflow types the engine can run, or `undefined` when it did not say. */
  readonly definitionNames: ReadonlySet<string> | undefined;
  /**
   * The agents that name a model, so the schedules that run one wait for a provider, or
   * `undefined` before that is read: the catalog's `media` stands in, which is empty for a model
   * no provider serves.
   */
  readonly modelAgents?: ReadonlySet<string> | undefined;
  /** The agents each workflow type runs, by type, from its file's steps or its last saved version. */
  readonly workflowAgents: ReadonlyMap<string, readonly string[]>;
  /** The clock the next fire is counted from. */
  readonly now: number;
};

/** The agents the steps of a workflow run, in the order they first appear, each once. */
export function agentsOfSteps(
  steps: readonly Readonly<Record<string, unknown>>[] | null | undefined,
): string[] {
  const found: string[] = [];
  for (const step of steps ?? []) {
    if (step['handler'] !== 'agent') continue;
    const input: unknown = step['input'];
    if (typeof input !== 'object' || input === null) continue;
    const agent: unknown = Reflect.get(input, 'agent');
    if (typeof agent === 'string' && !found.includes(agent)) found.push(agent);
  }
  return found;
}

/** The workflow types whose agents are not in a ready file's steps, so the last saved version must say. */
export function typesNeedingSavedSteps(
  schedules: readonly ScheduleSummary[],
  context: Pick<ScheduleRowContext, 'overlay' | 'definitionNames'>,
): string[] {
  const types = new Set<string>();
  for (const schedule of schedules) {
    if (schedule.workflowType === AGENT_RUN_TYPE) continue;
    const file = context.overlay?.files?.get(schedule.workflowType);
    if (file === undefined ? isDeleted(schedule.workflowType, context) : file.state === 'invalid') {
      types.add(schedule.workflowType);
    }
  }
  return [...types].toSorted();
}

/** Whether the engine and the Bureau both answered and neither defines the type: its workflow was deleted. */
function isDeleted(
  type: string,
  context: Pick<ScheduleRowContext, 'overlay' | 'definitionNames'>,
): boolean {
  if (type === AGENT_RUN_TYPE) return false;
  const files = context.overlay?.files;
  if (files === undefined || context.definitionNames === undefined) return false;
  return !files.has(type) && !context.definitionNames.has(type);
}

function workflowNameOf(type: string, file: WorkflowFileListing | undefined): string {
  return file?.title ?? humanizeIdentifier(type, { casing: 'sentence' });
}

function needsModel(agentId: string, context: ScheduleRowContext): boolean {
  if (context.modelAgents !== undefined) return context.modelAgents.has(agentId);
  const agent = context.agents?.find((candidate) => candidate.name === agentId);
  return agent !== undefined && agent.media !== null;
}

function missedOf(
  schedule: ScheduleSummary,
  attention: ScheduleAttention | undefined,
): { count: number; since: number | undefined } {
  if (attention !== undefined) {
    const missed = attention.missedRuns.get(schedule.id);
    return missed === undefined ? { count: 0, since: undefined } : missed;
  }
  // Without the Bureau's list, a schedule that missed occurrences and has not fired since.
  const missedSinceFire =
    schedule.lastFireAt === undefined || (schedule.lastMissedFireAt ?? 0) > schedule.lastFireAt;
  return schedule.missedFireCount > 0 && missedSinceFire
    ? { count: schedule.missedFireCount, since: undefined }
    : { count: 0, since: undefined };
}

/** What a schedule whose agent needs a model says while no provider is connected. */
const PROVIDER_REASON: RowSegment = [{ text: 'won’t run until a provider is connected' }];

function shortDate(at: number): string {
  return formatDate(at, 'en-US', { month: 'short', day: 'numeric' });
}

function nextText(
  schedule: ScheduleSummary,
  status: 'active' | 'paused' | 'cancelled',
  blocked: boolean,
  now: number,
): { text: string; tone?: 'warning' } {
  if (status !== 'active' || schedule.nextFireAt === null) {
    return { text: 'No next run' };
  }
  const at = schedule.nextFireAt;
  const today = formatDateTime(at, { dayWords: 'today', now }).startsWith('Today, ');
  const when = today
    ? `today ${formatTimeOfDay(at)}`
    : formatDateTime(at, { dayWords: false, now });
  if (blocked) {
    const due = today ? `today, ${formatTimeOfDay(at)}` : when;
    return { text: `Due ${due} · won’t start`, tone: 'warning' };
  }
  return { text: `Next ${when}` };
}

/** The row of one schedule. */
export function scheduleRowOf(schedule: ScheduleSummary, context: ScheduleRowContext): ScheduleRow {
  const kind = kindOf(schedule, context.overlay);
  const type = schedule.workflowType;
  const isAgentRun = type === AGENT_RUN_TYPE;
  const file = context.overlay?.files?.get(type);
  const deleted = isDeleted(type, context);
  const status = context.overlay?.statuses?.get(schedule.id) ?? schedule.status;
  const cannotLoad =
    !isAgentRun &&
    (context.overlay?.blockers?.has(schedule.id) === true || file?.state === 'invalid');

  const agentIds = isAgentRun
    ? kind.kind === 'agent-run' && kind.agentName !== null
      ? [kind.agentName]
      : []
    : (context.workflowAgents.get(type) ?? agentsOfSteps(file?.steps));
  const workflowLabel = isAgentRun ? 'Chat with an agent' : workflowNameOf(type, file);

  const blockers: RowBlocker[] = [];
  if (cannotLoad) {
    blockers.push({ kind: 'cannot-load', workflowType: type, label: workflowLabel });
  } else if (deleted) {
    blockers.push({ kind: 'deleted', workflowType: type });
  }
  const modelAgent = agentIds.some((id) => needsModel(id, context));
  if (context.attention?.noProvider === true && modelAgent && blockers.length === 0) {
    blockers.push({ kind: 'provider' });
  }
  // The provider reason is the second on the schedule's own page and a phone's third line.
  const phoneBlockers: RowBlocker[] = [...blockers];
  if (
    context.attention?.noProvider === true &&
    modelAgent &&
    !phoneBlockers.some((blocker) => blocker.kind === 'provider')
  ) {
    phoneBlockers.push({ kind: 'provider' });
  }

  const missed = missedOf(schedule, context.attention);
  const statusKey: RowStatusKey = deleted
    ? 'cannot-find'
    : status === 'paused'
      ? 'paused'
      : missed.count > 0
        ? 'missed'
        : 'active';
  const statusWord: StatusDotWordLabel =
    statusKey === 'cannot-find'
      ? "Can't find workflow"
      : statusKey === 'paused'
        ? 'Paused'
        : statusKey === 'missed'
          ? `Missed runs · ${String(missed.count)}`
          : 'Active';

  const cadence = cadenceText(schedule, context.now);
  const agentNames = agentIds.map((id) => agentLabel(id, context.agents));
  const fileDefined = kind.kind === 'workflow-file';
  // A file's schedule that carries fixed input is "From a workflow file": the file decides what
  // each run is fed, so the line says where the schedule is defined instead of the agent, after the
  // cadence (row 70k).
  const fixedInput =
    fileDefined &&
    file?.trigger != null &&
    'input' in file.trigger &&
    file.trigger['input'] != null;
  const definedInFile: RowSegment = [{ text: 'From a workflow file' }];
  const whoRuns: RowSegment[] =
    !fixedInput && agentNames.length > 0 ? [[{ text: agentNames.join(', ') }]] : [];

  const workflowSegment: RowSegment = cannotLoad
    ? [
        { text: type, monospace: true },
        { text: ' can’t load', tone: 'danger' },
      ]
    : deleted
      ? [{ text: type, monospace: true }, { text: ' was deleted' }]
      : [{ text: workflowLabel }];
  const lineTwo: RowSegment[] = [
    [{ text: 'Workflow' }],
    workflowSegment,
    ...(blockers.some((blocker) => blocker.kind === 'provider') ? [PROVIDER_REASON] : []),
    ...whoRuns,
    [{ text: cadence.full }],
    ...(fixedInput ? [definedInFile] : []),
  ];

  const phoneWorkflow: RowSegment = [{ text: workflowLabel }];
  const phoneLineTwo: RowSegment[] = [
    [{ text: 'Workflow' }],
    phoneWorkflow,
    ...(fixedInput ? [definedInFile] : whoRuns),
  ];

  const reasonSegments: RowSegment[] = phoneBlockers.map((blocker) => {
    switch (blocker.kind) {
      case 'cannot-load':
        return [{ text: `${blocker.label} can’t load`, tone: 'danger' }];
      case 'deleted':
        return [{ text: `${blocker.workflowType} was deleted` }];
      case 'provider':
        return PROVIDER_REASON;
    }
  });
  const phoneLineThree: RowSegment[] = [...reasonSegments];
  if (missed.count > 0 && statusKey === 'missed') {
    const since = missed.since === undefined ? '' : ` since ${shortDate(missed.since)}`;
    phoneLineThree.push([{ text: `Missed ${String(missed.count)} times${since}` }]);
  }

  const blocked = blockers.length > 0;
  const next = nextText(schedule, status, blocked, context.now);
  return {
    id: schedule.id,
    schedule,
    status,
    kind,
    title: scheduleName(schedule, kind),
    statusWord,
    statusKey,
    missedCount: missed.count,
    missedSince: missed.since,
    blockers,
    allBlockers: phoneBlockers,
    agentIds,
    workflowType: type,
    workflowLabel,
    next,
    nextPhone:
      next.text === 'No next run' ? { text: '—' } : nextText(schedule, status, false, context.now),
    lineTwo,
    phoneLineTwo,
    phoneLineThree,
    phoneCadence: cadence.phone,
    lastFireAt: schedule.lastFireAt,
  };
}

/**
 * The rows in the order the list shows them: a schedule that missed runs first, then the active
 * ones soonest first, then the paused ones and those that cannot run, each group by its name.
 */
export function sortScheduleRows(rows: readonly ScheduleRow[]): ScheduleRow[] {
  const group = (row: ScheduleRow): number =>
    row.statusKey === 'missed' ? 0 : row.statusKey === 'active' ? 1 : 2;
  return rows.toSorted((a, b) => {
    const byGroup = group(a) - group(b);
    if (byGroup !== 0) return byGroup;
    const aNext = a.schedule.nextFireAt ?? Number.POSITIVE_INFINITY;
    const bNext = b.schedule.nextFireAt ?? Number.POSITIVE_INFINITY;
    if (aNext !== bNext) return aNext < bNext ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}
