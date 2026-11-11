import type { ApprovalState } from '@lostgradient/cinder';
import { stringify } from '../../../utilities/stringify.ts';
import { toolResultText } from '../../../utilities/tool-result-text.ts';
import type { ToolCallPair } from '../conversation-model.ts';

/**
 * Where one tool call stands, as the quiet timeline shows it. `expired` is an approval whose
 * deadline passed before anyone decided it (COR-2280): it no longer waits.
 */
export type ToolCallRowStatus =
  'pending' | 'succeeded' | 'failed' | 'denied' | 'expired' | 'waiting' | 'waiting-input';

const STATUS_TEXT: Record<ToolCallRowStatus, string> = {
  pending: 'Pending',
  succeeded: 'Complete',
  failed: 'Failed',
  denied: 'Denied',
  expired: 'Expired',
  waiting: 'Waiting for approval',
  'waiting-input': 'Waiting for input',
};

/**
 * When a waiting approval's deadline passes, in epoch milliseconds: its action's `expiresAt`, read
 * as Cinder's ApprovalCard reads it, so the card and the summary agree. `undefined` for a call that
 * is not waiting on an approval, and for a deadline that is not a valid instant.
 */
export function toolCallApprovalDeadline(pair: ToolCallPair): number | undefined {
  const result = pair.result;
  if (result?.outcome !== 'action_required' || result.action?.type !== 'approval') return undefined;
  const expiresAt = result.action.expiresAt;
  if (expiresAt === undefined || expiresAt === '') return undefined;
  const deadline = Date.parse(expiresAt);
  return Number.isFinite(deadline) ? deadline : undefined;
}

/**
 * The next deadline still ahead of `now` among the calls that wait on an approval nobody settled,
 * so the timeline wakes once, when the next of them expires, without a host update. `undefined`
 * when none waits on a deadline ahead.
 */
export function nextToolCallApprovalDeadline(
  pairs: readonly ToolCallPair[],
  approvalStates: ReadonlyMap<string, ApprovalState> | undefined,
  now: number,
): number | undefined {
  let next: number | undefined;
  for (const pair of pairs) {
    const state = approvalStates?.get(pair.call.id);
    if (state !== undefined && state !== 'pending') continue;
    const deadline = toolCallApprovalDeadline(pair);
    if (deadline === undefined || deadline <= now) continue;
    if (next === undefined || deadline < next) next = deadline;
  }
  return next;
}

const ONE_LINE_LIMIT = 80;

/**
 * A call's status. A denied approval reads `denied`, never `failed`, whether
 * the run reports the denial as the pending approval or as an error result.
 * An approval nobody settled reads `expired` from its deadline on, measured
 * against `now` (COR-2280); a state the host settled wins over the deadline.
 */
export function toolCallRowStatus(
  pair: ToolCallPair,
  approvalState: ApprovalState | undefined,
  now: number = Date.now(),
): ToolCallRowStatus {
  if (approvalState === 'denied') return 'denied';
  if (approvalState === 'expired') return 'expired';
  const outcome = pair.result?.outcome;
  if (outcome === 'error') return 'failed';
  if (outcome === 'action_required') {
    if (pair.result?.action?.type !== 'approval') return 'waiting-input';
    if (approvalState !== undefined && approvalState !== 'pending') return 'waiting';
    const deadline = toolCallApprovalDeadline(pair);
    return deadline !== undefined && now >= deadline ? 'expired' : 'waiting';
  }
  if (outcome === 'success') return 'succeeded';
  return 'pending';
}

/** The word a status reads as, for the row and the live announcement. */
export function toolCallStatusText(status: ToolCallRowStatus): string {
  return STATUS_TEXT[status];
}

/** Whether a call should start expanded: failures and denials stay open. */
export function isProblemStatus(status: ToolCallRowStatus): boolean {
  return status === 'failed' || status === 'denied';
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > ONE_LINE_LIMIT
    ? `${collapsed.slice(0, ONE_LINE_LIMIT - 1)}…`
    : collapsed;
}

/** The first scalar argument, which usually names what the call acted on. */
export function toolCallKeyArgument(argumentsValue: unknown): string | undefined {
  if (typeof argumentsValue === 'string') return oneLine(argumentsValue) || undefined;
  if (typeof argumentsValue !== 'object' || argumentsValue === null) return undefined;
  for (const value of Object.values(argumentsValue)) {
    if (typeof value === 'string' && value.trim() !== '') return oneLine(value);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return undefined;
}

/** A one-line reading of the call's result or error, when it has one. */
export function toolCallResultLine(pair: ToolCallPair): string | undefined {
  const result = pair.result;
  if (!result) return undefined;
  if (result.outcome === 'error') {
    return oneLine(result.error?.message ?? stringify(result.content));
  }
  // An approval row asks for itself; any other request keeps its prompt here.
  if (result.outcome === 'action_required') {
    if (result.action?.type === 'approval' || result.action?.message === undefined)
      return undefined;
    return oneLine(result.action.message);
  }
  const text =
    result.parts !== undefined
      ? toolResultText(result)
      : typeof result.content === 'string'
        ? result.content
        : result.content === undefined
          ? ''
          : stringify(result.content);
  return oneLine(text) || undefined;
}

/** Formats a duration in milliseconds as `0.4s`, `12s`, or `1m 5s`. */
export function formatToolCallDuration(milliseconds: number): string {
  if (milliseconds < 10_000) return `${(Math.max(0, milliseconds) / 1000).toFixed(1)}s`;
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** The tool names in first-use order, with a count when a tool ran more than once. */
function toolNamesSegment(pairs: readonly ToolCallPair[]): string {
  const counts = new Map<string, number>();
  for (const pair of pairs) counts.set(pair.call.name, (counts.get(pair.call.name) ?? 0) + 1);
  return Array.from(counts, ([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(', ');
}

/**
 * The summary line's segments after "Used N tools": the tools, then any
 * failed, denied, expired, or waiting counts, then the total time when every
 * call has one. An expired approval counts as expired and never as waiting.
 */
export function toolCallSummarySegments(
  pairs: readonly ToolCallPair[],
  statuses: readonly ToolCallRowStatus[],
  durations: readonly (number | undefined)[],
): string[] {
  const segments = [toolNamesSegment(pairs)];
  const count = (status: ToolCallRowStatus) => statuses.filter((value) => value === status).length;
  const failed = count('failed');
  const denied = count('denied');
  const expired = count('expired');
  const waiting = count('waiting');
  const waitingInput = count('waiting-input');
  if (failed > 0) segments.push(`${failed} failed`);
  if (denied > 0) segments.push(`${denied} denied`);
  if (expired > 0) segments.push(`${expired} expired`);
  if (waiting > 0) segments.push(`${waiting} waiting for approval`);
  if (waitingInput > 0) segments.push(`${waitingInput} waiting for input`);
  if (durations.length > 0 && durations.every((duration) => duration !== undefined)) {
    const total = durations.reduce<number>((sum, duration) => sum + (duration ?? 0), 0);
    segments.push(formatToolCallDuration(total));
  }
  return segments;
}
