import type { ApprovalState } from '@lostgradient/cinder';
import type { Message } from '../conversation-model.ts';

/** The words the composer drawer says while an approval waits on the person. */
export const APPROVAL_DRAWER_TEXT =
  'Waiting for your approval. Anything you send now queues until you decide.';

/** The drawer's action: it takes the person to the approval that waits. */
export const APPROVAL_DRAWER_ACTION = 'Review approval';

/**
 * The id of the message that shows the first approval still waiting on the person, or `undefined`
 * when none is. A paired approval draws under its call's row (the result row is folded into it), so
 * that row's id is returned; an unpaired result row draws its own.
 *
 * An approval is waiting until it has a decision in `approvalStates`. A decision that is on its way
 * is not a decision, so the approval is still found.
 */
export function findPendingApprovalMessageId(
  messages: readonly Message[],
  approvalStates: ReadonlyMap<string, ApprovalState> | undefined,
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
    const callRow = messages.find(
      (candidate) => candidate.role === 'tool-call' && candidate.toolCall?.id === result.callId,
    );
    return callRow?.id ?? message.id;
  }
  return undefined;
}

/**
 * Moves focus to the first approval card under `root` that is still waiting. The card is a group
 * focusable by script alone, so this never answers it. Returns whether a card took focus.
 */
export function focusPendingApproval(root: ParentNode | null | undefined): boolean {
  const card = root?.querySelector<HTMLElement>(
    '[data-cinder-tool-approval][data-cinder-state="pending"]',
  );
  if (!card) return false;
  card.focus({ preventScroll: true });
  return card.ownerDocument.activeElement === card;
}
