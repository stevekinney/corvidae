import type { InputPlatform } from './input-types.ts';

/**
 * Decides what one keyboard event means, in the order `documentation/terminal/experience.md`
 * sets: a focused package overlay first, then a reserved platform or host action, and only then
 * authorized terminal input.
 *
 * The decision is a pure function of the event's key and modifiers, so a key's keydown, keypress
 * and keyup are always decided the same way: a key vetoed on keydown cannot reach the shell
 * through the engine's separate keypress path. Side effects (releasing capture, sending an
 * interrupt) belong to the keydown alone and are reported as an `effect` for the caller to apply.
 *
 * `process` is the answer the engine's key hook returns. The engine (xterm.js 6.0.0) treats only a
 * return value of exactly `false` as "skip this event"; it never prevents the event's default or
 * stops its propagation itself. `preventDefault` therefore says separately whether the browser
 * must be stopped from acting on the key.
 */

export type KeyEventLike = Pick<
  KeyboardEvent,
  'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'isComposing' | 'keyCode'
>;

export type KeyRouteContext = {
  /** A package overlay (the paste review) is open and owns the keyboard. */
  overlayOpen: boolean;
  platform: InputPlatform;
  /** Tab and Shift+Tab go to the engine instead of the page. */
  captured: boolean;
  /** The view accepts input: its state is writable and the controller still has authority. */
  writable: boolean;
  /** Whether the engine holds a non-empty selection. Asked only when a copy chord needs it. */
  hasSelection: () => boolean;
};

export type KeyEffect = 'release-capture' | 'interrupt';

export type KeyDecision = {
  /** Whether the engine should process the event. */
  process: boolean;
  /** Whether to stop the browser's own action for this key. */
  preventDefault: boolean;
  effect?: KeyEffect;
};

/** The engine skips the event and the browser keeps it: page navigation, native copy, reserved chords. */
const LEAVE_TO_BROWSER: KeyDecision = { process: false, preventDefault: false };
const TO_ENGINE: KeyDecision = { process: true, preventDefault: false };
/** The `keyCode` browsers report for every key pressed during IME composition. */
const COMPOSITION_KEY_CODE = 229;

function isComposing(event: KeyEventLike): boolean {
  return event.isComposing || event.keyCode === COMPOSITION_KEY_CODE;
}

function isReleaseChord(event: KeyEventLike): boolean {
  return (
    event.key === 'Escape' && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey
  );
}

/** Chords the browser, operating system or assistive technology owns when they reach the page. */
function isReservedChord(event: KeyEventLike, platform: InputPlatform): boolean {
  if (event.key === 'Tab' && (event.ctrlKey || (event.altKey && platform === 'other'))) return true;
  if (event.metaKey) return true;
  if (platform === 'mac') return event.ctrlKey && event.altKey;
  // AltGr reports Ctrl and Alt together on these platforms, so it is a layout key, not reserved.
  return event.ctrlKey && !event.altKey && ['l', 't', 'w'].includes(event.key.toLowerCase());
}

function isPlainChord(event: KeyEventLike, letter: string): boolean {
  return !event.altKey && !event.shiftKey && event.key.toLowerCase() === letter;
}

/** Cmd+C on a Mac, Ctrl+C elsewhere: the chord that copies a selection. */
function isCopyChord(event: KeyEventLike, platform: InputPlatform): boolean {
  return platform === 'mac'
    ? event.metaKey && !event.ctrlKey && isPlainChord(event, 'c')
    : event.ctrlKey && !event.metaKey && isPlainChord(event, 'c');
}

/** The paste chord, which the browser turns into a `paste` event the review intercepts. */
function isPasteChord(event: KeyEventLike, platform: InputPlatform): boolean {
  if (event.altKey || event.key.toLowerCase() !== 'v') return false;
  return platform === 'mac' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function routeKey(event: KeyEventLike, context: KeyRouteContext): KeyDecision {
  // 1. A package overlay owns the keyboard; nothing reaches the shell while one is open.
  if (context.overlayOpen) return LEAVE_TO_BROWSER;

  // An input method owns every key it is composing. Only a view that takes input composes.
  if (isComposing(event)) return context.writable ? TO_ENGINE : LEAVE_TO_BROWSER;

  // 2. Reserved platform and host actions.
  if (isReleaseChord(event)) {
    return context.captured
      ? { process: false, preventDefault: true, effect: 'release-capture' }
      : LEAVE_TO_BROWSER;
  }
  if (isCopyChord(event, context.platform)) {
    // A selection always wins: native copy, and the interrupt chord is not an interrupt.
    if (context.hasSelection()) return LEAVE_TO_BROWSER;
    // Without one, Cmd+C is the Mac interrupt; Ctrl+C reaches the engine, which sends ETX itself.
    if (context.platform === 'other') return context.writable ? TO_ENGINE : LEAVE_TO_BROWSER;
    return context.writable
      ? { process: false, preventDefault: true, effect: 'interrupt' }
      : LEAVE_TO_BROWSER;
  }
  if (isPasteChord(event, context.platform) || isReservedChord(event, context.platform)) {
    return LEAVE_TO_BROWSER;
  }

  // 3. Authorized terminal input. A view that takes none leaves Tab to the page and lets the
  //    engine scroll; the engine and the sender both refuse to send anything from it.
  const holdsTab = context.writable && context.captured;
  const isTab = event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey;
  if (isTab && !holdsTab) return LEAVE_TO_BROWSER;
  // Safari on a Mac moves focus through buttons and links only with Option held, so without
  // capture Option+Tab is the page's too; on other platforms it is reserved above already.
  if (event.key === 'Tab' && event.altKey && !holdsTab) return LEAVE_TO_BROWSER;
  return TO_ENGINE;
}
