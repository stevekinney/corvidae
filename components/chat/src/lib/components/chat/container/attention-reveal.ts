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
 * The first item under `root` that waits on the person: a pending approval card, or an open
 * question. A question the host draws at the end of the transcript (the `trailing` snippet) is
 * returned as the whole block the host wrapped it in, so the host's own prompt above it counts as
 * its top. A question already answered is skipped.
 */
export function findAttentionTarget(root: ParentNode): HTMLElement | null {
  for (const candidate of root.querySelectorAll<HTMLElement>(ATTENTION_SELECTOR)) {
    if (!candidate.classList.contains('chat-question')) return candidate;
    if (candidate.querySelector('[data-question-answer]') !== null) continue;
    return candidate.closest<HTMLElement>('.chat-trailing > *') ?? candidate;
  }
  return null;
}

/**
 * How far to move the scroll so an item whose top is above the viewport's top lands `inset` below
 * it: a negative distance, or `0` when its top is already in view. It never moves down, so an
 * item that fits is left where the pin put it.
 */
export function revealTopShift(viewportTop: number, targetTop: number, inset: number): number {
  const hidden = viewportTop + inset - targetTop;
  // Half a pixel of rounding is not hidden.
  return hidden > 0.5 ? -hidden : 0;
}
