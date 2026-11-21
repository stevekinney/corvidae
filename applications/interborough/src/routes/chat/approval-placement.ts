/**
 * Keeps a waiting approval placed under the chat header while the header or transcript changes size.
 *
 * The chat's header is laid over the top of the transcript, and its title and status arrive after
 * the chat opens, so the header is taller when it settles than when the approval was first placed.
 * While arrival placement is in force, a change in either box places the approval again. The
 * transcript can shrink while the header stays the same height, such as when a phone rotates. The placement ends at the first input of the person's that scrolls
 * the transcript (a wheel turn, a touch move, a press on it, a key); the placement's own scrolling
 * and the transcript's pin to its end are programmatic and never end it. No other state gates it:
 * not where focus is, and not where the transcript's scroll position is.
 */

/** The events that are a person's own scrolling of the transcript. */
const USER_SCROLL_EVENTS = ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const;

export type ApprovalPlacement = {
  /** The approval was placed in `transcript`: observe its size until the person scrolls. */
  placed: (transcript: HTMLElement) => void;
  /** The header's height changed. */
  headerChanged: () => void;
  /** Ends the placement and removes its listeners. */
  release: () => void;
};

/**
 * @param place - Places the approval again, against the boxes as they are now.
 */
export function createApprovalPlacement(place: () => void): ApprovalPlacement {
  let transcript: HTMLElement | undefined;
  let controller: AbortController | undefined;
  let observer: ResizeObserver | undefined;

  const release = (): void => {
    observer?.disconnect();
    observer = undefined;
    controller?.abort();
    controller = undefined;
    transcript = undefined;
  };

  const placeAgain = (): void => {
    if (transcript?.isConnected === true) place();
  };

  return {
    placed(next) {
      if (transcript === next) return;
      release();
      transcript = next;
      controller = new AbortController();
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(() => {
          if (transcript === next) placeAgain();
        });
        observer.observe(next);
      }
      for (const type of USER_SCROLL_EVENTS) {
        next.addEventListener(type, release, { passive: true, signal: controller.signal });
      }
    },
    headerChanged: placeAgain,
    release,
  };
}
