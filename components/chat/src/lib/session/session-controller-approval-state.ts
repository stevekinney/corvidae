import { isFollowUpMessage } from '../components/chat/builders.ts';
import type { ConversationHistory, ToolResult } from '../components/chat/conversation-model.ts';
import { getOwn } from '../utilities/get-own.ts';
import type { ChatSessionControllerOptions } from './session-controller-support.ts';

/**
 * The time approval deadlines are read against, in epoch milliseconds (COR-2280): the host's clock
 * when it gave one (`ChatSessionControllerOptions.now`) and it reads as a valid instant, else the
 * browser's. Read fresh at each use, so a deadline that passes between two reads is seen passed.
 */
export function approvalClock(options: Pick<ChatSessionControllerOptions, 'now'>): number {
  const supplied = options.now === undefined ? Number.NaN : Date.parse(options.now());
  return Number.isFinite(supplied) ? supplied : Date.now();
}

/**
 * Whether a tool result still waits on a person at `now`: an `action_required` result with an
 * action, unless it is an approval whose valid `expiresAt` has passed (COR-2280). An approval with
 * no deadline, or one that is not a valid instant, still waits: an unknown deadline is never read
 * as expired.
 */
export function isPendingApprovalResult(result: ToolResult | undefined, now: number): boolean {
  if (result?.outcome !== 'action_required' || result.action === undefined) return false;
  if (result.action.type !== 'approval' || result.action.expiresAt === undefined) return true;
  const deadline = Date.parse(result.action.expiresAt);
  return !Number.isFinite(deadline) || now < deadline;
}

/** The result row a call's outcome is replaced in, as `replaceToolResult` finds it. */
export function toolResultOf(
  history: ConversationHistory,
  toolCallId: string,
): ToolResult | undefined {
  for (const id of history.ids) {
    const result = getOwn(history.messages, id)?.toolResult;
    if (result?.callId === toolCallId) return result;
  }
  return undefined;
}

/**
 * Drops from `pendingApprovals` each call whose current result no longer waits at `now`: one that
 * settled, and an approval whose deadline passed since it was admitted. A call that still waits,
 * and every other call's prepared decision and owner, are left as they are.
 */
export function retireSettledApprovals(
  history: ConversationHistory,
  pendingApprovals: Set<string>,
  now: number,
): void {
  for (const id of [...pendingApprovals]) {
    if (!isPendingApprovalResult(toolResultOf(history, id), now)) pendingApprovals.delete(id);
  }
}

export function findOwningUser(
  history: ConversationHistory,
  toolCallId: string,
  activeUserMessageId: string | undefined,
): string {
  const position = history.ids.indexOf(toolCallId);
  for (let index = position - 1; index >= 0; index -= 1) {
    const message = getOwn(history.messages, history.ids[index]!);
    // A follow-up row never owns the run, so the search walks past it.
    if (message?.role === 'user' && !isFollowUpMessage(message)) return message.id;
  }
  return activeUserMessageId ?? '';
}

/**
 * Rebuilds who owns each call and which calls wait on a person from `history`. A call waits only
 * while its result is pending at `now` ({@link isPendingApprovalResult}), so a retained approval
 * that expired is kept in the transcript and does not hold a later turn back.
 */
export function rebuildApprovalState(
  history: ConversationHistory,
  toolOwners: Map<string, string>,
  pendingApprovals: Set<string>,
  activeUserMessageId: string | undefined,
  now: number,
): void {
  toolOwners.clear();
  pendingApprovals.clear();
  for (const id of history.ids) {
    const message = getOwn(history.messages, id);
    if (!message) continue;
    if (message.role === 'tool-call' && message.toolCall)
      toolOwners.set(message.toolCall.id, findOwningUser(history, id, activeUserMessageId));
    if (message.role === 'tool-result' && message.toolResult) {
      if (isPendingApprovalResult(message.toolResult, now))
        pendingApprovals.add(message.toolResult.callId);
      else pendingApprovals.delete(message.toolResult.callId);
    }
  }
}

export function latestResolvedApprovalOwner(
  history: ConversationHistory,
  resolvedApprovalOwners: Set<string>,
): string | undefined {
  let latestOwner: string | undefined;
  let latestPosition = -1;
  for (const owner of resolvedApprovalOwners) {
    if (isFollowUpMessage(getOwn(history.messages, owner))) continue;
    const position = history.ids.indexOf(owner);
    if (position > latestPosition) {
      latestOwner = owner;
      latestPosition = position;
    }
  }
  return latestOwner;
}
