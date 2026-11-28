/**
 * Keeps a command's refusal in view (COR-2725).
 *
 * A command that did not go through is said in one line under the controls it was pressed on. The
 * line is news only if the person can read it, so while it is said the transcript keeps the line
 * and those controls clear of its end: when the line appears, and again whenever the transcript's
 * box or the line changes size (a smaller window, a phone's keyboard, a font that loads). A scroll
 * made once, when the line mounts, is not enough: the page is often made smaller afterwards.
 *
 * Where the transcript rests when its box changes size is the pin's to say
 * (`keepPinnedThroughResize`); this placement is for the line, which that pin steps aside for while
 * the line is kept in view (`commandFailureHeld`).
 *
 * The placement only ever moves the transcript toward its end, so it cannot pull against the pin
 * to the last message, and it gives the transcript up for good the moment the person scrolls,
 * wheels, touches or presses a key there, or anything moves the transcript back toward its start.
 */

/** A box's block edges, in CSS pixels. */
type BlockEdges = { readonly top: number; readonly bottom: number };

/** The line a turn says when a command on it did not go through. */
const COMMAND_FAILURE_SELECTOR = '.chat-turn-command-failure';

/** The inputs by which a person takes the transcript: the same four the approval placement reads. */
const PERSON_INPUTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

/**
 * How far the transcript scrolls, in pixels and never toward its start, so `unit` (the controls a
 * command was pressed on and the line under them) rests inside `box`, the part of the transcript a
 * person can read. `toEnd` is how far the transcript can still scroll. A unit cut off at the box's
 * end comes up by what is hidden, or the transcript goes to its end when the end still shows the
 * unit's top: the end is where the pin to the last message rests, so the two agree on one position
 * whichever runs last. A unit above the box has been scrolled past and is left alone.
 */
function commandFailureShift(unit: BlockEdges, box: BlockEdges, toEnd: number): number {
  if (box.bottom - box.top <= 0) return 0;
  const hidden = unit.bottom - box.bottom;
  // Half a pixel of rounding is not hidden.
  if (hidden <= 0.5) return 0;
  const reach = Math.max(toEnd, 0);
  if (reach <= hidden) return reach < 0.5 ? 0 : reach;
  return unit.top - reach >= box.top - 0.5 ? reach : hidden;
}

/** The last refusal line drawn under `root`, or `null` when none is. */
function findCommandFailureLine(root: ParentNode): HTMLElement | null {
  return [...root.querySelectorAll<HTMLElement>(COMMAND_FAILURE_SELECTOR)].at(-1) ?? null;
}

/** The refusal line and, when the turn draws its outcome directly above it, that outcome's controls. */
function commandFailureUnit(line: HTMLElement): BlockEdges {
  const lineBox = line.getBoundingClientRect();
  const outcome = line.previousElementSibling;
  const top =
    outcome !== null && outcome.matches('.chat-turn-outcome')
      ? outcome.getBoundingClientRect().top
      : lineBox.top;
  return { top: Math.min(top, lineBox.top), bottom: lineBox.bottom };
}

/**
 * The part of the transcript a person can read: its box less its scroll padding, which is where
 * Chat's stylesheet already says what the edges hide (a header the host lays over the start, the
 * fade at the end).
 */
export function transcriptReadingBox(transcript: HTMLElement): BlockEdges {
  const box = transcript.getBoundingClientRect();
  const style = getComputedStyle(transcript);
  const start = Number.parseFloat(style.scrollPaddingTop);
  const end = Number.parseFloat(style.scrollPaddingBottom);
  return {
    top: box.top + (Number.isFinite(start) ? start : 0),
    bottom: box.bottom - (Number.isFinite(end) ? end : 0),
  };
}

/** The transcripts a placement is keeping a refusal in view in right now (not released, not stopped). */
const held = new WeakSet<HTMLElement>();

