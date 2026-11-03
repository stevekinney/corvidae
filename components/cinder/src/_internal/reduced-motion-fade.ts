import type { Attachment } from 'svelte/attachments';

/**
 * How long a reduced-motion cross-fade lasts, in milliseconds.
 *
 * It is a literal, not a `--cinder-duration-*` token, because those tokens collapse to `0ms` under
 * `prefers-reduced-motion` and `foundation.css` forces every CSS transition and animation to
 * `0.01ms !important` there. A fade that has to survive reduced motion is therefore driven through
 * the Web Animations API, which neither rule reaches.
 */
export const REDUCED_MOTION_FADE_MILLISECONDS = 150;

/**
 * How long past the fade's own duration `finished` waits for the animation's `finish` event before
 * settling anyway. An animation's `finish` event is sent from the rendering loop, so a page that is
 * not rendering (a background tab) would never send it, and a dialog waiting on it would stay open.
 * The same safety net `waitForTransitionCompletion` keeps for `transitionend`.
 */
const FINISH_EVENT_GRACE_MILLISECONDS = 100;

/** A running reduced-motion fade. */
export type ReducedMotionFade = {
  /** Settles once the fade has played to its end. It never rejects. */
  readonly finished: Promise<void>;
  /** Stops the fade and leaves the element as it was authored. It does not settle `finished`. */
  cancel: () => void;
};

/**
 * Fades an element in or out with the Web Animations API, for the surfaces that cross-fade instead
 * of sliding when the person asked for less motion (the drawer, and every sheet).
 *
 * Returns `null` where `Element.animate` is missing, so the caller falls back to an immediate
 * change instead of waiting on an animation that can never run.
 */
export function playReducedMotionFade(
  element: HTMLElement,
  direction: 'in' | 'out',
): ReducedMotionFade | null {
  if (typeof element.animate !== 'function') return null;
  const keyframes: Keyframe[] =
    direction === 'in' ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }];
  const animation = element.animate(keyframes, {
    duration: REDUCED_MOTION_FADE_MILLISECONDS,
    easing: 'ease-out',
    fill: direction === 'out' ? 'forwards' : 'none',
  });
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  const finished = new Promise<void>((resolve) => {
    const settle = () => {
      clearTimeout(fallbackTimer);
      resolve();
    };
    animation.addEventListener('finish', settle);
    fallbackTimer = setTimeout(
      settle,
      REDUCED_MOTION_FADE_MILLISECONDS + FINISH_EVENT_GRACE_MILLISECONDS,
    );
  });
  return {
    finished,
    cancel: () => {
      clearTimeout(fallbackTimer);
      animation.cancel();
    },
  };
}

/**
 * Attachment that fades its element in when it mounts and `active()` is true. `active` is read
 * once, at mount, so a later change in the motion preference never replays the fade.
 */
export function reducedMotionFadeIn(active: () => boolean): Attachment<HTMLElement> {
  return (element) => {
    if (!active()) return undefined;
    const fade = playReducedMotionFade(element, 'in');
    return () => fade?.cancel();
  };
}
