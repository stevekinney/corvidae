/**
 * What the Workflows area says of a catalog row, a file's steps, and its trigger, in the words
 * `copy.ts` holds. Plain functions over data, so the badges and the labels are tested without a
 * page.
 */
import type { BadgeVariant } from '@lostgradient/cinder';

import { WORKFLOW_COPY } from '../../app/copy.ts';
import { formatRelativeTime } from '../../lib/format/index.ts';
import { workflowStatusWord, type StatusWord } from '../../lib/status.ts';
import type { CatalogRow, CodeActivity, DefinitionDetail } from '../../lib/workflow-catalog.ts';
import type { WorkflowRunCounts } from '../../lib/workflow-files.ts';
import { describeCadence } from '../schedules/cadence.ts';

/** One badge on a row: its words, its tone, and the test id of the element that carries it. */
export type RowBadge = {
  readonly label: string;
  readonly variant: BadgeVariant;
  readonly testId?: string;
};

/**
 * The badges of a row: its kind (`Code`, or `Agent-authored` for every Bureau file), and, for a
 * source, the category it failed to load with. Whether a file is invalid or paused is the row's
 * status (`workflowRowStatus`), not a badge. The agent that owns a file is an identifier, so a row
 * sets it in monospace beside the badges instead.
 */
export function rowBadges(row: CatalogRow): RowBadge[] {
  if (row.kind === 'code') return [{ label: WORKFLOW_COPY.codeBadge, variant: 'neutral' }];
  const badges: RowBadge[] = [{ label: WORKFLOW_COPY.agentAuthoredBadge, variant: 'accent' }];
  if (row.failure !== null) {
    badges.push({
      label: WORKFLOW_COPY.sourceFailed(row.failure),
      variant: 'danger',
      testId: 'workflow-failure',
    });
  }
  return badges;
}

/**
 * The status word of a row (`lib/status.ts`): Failed for a file the Bureau cannot use or a source
 * that failed to load, Paused for a paused file, Running while an instance is going, Scheduled when
 * something starts it, and `null` for a workflow with none of those.
 */
export function workflowRowStatus(
  row: CatalogRow,
  activity: CodeActivity | undefined,
): StatusWord | null {
  const runs = row.kind === 'code' ? activity?.runs : row.runs;
  const started =
    row.kind === 'code'
      ? schedulesSummary(activity?.schedules ?? null) !== null
      : triggerSummary(row.trigger) !== null;
  return workflowStatusWord({
    invalid: row.file?.state === 'invalid',
    failed: row.failure !== null,
    paused: row.file?.paused === true,
    running: runs?.active ?? 0,
    started,
  });
}

/** Which of its three states a row is in: its file cannot be used, its source failed, or neither. */
export function rowState(row: CatalogRow): 'invalid' | 'failed' | 'ready' {
  if (row.file?.state === 'invalid') return 'invalid';
  return row.failure === null ? 'ready' : 'failed';
}

type Described = { readonly kind: string; readonly [key: string]: unknown };

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One step in words. */
export function stepLabel(step: Described): string {
  switch (step.kind) {
    case 'activity': {
      const handler = text(step['handler']) ?? 'activity';
      const input = step['input'];
      if (handler === 'agent' && isRecord(input)) {
        const agent = text(input['agent']);
        const message = text(input['message']);
        if (agent !== undefined && message !== undefined) {
          return WORKFLOW_COPY.steps.agent(agent, message);
        }
      }
      return WORKFLOW_COPY.steps.activity(handler);
    }
    case 'sleep':
      return WORKFLOW_COPY.steps.sleep(text(step['duration']) ?? '');
    case 'await-signal':
      return WORKFLOW_COPY.steps.awaitSignal(text(step['signal']) ?? '');
    default:
      return WORKFLOW_COPY.steps.unknown(step.kind);
  }
}

/** A trigger in words. */
export function triggerLabel(trigger: Described): string {
  switch (trigger.kind) {
    case 'schedule':
      return WORKFLOW_COPY.triggers.schedule(
        text(trigger['spec']) ?? '',
        text(trigger['overlap']) ?? null,
      );
    case 'signal':
      return WORKFLOW_COPY.triggers.signal(text(trigger['name']) ?? '');
    default:
      return WORKFLOW_COPY.triggers.unknown(trigger.kind);
  }
}

/** A schedule's cadence in words. */
export function scheduleLabel(cadence: {
  readonly cronExpression?: string;
  readonly intervalMs?: number;
}): string {
  return describeCadence(cadence);
}

