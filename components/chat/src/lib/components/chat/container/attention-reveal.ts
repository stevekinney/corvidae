/**
 * What a transcript pinned to its end keeps in view when the last thing in it waits on the person.
 *
 * Pinning to the end shows an item's bottom. A pending approval or question taller than the room
 * left (a phone, a tablet, a composer with its drawer open) would then show its buttons and not
 * what they decide, so the transcript lifts until the item's top is in view instead, and the
 * person scrolls on to the buttons.
 */

/** The gap kept above the item once its top is brought into view, in CSS pixels. */
export const ATTENTION_INSET = 8;

/** A pending approval card, or a question not yet answered or held. */
const ATTENTION_SELECTOR = [
  '.cinder-approval-card[data-cinder-state="pending"]',
  '.chat-question[data-question-phase="open"]',
].join(', ');

/**
 * The last item under `root` that waits on the person, the one nearest the end: a pending approval
 * card, or an open question. A question the host draws at the end of the transcript (the
 * `trailing` snippet) is returned as the whole block the host wrapped it in, so the host's own
 * prompt above it counts as its top. A question already answered is skipped.
 */
export function findAttentionTarget(root: ParentNode): HTMLElement | null {
  const candidates = [...root.querySelectorAll<HTMLElement>(ATTENTION_SELECTOR)];
  for (const candidate of candidates.toReversed()) {
    if (!candidate.classList.contains('chat-question')) return candidate;
    if (candidate.querySelector('[data-question-answer]') !== null) continue;
    return candidate.closest<HTMLElement>('.chat-trailing > *') ?? candidate;
  }
  return null;
}

/**
 * Whether focus sits on a control inside `target`, such as its Approve button, so lifting the item
 * would scroll the control a keyboard user is on out of view. Focus on the item itself (a card a
 * host focuses when it opens, or that Review approval focuses) is not: its top is what to show.
 */
export function focusIsInside(target: Element, active: Element | null): boolean {
  return active !== null && active !== target && target.contains(active);
}

/** Where the viewport and the item are, from their client rectangles, in CSS pixels. */
export interface AttentionGeometry {
  readonly viewportTop: number;
  readonly targetTop: number;
  readonly targetBottom: number;
}

/**
 * How far to move the scroll so an item cut off at the viewport's top lands `inset` below it: a
 * negative distance, or `0` when its top is already in view. Only an item the pin left partly in
 * view moves the scroll: one wholly above the viewport is history the person is not looking at,
 * and an item that fits is left where the pin put it, since the distance is never downward.
 */
export function revealTopShift(geometry: AttentionGeometry, inset: number): number {
  const { viewportTop, targetTop, targetBottom } = geometry;
  if (targetBottom <= viewportTop) return 0;
  const hidden = viewportTop + inset - targetTop;
  // Half a pixel of rounding is not hidden.
  return hidden > 0.5 ? -hidden : 0;
}
