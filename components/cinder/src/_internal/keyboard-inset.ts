/**
 * The CSS custom property that carries how much of the layout viewport the on-screen keyboard
 * covers, in pixels. It is set on the document element while something that has to ride above the
 * keyboard (a docked action bar, a bottom sheet, the toast region) is mounted, and removed after.
 */
export const KEYBOARD_INSET_PROPERTY = '--_cinder-keyboard-inset';

let trackers = 0;
let stopListening: (() => void) | null = null;

/** The height of the layout viewport the visual viewport no longer covers, never negative. */
function readKeyboardInset(): number {
  const visualViewport = window.visualViewport;
  // A pinch zoom shrinks the visual viewport too, and that is not a keyboard.
  if (!visualViewport || visualViewport.scale !== 1) return 0;
  return Math.max(
    0,
    Math.round(window.innerHeight - visualViewport.height - visualViewport.offsetTop),
  );
}

function startListening(): () => void {
  const root = document.documentElement;
  const visualViewport = window.visualViewport;
  const publish = () => root.style.setProperty(KEYBOARD_INSET_PROPERTY, `${readKeyboardInset()}px`);
  publish();
  visualViewport?.addEventListener('resize', publish);
  visualViewport?.addEventListener('scroll', publish);
  return () => {
    visualViewport?.removeEventListener('resize', publish);
    visualViewport?.removeEventListener('scroll', publish);
    root.style.removeProperty(KEYBOARD_INSET_PROPERTY);
  };
}

/**
 * Starts publishing `--_cinder-keyboard-inset` and returns the function that stops it. Callers share
 * one listener: the property is removed once the last caller has stopped. On the server, and where
 * `visualViewport` is missing, the property is `0px` and nothing is listened to.
 */
export function trackKeyboardInset(): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {};
  trackers += 1;
  if (trackers === 1) stopListening = startListening();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    trackers -= 1;
    if (trackers === 0) {
      stopListening?.();
      stopListening = null;
    }
  };
}