const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** The grammar the Bureau accepts for a duration `spec`: a number, then a unit or its word. */
const DURATION_SPEC =
  /^(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?|h|hours?|d|days?)$/i;

/**
 * A `schedule` trigger's `spec` as the cadence the schedules area words. The Bureau reads a
 * duration (`1h`, `30 seconds`) as an interval and everything else as a cron expression, so this
 * does too, and `describeCadence` then says it as it does for a schedule.
 */
export function specCadence(spec: string): {
  readonly cronExpression?: string;
  readonly intervalMs?: number;
} {
  const trimmed = spec.trim();
  const match = DURATION_SPEC.exec(trimmed);
  const amount = match?.[1];
  const word = match?.[2]?.toLowerCase();
  if (amount === undefined || word === undefined) return { cronExpression: trimmed };
  const scale = word === 'ms' || word.startsWith('milli') ? 1 : UNIT_MS[word.charAt(0)];
  if (scale === undefined) return { cronExpression: trimmed };
  return { intervalMs: Math.round(Number(amount) * scale) };
}

/** What starts a workflow, for a row: a cadence in words, or the signal that does. */
export type TriggerSummary =
  | { readonly kind: 'schedule'; readonly words: string }
  | { readonly kind: 'signal'; readonly name: string };

/** A file's trigger as a row says it, or `null` for a file that has none to read. */
export function triggerSummary(
  trigger: Readonly<Record<string, unknown>> | null,
): TriggerSummary | null {
  if (trigger === null) return null;
  if (trigger['kind'] === 'schedule' && typeof trigger['spec'] === 'string') {
    return { kind: 'schedule', words: describeCadence(specCadence(trigger['spec'])) };
  }
  if (trigger['kind'] === 'signal' && typeof trigger['name'] === 'string') {
    return { kind: 'signal', name: trigger['name'] };
  }
  return null;
}

/** The schedules that start a code-defined type, as a row says them: one in words, several by count. */
export function schedulesSummary(
  schedules: readonly { readonly cronExpression?: string; readonly intervalMs?: number }[] | null,
): TriggerSummary | null {
  if (schedules === null || schedules.length === 0) return null;
  const [only] = schedules;
  if (schedules.length === 1 && only !== undefined) {
    return { kind: 'schedule', words: describeCadence(only) };
  }
  return { kind: 'schedule', words: WORKFLOW_COPY.list.schedules(schedules.length) };
}

/** What the engine's contract says of a type, keeping only what it says: nothing is padded with "None". */
export type DefinitionDetails = {
  readonly signals: readonly string[];
  readonly updates: readonly string[];
  readonly queries: readonly string[];
};

/** The parts of a type's contract worth listing: its signals (passed in), updates, and queries. */
export function definitionDetails(
  definition: DefinitionDetail | undefined,
  signals: readonly string[],
): DefinitionDetails {
  return {
    signals,
    updates: definition?.updates ?? [],
    queries: definition?.queries ?? [],
  };
}

/** Whether the contract lists anything, so the facts show only what the workflow has. */
export function hasDefinitionDetails(details: DefinitionDetails): boolean {
  return details.signals.length > 0 || details.updates.length > 0 || details.queries.length > 0;
}

/**
 * The JSON Schema a workflow's input or output is held to: the file's own when it declares one,
 * else the engine's contract for the type (a code-defined type's, or the one a ready file loaded as).
 * `undefined` when neither declares one.
 */
export function schemaOf(
  declared: Readonly<Record<string, unknown>> | null | undefined,
  definition: DefinitionDetail | undefined,
  key: 'inputSchema' | 'outputSchema',
): unknown {
  if (declared !== null && declared !== undefined) return declared;
  const fromContract = definition?.contract?.[key];
  return fromContract === null ? undefined : fromContract;
}

/** What a row says of a workflow's instances: how many lately, how many are running, and the last. */
export function runCountsText(
  counts: WorkflowRunCounts,
  now: number = Date.now(),
): { readonly runs: string; readonly lastRun: string | null } {
  const lastRun =
    counts.lastRunAt === null
      ? null
      : WORKFLOW_COPY.list.lastRun(formatRelativeTime(Date.parse(counts.lastRunAt), now));
  if (counts.lastRunAt === null && counts.active === 0 && counts.last24Hours === 0) {
    return { runs: WORKFLOW_COPY.list.neverRun, lastRun };
  }
  const recent = WORKFLOW_COPY.list.runs(counts.last24Hours);
  return {
    runs: counts.active > 0 ? `${recent} ${WORKFLOW_COPY.list.running(counts.active)}` : recent,
    lastRun,
  };
}
