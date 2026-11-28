/**
 * Where a transcript rests when its own box changes size (COR-2725).
 *
 * The transcript pins itself to its last message when messages arrive. A box that changes size with
 * no message arriving (a notice that grows the composer, a keyboard that rises, a window made
 * smaller, a phone turned) scrolls nothing by itself: the scroll position stays and the end of the
 * content moves, so the last row can come to rest in the fade at the transcript's end. This looks
 * again whenever the box changes size and, while the transcript rests where the pin left it, asks
 * the page to rest it again. It is the one record of that resting position: every rest the page
 * makes is reported here (`rested`), so the two never disagree about where the transcript is.
 *
 * A transcript rests one of two ways, and which one is remembered, not measured again:
 *
 * - From its start, once everything it holds has fitted its box: it shows from its first row. When
 *   the box then shrinks it scrolls only as far as its last row needs to end at the end of the
 *   reading box (`startSideRest`), and scrolls back as the box grows. Its true end, with the clear
 *   space after the last row, would push the start of a short conversation out of view and leave a
 *   blank band above the composer.
 * - At its true end, once anything put it there while it overflowed: a message's pin, Jump to
 *   latest, the person's own scroll. It stays at its true end, as a long conversation does.
 *
 * It never moves a transcript someone took away from where it rested: a scroll that leaves it
 * anywhere but its true end ends the rest, until it is brought back to its end or fits again.
 */

import { transcriptReadingBox } from './command-failure-reveal.ts';

/** How far apart, in CSS pixels, two positions still count as the same (sub-pixel rounding). */
const REST_TOLERANCE = 2;

/** The record of where a transcript rests, which `keepPinnedThroughResize` returns. */
export interface PinnedThroughResize {
  /** The page rested the transcript itself: from its start (`fromStart`), or at its true end. */
  rested(fromStart: boolean): void;
  /**
   * Whether the transcript rests from its start, is where it was left, and holds what it held then.
   * Nothing has arrived since it rested, so resting it again means from its start; anything that
   * arrived takes it to its true end, as it always did.
   */
  restsUnchangedFromStart(): boolean;
  /** Stops looking. */
  stop(): void;
}

/**
 * Where what the transcript's last row draws ends, in viewport pixels; `null` when it draws no row.
 * A row that takes no room draws nothing (the typing line while nobody types, an empty trailing
 * slot, a reconnecting turn's anchor), the sentinel is not a row, and a row's own end padding is
 * room it keeps from the row after it, not something it draws.
 */
function lastRowEnd(transcript: HTMLElement): number | null {
  for (let row = transcript.lastElementChild; row !== null; row = row.previousElementSibling) {
    if (row.classList.contains('chat-bottom-sentinel')) continue;
    const box = row.getBoundingClientRect();
    if (box.height < 0.5) continue;
    const padding = Number.parseFloat(getComputedStyle(row).paddingBottom);
    return box.bottom - (Number.isFinite(padding) ? padding : 0);
  }
  return null;
}

/**
 * How far from its start `transcript` rests so its last row ends at the end of its reading box: the
 * smallest scroll that clears the row (0 when it is clear at the start), never past the
 * transcript's end, and the same wherever the transcript is scrolled now. `null` when no row is
 * drawn to rest on (an empty transcript, or one that is not laid out).
 */
export function startSideRest(transcript: HTMLElement): number | null {
  const end = lastRowEnd(transcript);
  if (end === null) return null;
  const hidden = end - transcriptReadingBox(transcript).bottom;
  // A hundredth of a pixel of rounding is not hidden.
  const top = Math.ceil(transcript.scrollTop + hidden - 0.01);
  return Math.min(Math.max(top, 0), Math.max(transcript.scrollHeight - transcript.clientHeight, 0));
}

/**
 * Looks again whenever `transcript`'s box changes size, until `stop` is called. `rest` rests the
 * transcript the way the page does, from its start or at its true end as `fromStart` says, and is
 * the page's to refuse (no message yet, a refusal kept in view, a person editing, history loading,
 * a smooth scroll the person started). A refusal does not end the rest: it is asked again at the
 * next change.
 */
export function keepPinnedThroughResize(
  transcript: HTMLElement,
  rest: (fromStart: boolean) => void,
): PinnedThroughResize {
  if (typeof ResizeObserver === 'undefined') {
    return { rested: () => {}, restsUnchangedFromStart: () => false, stop: () => {} };
  }
  const reach = (): number => transcript.scrollHeight - transcript.clientHeight;
  // Everything the transcript holds, the clear space at its end too, is inside a box that is laid out.
  const fitsWhole = (): boolean => transcript.clientHeight > 0 && reach() <= REST_TOLERANCE;
  const atTrueEnd = (): boolean => reach() - transcript.scrollTop <= REST_TOLERANCE;

  // Where the transcript was last known to rest and how much it held then, whether the pin may move
  // it, and which way it rests.
  let restingTop = transcript.scrollTop;
  let restingExtent = transcript.scrollHeight;
  let following = atTrueEnd();
  let fromStart = fitsWhole();
  const record = (): void => {
    restingTop = transcript.scrollTop;
    restingExtent = transcript.scrollHeight;
  };

  // A scroll says where the transcript rests now. One that leaves it where it was left says nothing
  // new, whatever the layout has become since: a rest's own scroll is heard a frame late, often
  // after the box has changed size again.
  const look = (): void => {
    const top = transcript.scrollTop;
    if (fitsWhole()) {
      following = true;
      fromStart = true;
      record();
      return;
    }
    if (Math.abs(top - restingTop) <= REST_TOLERANCE) return;
    const ended = atTrueEnd();
    // A box that grows pulls the transcript back to its new end: nobody took it there.
    if (ended && !(following && top < restingTop)) fromStart = false;
    following = ended;
    record();
  };

  const resizes = new ResizeObserver(() => {
    if (fitsWhole()) {
      following = true;
      fromStart = true;
    } else if (following && transcript.scrollTop < restingTop - REST_TOLERANCE && !atTrueEnd()) {
      // Something took it back toward its start in this frame, and its scroll is not heard yet.
      following = false;
    }
    if (following) rest(fromStart);
    record();
  });
  resizes.observe(transcript);
  transcript.addEventListener('scroll', look, { passive: true });

  return {
    rested: (startSide) => {
      record();
      following = true;
      fromStart = startSide || fitsWhole();
    },
    restsUnchangedFromStart: () =>
      following &&
      fromStart &&
      Math.abs(transcript.scrollTop - restingTop) <= REST_TOLERANCE &&
      Math.abs(transcript.scrollHeight - restingExtent) <= REST_TOLERANCE,
    stop: () => {
      resizes.disconnect();
      transcript.removeEventListener('scroll', look);
    },
  };
}
