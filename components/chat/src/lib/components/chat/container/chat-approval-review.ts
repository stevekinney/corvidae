import type { ApprovalState } from '@lostgradient/cinder';
import type { Message } from '../conversation-model.ts';

/** The words the composer drawer says while an approval waits on the person. */
export const APPROVAL_DRAWER_TEXT = 'Waiting for your approval.';

/** The drawer's action: it takes the person to the approval that waits. */
export const APPROVAL_DRAWER_ACTION = 'Review approval';
/** Accessible name for the compact group that points to the waiting approval. */
export const APPROVAL_DRAWER_LABEL = 'Approval waiting';

/** Returns whether the whole approval context fits, allowing space reclaimable by the drawer. */
export function approvalCardFitsViewport(
  card: Pick<DOMRectReadOnly, 'top' | 'bottom' | 'left' | 'right'>,
  viewport: Pick<DOMRectReadOnly, 'top' | 'bottom' | 'left' | 'right'>,
  reclaimableBlockSize = 0,
): boolean {
  return (
    card.top >= viewport.top - 1 &&
    card.bottom <= viewport.bottom + reclaimableBlockSize + 1 &&
    card.left >= viewport.left - 1 &&
    card.right <= viewport.right + 1
  );
}

/**
 * The transcript's visible box for an approval, measured the same whether the reminder is on screen
 * or not: the box the transcript has with the reminder absent (the "tall" box). The reminder sits
 * in the composer's column and takes room from the transcript while it shows, so the box the
 * transcript reports depends on the reminder; judging the row against that box makes the
 * reminder's presence an input to its own cause, and the reminder flaps at the end of the
 * transcript. `reminderBlockSize` is the room the reminder takes (its height and margins), added
 * back to the bottom only while `reminderShown` says `viewport` excludes it.
 */
export function approvalVisibleBox<T extends Pick<DOMRectReadOnly, 'top' | 'bottom'>>(
  viewport: T & Pick<DOMRectReadOnly, 'left' | 'right'>,
  reminderShown: boolean,
  reminderBlockSize: number,
): Pick<DOMRectReadOnly, 'top' | 'bottom' | 'left' | 'right'> {
  return {
    top: viewport.top,
    bottom: viewport.bottom + (reminderShown ? reminderBlockSize : 0),
    left: viewport.left,
    right: viewport.right,
  };
}

/**
 * Whether a pending approval's row of decision buttons (or the whole card, when it draws none) is
 * wholly inside the transcript's tall box, the single predicate that decides whether the reminder
 * shows: it shows when this is false. It gives the same answer with the reminder on screen and off,
 * because the box is the reminder-absent one in both.
 */
export function approvalRowVisible(
  row: Pick<DOMRectReadOnly, 'top' | 'bottom' | 'left' | 'right'>,
  viewport: Pick<DOMRectReadOnly, 'top' | 'bottom' | 'left' | 'right'>,
  reminderShown: boolean,
  reminderBlockSize: number,
): boolean {
  return approvalCardFitsViewport(row, viewport, reminderShown ? reminderBlockSize : 0);
}

/**
 * The room kept clear below a pending approval card, in pixels: the visible gap of `--cinder-space-3`
 * (0.75rem at the root size). The decision buttons' hit area reaches below their painted edge, so a
 * card pressed against the composer would leave that overhang under the composer.
 */
export const APPROVAL_BOTTOM_CLEARANCE = 12;

/**
 * The box an approval must show inside the transcript: from the decision row's top down to the
 * card's bottom edge plus the clearance, so the buttons and their hit overhang clear the composer.
 * A card that draws no row, or one taller than the transcript box, is judged by the row alone.
 */
export function approvalReviewBox(
  row: Pick<DOMRectReadOnly, 'top' | 'bottom' | 'left' | 'right'>,
  card: Pick<DOMRectReadOnly, 'top' | 'bottom'>,
  boxBlockSize: number,
): Pick<DOMRectReadOnly, 'top' | 'bottom' | 'left' | 'right'> {
  const bottom = card.bottom + APPROVAL_BOTTOM_CLEARANCE;
  if (bottom - row.top > boxBlockSize) return row;
  return { top: row.top, bottom: Math.max(row.bottom, bottom), left: row.left, right: row.right };
}

/** The selector of a pending approval card's row of decision buttons. */
const APPROVAL_ACTION_ROW_SELECTOR =
  '.cinder-approval-card__row-actions, .cinder-approval-card__action-row';

/** Returns a card's row of decision buttons, or `null` when the card draws none. */
export function approvalActionRow(card: ParentNode): HTMLElement | null {
  return card.querySelector<HTMLElement>(APPROVAL_ACTION_ROW_SELECTOR);
}

/**
 * How far the transcript scrolls, in pixels (positive scrolls down), so a card's row of decision
 * buttons sits wholly inside the transcript with `inset` to spare below it, clear of the composer
 * and any notice above it. It is 0 when the row already fits or the viewport is too short to hold
 * it with its inset, and a row above the top scrolls up just far enough to show it.
 */
export function approvalActionRowShift(
  row: Pick<DOMRectReadOnly, 'top' | 'bottom'>,
  viewport: Pick<DOMRectReadOnly, 'top' | 'bottom'>,
  inset = 0,
): number {
  const rowHeight = row.bottom - row.top;
  if (rowHeight + inset > viewport.bottom - viewport.top) return 0;
  const below = row.bottom + inset - viewport.bottom;
  if (below > 0) return below;
  const above = viewport.top - row.top;
  return above > 0 ? -above : 0;
}

/**
 * How far the transcript scrolls (positive scrolls down) so the block that owns a waiting approval,
 * its step row and its card, starts at the top of the transcript's box, or `undefined` when the
 * block with its card's clearance is taller than the box and cannot be shown whole. A whole block
 * at the top never leaves a line of the text above it cut in half, and the card ends inside the box
 * with the clearance the decision buttons need.
 */
export function approvalArrivalShift(
  block: Pick<DOMRectReadOnly, 'top'>,
  card: Pick<DOMRectReadOnly, 'bottom'>,
  box: Pick<DOMRectReadOnly, 'top' | 'bottom'>,
): number | undefined {
  const needed = card.bottom + APPROVAL_BOTTOM_CLEARANCE - block.top;
  if (needed > box.bottom - box.top) return undefined;
  return block.top - box.top;
}

/** Returns the pending approval card rendered by the message that is waiting. */
export function pendingApprovalCard(
  root: ParentNode | null | undefined,
  messageId: string,
): HTMLElement | null {
  const message = root?.querySelector<HTMLElement>(
    `article[data-message-id="${CSS.escape(messageId)}"]`,
  );
  return (
    message?.querySelector<HTMLElement>('.cinder-approval-card[data-cinder-state="pending"]') ??
    null
  );
}

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
  return pendingApprovalMessageIds(messages, approvalStates, now)[0];
}

/** Message ids of the cards that are waiting for a decision, in transcript order. */
export function pendingApprovalMessageIds(
  messages: readonly Message[],
  approvalStates: ReadonlyMap<string, ApprovalState> | undefined,
  now: number,
): string[] {
  const ids: string[] = [];
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
    ids.push(callRow?.id ?? message.id);
  }
  return ids;
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
  const actions = approvalActionRow(card);
  actions?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  card.focus({ preventScroll: true });
  return card.ownerDocument.activeElement === card;
}
