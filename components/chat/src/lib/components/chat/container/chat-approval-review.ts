import type { ApprovalState } from '@lostgradient/cinder';
import type { Message } from '../conversation-model.ts';

/** The words the composer drawer says while an approval waits on the person. */
export const APPROVAL_DRAWER_TEXT =
  'Waiting for your approval. Anything you send now queues until you decide.';

/** The drawer's action: it takes the person to the approval that waits. */
export const APPROVAL_DRAWER_ACTION = 'Review approval';

/** The time an approval's `expiresAt` names, in epoch milliseconds, or `undefined` for none. */
function approvalDeadline(expiresAt: string | undefined): number | undefined {
  if (expiresAt === undefined) return undefined;
  const deadline = Date.parse(expiresAt);
  return Number.isFinite(deadline) ? deadline : undefined;
}

/**
 * The next deadline still ahead of `now` among the approvals that wait, or `undefined` when none
 * waits on a deadline ahead. The drawer wakes then, once, to stop saying an approval waits.
 */
export function nextPendingApprovalDeadline(
  messages: readonly Message[],
  approvalStates: ReadonlyMap<string, ApprovalState> | undefined,
  now: number,
): number | undefined {
  let next: number | undefined;
  for (const message of messages) {
    const result = message.toolResult;
    if (
      message.role !== 'tool-result' ||
      result?.outcome !== 'action_required' ||
      result.action?.type !== 'approval'
    ) {
      continue;
    }
    const state = approvalStates?.get(result.callId);
    if (state !== undefined && state !== 'pending') continue;
    const deadline = approvalDeadline(result.action.expiresAt);
    if (deadline === undefined || deadline <= now) continue;
    if (next === undefined || deadline < next) next = deadline;
  }
  return next;
}

/**
 * The id of the message that shows the first approval still waiting on the person, or `undefined`
 * when none is. A paired approval draws under its call's row (the result row is folded into it), so
 * that row's id is returned; an unpaired result row draws its own.
 *
 * An approval is waiting until it has a decision in `approvalStates`, or until its `expiresAt`
 * passes `now`, from which time its card offers nothing to answer. A decision that is on its way is
 * not a decision, so the approval is still found.
 */
export function findPendingApprovalMessageId(
  messages: readonly Message[],
  approvalStates: ReadonlyMap<string, ApprovalState> | undefined,
  now: number = Date.now(),
): string | undefined {
  for (const message of messages) {
    const result = message.toolResult;
    if (
      message.role !== 'tool-result' ||
      result?.outcome !== 'action_required' ||
      result.action?.type !== 'approval'
    ) {
      continue;
    }
    const state = approvalStates?.get(result.callId);
    if (state !== undefined && state !== 'pending') continue;
    const deadline = approvalDeadline(result.action.expiresAt);
    if (deadline !== undefined && deadline <= now) continue;
    const callRow = messages.find(
      (candidate) => candidate.role === 'tool-call' && candidate.toolCall?.id === result.callId,
    );
    return callRow?.id ?? message.id;
  }
  return undefined;
}

/**
 * Moves focus to the first approval card under `root` that is still waiting (Cinder's card, left
 * focusable by script alone with a `tabindex`, whether Chat or the host draws it). The card is
 * focusable by script alone, so this never answers it. Returns whether a card took focus.
 */
export function focusPendingApproval(root: ParentNode | null | undefined): boolean {
  const card = root?.querySelector<HTMLElement>(
    '.cinder-approval-card[data-cinder-state="pending"][tabindex]',
  );
  if (!card) return false;
  card.focus({ preventScroll: true });
  return card.ownerDocument.activeElement === card;
}
