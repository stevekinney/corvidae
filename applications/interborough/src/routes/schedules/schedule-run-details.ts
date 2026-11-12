/**
 * What a run of a schedule says beyond its status, read for the rows of the Runs list that need
 * it (COR-2018, the runs timeline of `ScheduleDetail`): whether a person started it with Run now,
 * the step a failed run stopped at and what it said, and the step a run that is going is on. Each
 * part is read on its own, so a read that fails leaves the others, and the row says what it knows.
 */
import type { HttpClient, WorkflowTimelineEntry } from '@lostgradient/weft';
import type { QueryKey } from '@tanstack/svelte-query';

import { SCHEDULE_COPY } from '../../app/copy/schedules.ts';
import {
  getScheduleProvenance,
  type WorkflowScheduleProvenanceClient,
} from '../workflows/detail/workflow-observability.ts';

/** What the rows of the Runs list read of one run. */
export type RunDetail = {
  /** Whether a person started it with Run now rather than the cadence. */
  readonly manual: boolean;
  /** The one-based step a failed run stopped at, when the engine said. */
  readonly failedStep?: number | undefined;
  /** What the failed run said, in one line. */
  readonly message?: string | undefined;
  /** What the step a run that is going is on is called. */
  readonly currentStep?: string | undefined;
};

/** The reads a run's detail takes off the client, narrowed so a plain test fake can satisfy them. */
export type RunDetailClient = Pick<HttpClient, 'get' | 'getTimeline'> &
  WorkflowScheduleProvenanceClient;

export function runDetailQueryKey(runId: string): QueryKey {
  return ['schedules', 'run-detail', runId] as const;
}

/** The `message` of an error object, or of the `cause` it names, when it has one. */
function messageOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const cause: unknown = Reflect.get(value, 'cause');
  const inner = messageOf(cause);
  if (inner !== undefined) return inner;
  const message: unknown = Reflect.get(value, 'message');
  return typeof message === 'string' && message !== '' ? message : undefined;
}

/**
 * What a failed run said, in the few words a row has room for: the cause an agent run wraps in its
 * own message (`Agent "assistant" failed (…): {"cause":{"message":"GitHub didn’t answer (HTTP
 * 503)"}}`), without the name of the error class in front of it or the detail in parentheses
 * behind it ("GitHub didn’t answer"). The run's own page says all of it.
 */
export function oneLine(message: string): string {
  const braces = message.indexOf('{');
  let said = message;
  if (braces >= 0) {
    try {
      said = messageOf(JSON.parse(message.slice(braces))) ?? message.slice(0, braces);
    } catch {
      // What follows the brace is not JSON, so the message is read as it stands.
    }
  }
  const first = said.split('\n').find((line) => line.trim() !== '') ?? '';
  return first
    .replace(/^\s*[A-Za-z]*Error:\s*/, '')
    .replace(/\s*\([^()]*\)\s*$/, '')
    .trim();
}

function stepOf(entry: WorkflowTimelineEntry): number {
  return (entry.stepIndex ?? entry.step) + 1;
}

/** Reads what the rows of the Runs list say of one run. */
export async function fetchRunDetail(client: RunDetailClient, runId: string): Promise<RunDetail> {
  const [provenance, state, timeline] = await Promise.allSettled([
    getScheduleProvenance(client, runId),
    client.get(runId),
    client.getTimeline(runId),
  ]);
  const manual = provenance.status === 'fulfilled' && provenance.value?.manual === true;
  const entries = timeline.status === 'fulfilled' ? timeline.value : [];
  const error = state.status === 'fulfilled' ? (state.value?.error ?? undefined) : undefined;
  const failed = entries.findLast((entry) => entry.status === 'failed');
  const going = entries.findLast((entry) => entry.status === 'running');
  return {
    manual,
    ...(failed === undefined ? {} : { failedStep: stepOf(failed) }),
    ...(error === undefined || error === '' ? {} : { message: oneLine(error) }),
    ...(going === undefined ? {} : { currentStep: going.operationLabel }),
  };
}

/**
 * The second line of a run's row: how it started and where it is or where it stopped, joined by
 * commas ("Started with Run now, Collecting merged changes", "Failed at step 2, GitHub didn't
 * answer"). A run that went as the cadence says and finished well has nothing to add.
 */
export function runDetailLine(
  detail: RunDetail | undefined,
  status: 'running' | 'failed' | 'other',
): string | undefined {
  if (detail === undefined) return undefined;
  const parts: string[] = [];
  if (detail.manual) parts.push(SCHEDULE_COPY.detail.runs.startedWith(SCHEDULE_COPY.detail.runNow));
  if (status === 'running' && detail.currentStep !== undefined) parts.push(detail.currentStep);
  if (status === 'failed') {
    if (detail.failedStep !== undefined) {
      parts.push(SCHEDULE_COPY.detail.runs.failedAtStep(detail.failedStep));
    }
    if (detail.message !== undefined) parts.push(detail.message);
  }
  return parts.length === 0 ? undefined : parts.join(', ');
}
