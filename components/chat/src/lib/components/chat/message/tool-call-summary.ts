import type { ApprovalState } from '@lostgradient/cinder';
import { stringify } from '../../../utilities/stringify.ts';
import { toolResultText } from '../../../utilities/tool-result-text.ts';
import type { ToolCallPair } from '../conversation-model.ts';

/** Where one tool call stands, as the quiet timeline shows it. */
export type ToolCallRowStatus = 'pending' | 'succeeded' | 'failed' | 'denied' | 'waiting';

const STATUS_TEXT: Record<ToolCallRowStatus, string> = {
  pending: 'Pending',
  succeeded: 'Complete',
  failed: 'Failed',
  denied: 'Denied',
  waiting: 'Waiting for approval',
};

const ONE_LINE_LIMIT = 80;

/**
 * A call's status. A denied approval reads `denied`, never `failed`, whether
 * the run reports the denial as the pending approval or as an error result.
 */
export function toolCallRowStatus(
  pair: ToolCallPair,
  approvalState: ApprovalState | undefined,
): ToolCallRowStatus {
  if (approvalState === 'denied') return 'denied';
  const outcome = pair.result?.outcome;
  if (outcome === 'error') return 'failed';
  if (outcome === 'action_required') return 'waiting';
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
  // A call waiting on the user has no result yet; its approval or input row asks.
  if (result.outcome === 'action_required') return undefined;
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
 * failed, denied, or waiting counts, then the total time when every call has one.
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
  const waiting = count('waiting');
  if (failed > 0) segments.push(`${failed} failed`);
  if (denied > 0) segments.push(`${denied} denied`);
  if (waiting > 0) segments.push(`${waiting} waiting for approval`);
  if (durations.length > 0 && durations.every((duration) => duration !== undefined)) {
    const total = durations.reduce<number>((sum, duration) => sum + (duration ?? 0), 0);
    segments.push(formatToolCallDuration(total));
  }
  return segments;
}
