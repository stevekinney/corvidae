import type { ApprovalState } from '@lostgradient/cinder';
import type { Message } from '../conversation-model.ts';

/** The words the composer drawer says while an approval waits on the person. */
export const APPROVAL_DRAWER_TEXT = 'Approval needed.';

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
 * The room kept under the decision row at the transcript's end, in pixels, while the transcript
 * can still scroll: the end edge's fade (24px, `--cinder-space-6`) and an 8px margin, so the row
 * is neither washed out by the fade nor on the edge of where the reminder shows.
 */
export const APPROVAL_END_FADE_CLEARANCE = 32;

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

/**
 * Whether a waiting approval card, with the clearance kept under it, is taller than the transcript's
 * box: then it cannot be shown whole, and its decision buttons are what the page shows.
 */
export function approvalTallerThanTranscript(
  card: Pick<DOMRectReadOnly, 'top' | 'bottom'>,
  viewport: Pick<DOMRectReadOnly, 'top' | 'bottom'>,
  clearance = APPROVAL_BOTTOM_CLEARANCE,
): boolean {
  return card.bottom + clearance - card.top > viewport.bottom - viewport.top + 0.5;
}

/**
 * How far the transcript scrolls, in pixels (positive scrolls down), to bring a waiting approval
 * into view when it opens or the chat opens on it (COR-2327). A card that fits the transcript with
 * the clearance under it is shown whole: scrolled down until its bottom and the clearance are in
 * view, or up until its top is. A card taller than the transcript has its bottom, where Deny and
 * Approve are, aligned to the transcript's bottom with the clearance to spare; its top may scroll
 * off. Half a pixel of rounding is no shift.
 */
export function approvalArrivalShift(
  card: Pick<DOMRectReadOnly, 'top' | 'bottom'>,
  viewport: Pick<DOMRectReadOnly, 'top' | 'bottom'>,
  clearance = APPROVAL_BOTTOM_CLEARANCE,
): number {
  const below = card.bottom + clearance - viewport.bottom;
  let shift = 0;
  if (approvalTallerThanTranscript(card, viewport, clearance)) shift = below;
  else if (below > 0) shift = below;
  else if (card.top < viewport.top) shift = card.top - viewport.top;
  return Math.abs(shift) <= 0.5 ? 0 : shift;
}

/**
 * Where a waiting approval's arrival placement rests (COR-2327): `approvalArrivalShift`, except that
 * a card that fits the transcript rests at the transcript's end whenever the end still shows it
 * whole. `toEnd` is how far the transcript can still scroll down. The end is where the transcript's
 * own pin to its last message puts it, so the placement and the pin come to rest in one place
 * whichever of them runs last; a card stopped with its bottom on the clearance would rest the
 * transcript's end padding, less the clearance, above the pin.
 */
export function approvalArrivalRestShift(
  card: Pick<DOMRectReadOnly, 'top' | 'bottom'>,
  viewport: Pick<DOMRectReadOnly, 'top' | 'bottom'>,
  toEnd: number,
  clearance = APPROVAL_BOTTOM_CLEARANCE,
  keepTopClear = false,
): number {
  const shift = approvalArrivalShift(card, viewport, clearance);
  let result = shift;
  if (
    shift >= 0 &&
    toEnd > 0.5 &&
    toEnd >= shift &&
    !approvalTallerThanTranscript(card, viewport, clearance)
  ) {
    // Scrolled to the end the card moves up by `toEnd`, past where its bottom and the clearance
    // show, so it is whole there while its top is still in view.
    result = card.top - toEnd >= viewport.top - 0.5 ? toEnd : shift;
  }
  if (!keepTopClear) return result;
  // Under a header laid over the transcript (`viewport.top` is already below it), ranked:
  //   1. The decision row, whose bottom is the card's, rests whole above the transcript's end fade
  //      and so above where the reminder would stand (the transcript's end, which the reminder
  //      shows below). This always wins, and it is a shift down only as far as the transcript can
  //      still scroll (at its end the fade is off).
  //   2. When the unit also fits there, its top rests on the header's line (the shift above,
  //      limited so the top never passes it).
  //   3. When it does not fit, it shifts by only the deficit: the label row passes under the header
  //      and the top fade, and the card, below it, stays clear.
  const decisionShift = Math.min(
    Math.max(card.bottom - (viewport.bottom - APPROVAL_END_FADE_CLEARANCE), 0),
    Math.max(toEnd, 0),
  );
  const placed = Math.min(result, card.top - viewport.top);
  return decisionShift > 0 ? Math.max(placed, decisionShift) : placed;
}

/**
 * How far the transcript scrolls to place the waiting approval `card` (positive scrolls down), by
 * the one rule Chat and a host that brings the approval into view itself both use: the card and the
 * row that labels it as one unit, in the transcript's arrival box, resting at the transcript's end
 * where that clears any header laid over the top, and never with the unit's top under that header.
 * `null` while the layout is not measured.
 */
export function approvalPlacementShift(transcript: HTMLElement, card: HTMLElement): number | null {
  const unit = approvalUnitBox(card);
  const box = approvalArrivalBox(transcript);
  if (unit.bottom - unit.top <= 0 || box.bottom - box.top <= 0) return null;
  const toEnd = transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop;
  return approvalArrivalRestShift(
    unit,
    box,
    toEnd,
    APPROVAL_BOTTOM_CLEARANCE,
    approvalOverlayCovered(transcript) > 0,
  );
}

