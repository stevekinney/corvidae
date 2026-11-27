/**
 * Keeps a transcript that rests at its end at its end when its own box changes size (COR-2725).
 *
 * The transcript pins itself to the last message when messages arrive. A box that shrinks with no
 * message arriving (a notice that grows the composer, a keyboard that rises, a window made smaller,
 * a phone turned) scrolls nothing: the scroll position stays and the end of the content moves
 * away below the new box, so the last row rests in the fade at the transcript's end, or under the
 * composer. This looks again whenever the box changes size and, when the transcript rested at its
 * true end (the end of the scrollable area, including the clear space Chat leaves after the last
 * row) just before, puts it back there.
 *
 * It only ever moves a transcript that was at its end, toward its end. A person who scrolled away
 * is not at the end, so they are never moved, and a scroll away from the end ends the rest at once.
 */

/** How far from the end, in CSS pixels, still counts as resting at the end (sub-pixel rounding). */
const END_TOLERANCE = 2;

/**
 * Looks again whenever `transcript`'s box changes size, until the returned function is called.
 * `repin` puts the transcript at its end the way a new message does, and is the page's to refuse
 * (a person editing, history loading, a smooth scroll the person started).
 */
export function keepPinnedThroughResize(transcript: HTMLElement, repin: () => void): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {};
  const distanceToEnd = (): number =>
    transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop;
  // Whether the transcript rested at its end the last time anything said where it is: a scroll, or
  // the box changing size. Content that grows without a scroll leaves this as it was, which is the
  // point: the page's own pin follows that growth, and the box shrinking after it still finds the
  // transcript following the end.
  let atEnd = distanceToEnd() <= END_TOLERANCE;
  const follow = (): void => {
    atEnd = distanceToEnd() <= END_TOLERANCE;
  };
  // A person who takes the transcript (wheel, touch, drag, key) moves it, and every move is a scroll
  // that says where it rests now; one who only presses a control at the end has not left the end.
  const resizes = new ResizeObserver(() => {
    if (atEnd) repin();
    follow();
  });
  resizes.observe(transcript);
  transcript.addEventListener('scroll', follow, { passive: true });
  return () => {
    resizes.disconnect();
    transcript.removeEventListener('scroll', follow);
  };
}
