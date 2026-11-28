/**
 * Where a transcript rests, and keeping it there whenever its layout changes (COR-2725).
 *
 * A transcript nobody has taken away rests in one place, and that place is read from the layout as
 * it is now, never remembered from an earlier one: from its start, at the smallest scroll that puts
 * the end of its last row at the end of the reading box (`startSideRest`; 0 when the rows fit). The
 * same rows in the same box therefore rest at the same scroll position whatever order they, their
 * sizes and the box arrived in. Nothing is remembered but where the transcript was left: one that
 * is where it rests, or at its true end, is rested again; one a person took anywhere else is theirs
 * and is never moved, until it is brought back. The one exception is explicit: a person who took
 * the transcript to its true end (their input, then a scroll that lands there) has it there, and it
 * is followed to its end as it grows, not carried back to the rest (`takenToEnd`).
 *
 * The transcript is rested again whenever its layout changes: its own box (a notice that grows the
 * composer, a keyboard, a smaller window, a phone turned) or the box of any of its rows (a message
 * that arrives or streams, a panel that sizes itself after it loads, code that is highlighted, a
 * font or an image that lands). Nothing else moves by itself when those change, so a rest taken
 * against a layout that was still settling would otherwise stand. This is also the one record of
 * where the transcript rests: every rest the page makes is reported here (`rested`).
 */

import { transcriptReadingBox } from './command-failure-reveal.ts';

/** How far apart, in CSS pixels, two positions still count as the same (sub-pixel rounding). */
const REST_TOLERANCE = 2;

/** The record of where a transcript rests, which `keepPinnedThroughResize` returns. */
export interface PinnedThroughResize {
  /** The page rested the transcript itself: it rests where it is now. */
  rested(): void;
  /**
   * Whether a person took the transcript to its true end and it has not left it: it is theirs there,
   * so every rest that follows (a late row, a box that changes, a history stabilization) puts it at
   * its true end, never back to the rest.
   */
  takenToEnd(): boolean;
  /** Stops looking. */
  stop(): void;
}

/** The inputs by which a person takes the transcript: the same four the placements read. */
const PERSON_INPUTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

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
 * Looks again whenever the layout of `transcript` changes (its box, or the box of any of its
 * rows), until `stop` is called. While the transcript rests where it was left, `rest` rests it
 * again the way the page does, and is the page's to refuse (no message yet, a refusal or a waiting
 * approval kept in view, a person editing, history loading, a smooth scroll the person started). A
 * refusal does not end the rest: it is asked again at the next change.
 */
export function keepPinnedThroughResize(
  transcript: HTMLElement,
  rest: () => void,
): PinnedThroughResize {
  if (typeof ResizeObserver === 'undefined') {
    return { rested: () => {}, takenToEnd: () => false, stop: () => {} };
  }
  const reach = (): number => transcript.scrollHeight - transcript.clientHeight;
  // Everything the transcript holds, the clear space at its end too, is inside a box that is laid out.
  const fitsWhole = (): boolean => transcript.clientHeight > 0 && reach() <= REST_TOLERANCE;
  const atTrueEnd = (): boolean => reach() - transcript.scrollTop <= REST_TOLERANCE;
  // Where a transcript nobody took can be found: where it rests from its start, or at its true end
  // (a placement, Jump to latest or the person put it there, and it is rested again from there).
  const atRest = (): boolean => {
    if (atTrueEnd()) return true;
    const side = startSideRest(transcript);
    return side !== null && Math.abs(transcript.scrollTop - side) <= REST_TOLERANCE;
  };

  // Where the transcript was last left, and whether it rests there (nobody took it away). One that
  // is first seen at its start has not been taken.
  let restingTop = transcript.scrollTop;
  let following = restingTop <= REST_TOLERANCE || atRest();

  // A scroll says whose the transcript is, from where it is now. One that leaves it where it was
  // left says nothing new, whatever the layout has become since: a rest's own scroll is heard a
  // frame late, often after the layout has changed again.
  const heard = (): void => {
    const top = transcript.scrollTop;
    if (fitsWhole()) following = true;
    else if (Math.abs(top - restingTop) > REST_TOLERANCE) {
      following = atRest();
      // A person who took the transcript to its true end has it there: a scroll that lands at the
      // end, after their input and before the page rested it again, is theirs, and one that leaves
      // the end gives it back.
      if (!atTrueEnd()) toEnd = false;
      else if (input) toEnd = true;
    }
    restingTop = top;
  };
  // A person's input in the transcript since the page last rested it. Not a timer: a scroll heard
  // after the input is the person's, and the page's own rest ends the claim.
  let input = false;
  // Whether a person took the transcript to its true end, and it has not left it since.
  let toEnd = false;
  const personInput = (): void => {
    input = true;
  };
  // The layout changed. A transcript that rests where it was left is rested again; one that has
  // been taken back toward its start in this frame, with its scroll not heard yet, is not (the
  // browser pulling it back to the end of a box that grew, or holding the end of the content in
  // place, is no one taking it).
  const settle = (): void => {
    if (fitsWhole()) following = true;
    else if (following && transcript.scrollTop < restingTop - REST_TOLERANCE && !atRest()) {
      following = false;
    }
    if (following) rest();
    restingTop = transcript.scrollTop;
  };

  const layout = new ResizeObserver(settle);
  layout.observe(transcript);
  for (const row of transcript.children) layout.observe(row);
  // Rows come and go: each new one is watched (and resting again is asked for as it is first
  // measured), and one taken away changes no box that is watched, so it is looked at here.
  const rows =
    typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver((records) => {
          let removed = false;
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (node instanceof Element) layout.observe(node);
            }
            for (const node of record.removedNodes) {
              if (!(node instanceof Element)) continue;
              layout.unobserve(node);
              removed = true;
            }
          }
          if (removed) settle();
        });
  rows?.observe(transcript, { childList: true });
  transcript.addEventListener('scroll', heard, { passive: true });
  for (const type of PERSON_INPUTS)
    transcript.addEventListener(type, personInput, { passive: true });

  return {
    rested: () => {
      restingTop = transcript.scrollTop;
      following = true;
      input = false;
    },
    takenToEnd: () => toEnd,
    stop: () => {
      layout.disconnect();
      rows?.disconnect();
      transcript.removeEventListener('scroll', heard);
      for (const type of PERSON_INPUTS) transcript.removeEventListener(type, personInput);
    },
  };
}