/**
 * The room a drawn approval reminder takes from the transcript under `root`: its height and its
 * block margins, or 0 when none is drawn. Read from the page, so it is what is drawn now.
 */
export function approvalReminderRoom(root: ParentNode | null | undefined): number {
  const reminder = root?.querySelector<HTMLElement>('[data-chat-approval-drawer]');
  if (reminder === null || reminder === undefined) return 0;
  const style = getComputedStyle(reminder);
  return (
    reminder.getBoundingClientRect().height +
    (Number.parseFloat(style.marginTop) || 0) +
    (Number.parseFloat(style.marginBottom) || 0)
  );
}

/**
 * The height of a header the host lays over the top of the transcript
 * (`--cinder-chat-overlay-inset-start`), or 0 when none is.
 */
export function approvalOverlayCovered(transcript: HTMLElement): number {
  const covered = Number.parseFloat(
    getComputedStyle(transcript).getPropertyValue('--cinder-chat-overlay-inset-start'),
  );
  return Number.isFinite(covered) && covered > 0 ? covered : 0;
}

/**
 * The transcript's visible box for placing a waiting approval, measured without the reminder:
 * the reminder takes room from the transcript while it shows, so a placement judged against the
 * box it leaves would move the card the reminder is about, and the two would feed each other
 * (COR-2327). A host that brings the approval into view itself reads this same box.
 */
export function approvalArrivalBox(
  transcript: HTMLElement,
): Pick<DOMRectReadOnly, 'top' | 'bottom' | 'left' | 'right'> {
  const box = transcript.getBoundingClientRect();
  const room = approvalReminderRoom(
    transcript.closest('.chat-container') ?? transcript.parentElement,
  );
  // A header the host lays over the top of the transcript (`--cinder-chat-overlay-inset-start`)
  // hides that much of the box. The box starts below it by the transcript's own top padding, which
  // is the overlay's height plus the timeline's padding: the gap the first row of a short chat
  // gets, so a card is never placed flush against, or under, the header.
  const style = getComputedStyle(transcript);
  const padding = Number.parseFloat(style.paddingTop);
  const clear = approvalOverlayCovered(transcript);
  return {
    top: box.top + (clear > 0 && Number.isFinite(padding) ? Math.max(padding, clear) : 0),
    bottom: box.bottom + room,
    left: box.left,
    right: box.right,
  };
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

/** The selector of an approval card still waiting on the person. */
export const PENDING_APPROVAL_CARD_SELECTOR = '.cinder-approval-card[data-cinder-state="pending"]';

/**
 * Returns the pending approval card rendered by the message that is waiting. A host that draws its
 * calls in a row of its own (Interborough folds a step's calls into the step's reply) renders no
 * card under that message, so the first pending card in the transcript stands for it: the message
 * is the first approval still waiting, so the first pending card is the one it means. Without the
 * fallback the reminder could never tell that the card's decision row is in view, and stayed.
 */
export function pendingApprovalCard(
  root: ParentNode | null | undefined,
  messageId: string,
): HTMLElement | null {
  const message = root?.querySelector<HTMLElement>(
    `article[data-message-id="${CSS.escape(messageId)}"]`,
  );
  return (
    message?.querySelector<HTMLElement>(PENDING_APPROVAL_CARD_SELECTOR) ??
    root?.querySelector<HTMLElement>(PENDING_APPROVAL_CARD_SELECTOR) ??
    null
  );
}

/** Where the row that labels an approval card is looked for, nearest container first. */
const LABEL_SCOPES = [
  '.cinder-tool-call-rail__item',
  '.cinder-tool-call-rail',
  'article[data-message-id]',
  '.chat-timeline > *',
] as const;

/**
 * The box of a pending approval to keep clear of the header and the composer: the card and the rail
 * row that labels it ("Issue refund 4471, Waiting on you"), the one above it, as one unit. The
 * labelling row sits above the card, so a card placed on its own top leaves the row's top under the
 * header, where it takes no tap.
 *
 * The row is searched for in the closest container that holds both, in the order the markup really
 * has them: the tool-call rail's item (an application that draws the card inside the rail, as
 * Interborough does through its own `row` snippet, has no message article), the rail, the message
 * article (Chat's own message), and the timeline's row wrapper.
 */
export function approvalUnitBox(card: HTMLElement): Pick<DOMRectReadOnly, 'top' | 'bottom'> {
  const box = card.getBoundingClientRect();
  let label: HTMLElement | undefined;
  for (const selector of LABEL_SCOPES) {
    const scope = card.closest<HTMLElement>(selector);
    if (scope === null) continue;
    // The nearest row before the card in document order is the one that labels it.
    for (const row of scope.querySelectorAll<HTMLElement>('.cinder-tool-call-rail__row')) {
      if (row.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) label = row;
    }
    if (label !== undefined) break;
  }
  return {
    top: Math.min(box.top, label?.getBoundingClientRect().top ?? box.top),
    bottom: box.bottom,
  };
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
