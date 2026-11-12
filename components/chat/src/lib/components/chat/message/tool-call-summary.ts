import type { ApprovalState } from '@lostgradient/cinder';
import { stringify } from '../../../utilities/stringify.ts';
import { toolResultText } from '../../../utilities/tool-result-text.ts';
import type { ToolCallPair } from '../conversation-model.ts';

/**
 * Where one tool call stands, as the quiet timeline shows it. `expired` is an approval whose
 * deadline passed before anyone decided it (COR-2280): it no longer waits. `approved` and
 * `answered` are a call the person settled here whose run has not reported back yet: it no
 * longer waits on them either.
 */
export type ToolCallRowStatus =
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'expired'
  | 'waiting'
  | 'waiting-input'
  | 'approved'
  | 'answered';

const STATUS_TEXT: Record<ToolCallRowStatus, string> = {
  pending: 'Pending',
  succeeded: 'Complete',
  failed: 'Failed',
  denied: 'Denied',
  expired: 'Expired',
  waiting: 'Waiting for approval',
  'waiting-input': 'Waiting for input',
  approved: 'Approved, resuming',
  answered: 'Answered',
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
 * An approval the person approved reads `approved`, and a question they
 * `answered` reads `answered`, until the run reports what happened next.
 */
export function toolCallRowStatus(
  pair: ToolCallPair,
  approvalState: ApprovalState | undefined,
  now: number = Date.now(),
  answered = false,
): ToolCallRowStatus {
  if (approvalState === 'denied') return 'denied';
  if (approvalState === 'expired') return 'expired';
  const outcome = pair.result?.outcome;
  if (outcome === 'error') return 'failed';
  if (outcome === 'action_required') {
    if (pair.result?.action?.type !== 'approval') return answered ? 'answered' : 'waiting-input';
    if (approvalState === 'approved' || approvalState === 'approved_with_edits') return 'approved';
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

/**
 * What a failed step says under its row (COR-2283, R7): a one-line `summary` of what went wrong, a
 * `diagnostic` with the rest when there is more to say, and `copy`, the text Copy error puts on
 * the clipboard.
 */
export type ToolCallFailure = {
  /** What went wrong, in one line: the error's message, or the start of what came back. */
  summary: string;
  /** The rest of what came back, when it says more than the summary: the error's details, or the whole result. */
  diagnostic: string | undefined;
  /** The summary and the diagnostic together, for Copy error. */
  copy: string;
};

/**
 * What a failed call says under its row, or `undefined` for a call that did not fail. The result's
 * parts are read through their text and media labels, never their addresses, and a result with no
 * error object is not repeated as both the summary and the diagnostic. `fallback` is the summary of
 * a failure that says nothing at all.
 */
export function toolCallFailure(pair: ToolCallPair, fallback: string): ToolCallFailure | undefined {
  const result = pair.result;
  if (result?.outcome !== 'error') return undefined;
  const body = toolResultText(result).trim();
  const message = result.error?.message.trim() ?? '';
  const summary = message !== '' ? message : oneLine(body) || fallback;
  const details = result.error?.details === undefined ? '' : stringify(result.error.details).trim();
  const rest = details !== '' ? details : body;
  const diagnostic = rest !== '' && rest !== summary ? rest : undefined;
  return {
    summary,
    diagnostic,
    copy: diagnostic === undefined ? summary : `${summary}\n\n${diagnostic}`,
  };
}

/** Formats the time a step has been running, in whole seconds: `0s`, `12s`, or `1m 5s`. */
export function formatToolCallElapsed(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
}

/** A running step's title ends in an ellipsis, as a sentence still under way does. */
export function runningStepTitle(title: string): string {
  const trimmed = title.trimEnd();
  return trimmed.endsWith('…') ? trimmed : `${trimmed.replace(/\.+$/u, '')}…`;
}

/** Formats a duration in milliseconds as `0.4s`, `12s`, or `1m 5s`. */
export function formatToolCallDuration(milliseconds: number): string {
  if (milliseconds < 10_000) return `${(Math.max(0, milliseconds) / 1000).toFixed(1)}s`;
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
}

/** The tool names in first-use order, with a count when a tool ran more than once. */
function toolDisplayName(pair: ToolCallPair): string {
  // Input actions are semantic, regardless of the adapter's internal operation name. The
  // expanded row still exposes the exact technical name; the collapsed summary describes work.
  return pair.result?.outcome === 'action_required' && pair.result.action?.type !== 'approval'
    ? 'Requested input'
    : pair.call.name;
}

function toolNamesSegment(pairs: readonly ToolCallPair[]): string {
  const counts = new Map<string, number>();
  for (const pair of pairs) {
    const name = toolDisplayName(pair);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Array.from(counts, ([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(', ');
}

/**
 * The total time of some calls, when every one of them has a duration. A call still running has
 * none yet, and a total that left it out would read as shorter than the work.
 */
export function totalToolCallDuration(
  durations: readonly (number | undefined)[],
): number | undefined {
  if (durations.length === 0 || durations.some((duration) => duration === undefined)) {
    return undefined;
  }
  return durations.reduce<number>((sum, duration) => sum + (duration ?? 0), 0);
}

/** What the group's header says after its step count, one phrase to a field. */
export type ToolCallSummaryParts = {
  /** The first host-provided semantic sentence for completed work, when one exists. */
  description: string | undefined;
  /**
   * The tools in first-use order, with a count when one ran more than once ("lookup-order ×2").
   * A call that is waiting for the person is left out: the status says what it needs, and its
   * tool identifier is run machinery rather than useful work summary text. Expanded rows retain
   * the exact tool name.
   */
  tools: string;
  /**
   * Any failed, denied, expired, waiting, approved or answered counts ("1 failed"), in that order.
   * An expired approval counts as expired and never as waiting (COR-2280), and an approval or a
   * question the person settled counts as approved or answered, never as waiting.
   */
  problems: string[];
  /** The status each entry of `problems` counts, in the same order, so the header can tone it. */
  problemStatuses: ToolCallRowStatus[];
  /** The total time, when every call has one ("0.7s"). */
  duration: string | undefined;
};

/** The header's phrases for a group of calls, kept apart so each can wrap whole. */
export function toolCallSummaryParts(
  pairs: readonly ToolCallPair[],
  statuses: readonly ToolCallRowStatus[],
  durations: readonly (number | undefined)[],
  problemText: (count: number, status: ToolCallRowStatus) => string = defaultProblemText,
  descriptions: readonly (string | undefined)[] = [],
): ToolCallSummaryParts {
  const count = (status: ToolCallRowStatus) => statuses.filter((value) => value === status).length;
  const problems: string[] = [];
  const problemStatuses: ToolCallRowStatus[] = [];
  const add = (amount: number, status: ToolCallRowStatus): void => {
    if (amount <= 0) return;
    problems.push(problemText(amount, status));
    problemStatuses.push(status);
  };
  const failed = count('failed');
  const denied = count('denied');
  const expired = count('expired');
  const waiting = count('waiting');
  const waitingInput = count('waiting-input');
  add(failed, 'failed');
  add(denied, 'denied');
  add(expired, 'expired');
  add(waiting, 'waiting');
  add(waitingInput, 'waiting-input');
  const approved = count('approved');
  const answered = count('answered');
  add(approved, 'approved');
  add(answered, 'answered');
  const total = totalToolCallDuration(durations);
  const asking = (status: ToolCallRowStatus | undefined) =>
    status === 'waiting' || status === 'waiting-input' || status === 'answered';
  return {
    description: descriptions.find(
      (description, index) => description !== undefined && !asking(statuses[index]),
    ),
    tools: toolNamesSegment(pairs.filter((_pair, index) => !asking(statuses[index]))),
    problems,
    problemStatuses,
    duration: total === undefined ? undefined : formatToolCallDuration(total),
  };
}

function defaultProblemText(count: number, status: ToolCallRowStatus): string {
  const phrase: Record<ToolCallRowStatus, string> = {
    pending: 'pending',
    succeeded: 'complete',
    failed: 'failed',
    denied: 'denied',
    expired: 'expired',
    waiting: 'waiting for approval',
    'waiting-input': 'waiting for input',
    approved: 'approved, resuming',
    answered: 'answered',
  };
  return `${count} ${phrase[status]}`;
}

/** A call shown on its own row, or a run of identical calls shown as one row. */
export type ToolCallStep<Row> =
  { kind: 'single'; row: Row } | { kind: 'repeated'; rows: readonly [Row, ...Row[]] };

/** From this many identical calls in a row, the group shows them as one row. */
export const REPEATED_STEP_MINIMUM = 3;

/**
 * Folds runs of identical consecutive calls into one step each. `repeatKey` names what makes two
 * calls identical, and returns `undefined` for a call that never folds, so a failed, denied or
 * waiting call always keeps its own row. A run shorter than {@link REPEATED_STEP_MINIMUM} stays as
 * single rows, because two calls are no clearer folded.
 */
export function foldRepeatedSteps<Row>(
  rows: readonly Row[],
  repeatKey: (row: Row) => string | undefined,
): ToolCallStep<Row>[] {
  const steps: ToolCallStep<Row>[] = [];
  let run: [Row, ...Row[]] | undefined;
  let runKey: string | undefined;
  const flush = (): void => {
    if (run === undefined) return;
    if (run.length >= REPEATED_STEP_MINIMUM) {
      steps.push({ kind: 'repeated', rows: run });
    } else {
      for (const row of run) steps.push({ kind: 'single', row });
    }
    run = undefined;
  };
  for (const row of rows) {
    const key = repeatKey(row);
    if (run !== undefined && key !== undefined && key === runKey) {
      run.push(row);
    } else {
      flush();
      run = [row];
      runKey = key;
    }
  }
  flush();
  return steps;
}