/**
 * Whether a refusal is being kept in view in `transcript`. While it is, that placement owns the
 * transcript's resting position: the pin (`keepPinnedThroughResize`) yields to it.
 * The two can rest on different edges. The pin can put the end of the scrollable area at the box's end;
 * the placement puts the refusal line, the news, at the reading box's end, and only moves on to
 * the true end when that still shows the controls the refusal belongs to. A unit taller than the
 * reading box keeps its line, and the pin going on to the true end would push the controls above
 * the box, where nothing could pull them back (the placement only moves toward the end). So the
 * pin steps aside, and the placement, which also runs on every resize, rests the transcript.
 * Once the person takes the transcript, or the refusal is cleared, the pin is the only rule again.
 */
export function commandFailureHeld(transcript: HTMLElement): boolean {
  return held.has(transcript);
}

/**
 * Keeps the refusal drawn in `transcript` in view until the returned function is called. Chat calls
 * it once per refusal (the ledger, not the line's element, says when one is said), so a row that is
 * merely drawn again starts nothing.
 */
export function keepCommandFailureInView(transcript: HTMLElement): () => void {
  if (typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => {};
  }
  let released = false;
  let disposed = false;
  let frame = 0;
  let observedLine: HTMLElement | null = null;
  // Where the transcript rests: where this placement left it, where a resize found it, or where
  // something else moved it on toward the end.
  let restingTop = transcript.scrollTop;

  const place = (): void => {
    frame = 0;
    if (released || disposed) return;
    const line = findCommandFailureLine(transcript);
    if (line !== observedLine) {
      if (observedLine !== null) resizes.unobserve(observedLine);
      observedLine = line;
      if (line !== null) resizes.observe(line);
    }
    if (line === null) return;
    const shift = commandFailureShift(
      commandFailureUnit(line),
      transcriptReadingBox(transcript),
      transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop,
    );
    if (shift === 0) return;
    const before = transcript.scrollTop;
    transcript.scrollTop = before + shift;
    restingTop = transcript.scrollTop;
    // Look once more after the scroll lands, until a pass moves nothing.
    if (Math.abs(restingTop - before) >= 0.5) schedule();
  };
  const schedule = (): void => {
    if (frame === 0 && !released && !disposed) frame = requestAnimationFrame(place);
  };
  const release = (): void => {
    released = true;
    held.delete(transcript);
  };
  // A move toward the end (the pin to the last message, Jump to latest) is one this placement
  // would never undo, so the transcript rests from there. A move back toward the start is someone
  // else's: the person's own scroll, a jump to a message, a host that scrolls the transcript.
  const followScroll = (): void => {
    const top = transcript.scrollTop;
    if (top < restingTop - 2) release();
    else if (top > restingTop) restingTop = top;
  };
  // A box that grows can clamp the scroll position in the same layout; that is not a scroll back.
  const resizes = new ResizeObserver(() => {
    restingTop = transcript.scrollTop;
    schedule();
  });
  resizes.observe(transcript);
  // Only to find a line that is not drawn yet, or was drawn again: content that changes while the
  // line stands (a reply streaming in) is never a reason to move.
  const changes = new MutationObserver(() => {
    if (observedLine === null || !observedLine.isConnected) schedule();
  });
  changes.observe(transcript, { childList: true, subtree: true });
  for (const type of PERSON_INPUTS) transcript.addEventListener(type, release, { passive: true });
  transcript.addEventListener('scroll', followScroll, { passive: true });
  // Web fonts change every line's height once they load; place the line again then.
  void transcript.ownerDocument.fonts?.ready.then(() => {
    schedule();
    return undefined;
  });
  schedule();
  held.add(transcript);

  return () => {
    disposed = true;
    held.delete(transcript);
    if (frame !== 0) cancelAnimationFrame(frame);
    resizes.disconnect();
    changes.disconnect();
    for (const type of PERSON_INPUTS) transcript.removeEventListener(type, release);
    transcript.removeEventListener('scroll', followScroll);
  };
}
