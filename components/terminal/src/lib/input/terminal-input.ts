import type { RendererEngine } from '../components/terminal/terminal-engine-adapter.ts';
import { encodeBinaryReport, encodeTextReport } from './input-bytes.ts';
import { planInputChunks } from './input-chunking.ts';
import {
  INTERRUPT_BYTE,
  type InputRefusal,
  type InputRefusalReason,
  type InputRefusalSource,
  type InputSettings,
  type TerminalInputController,
} from './input-types.ts';
import { routeKey } from './key-routing.ts';
import { isMouseReport } from './mouse-report.ts';
import { analyzePaste, reviewPaste, type PasteReview } from './paste-review.ts';

/** What the input path needs of the engine; the full adapter satisfies it. */
export type InputEngine = Pick<
  RendererEngine,
  | 'onInput'
  | 'setKeyHook'
  | 'hasSelection'
  | 'paste'
  | 'focus'
  | 'bracketedPaste'
  | 'mouseTracking'
  | 'onModeChange'
>;

export type TerminalInputOptions = {
  engine: InputEngine;
  /** The element the engine rendered into. Paste is intercepted here, ahead of the engine. */
  host: HTMLElement;
  /** The controller input is sent to. Fixed for this binding: a new session is a new binding. */
  controller: TerminalInputController | undefined;
  readSettings: () => InputSettings;
  /**
   * Whether `node` is one of the terminal's own controls (capture, interrupt). They sit outside
   * `host`, and focus moving to one as it is pressed must not release capture, or a press on the
   * capture button would find capture already off and turn it back on.
   */
  isTerminalControl?: (node: Node) => boolean;
  /**
   * Mouse reporting became active or inactive: opted in, tracked by the program, captured and
   * writable. `announce` is true when the program changed it, and false when capture or the view
   * did, which have announcements of their own.
   */
  onMouseReportingChange?: (active: boolean, announce: boolean) => void;
  onCaptureChange: (captured: boolean) => void;
  /** A paste review opened (a review) or ended (`undefined`). The caller shows it. */
  onReview: (review: PasteReview | undefined) => void;
  /** Input, or part of it, did not reach the wire. Nothing is retried. */
  onRefused: (refusal: InputRefusal) => void;
  /** The reader copied the engine's selection. Called once per copy; the native copy is untouched. */
  onCopy?: () => void;
};

export type TerminalInput = {
  /** Whether Tab and Shift+Tab go to the engine instead of the page. */
  readonly captured: boolean;
  /** Enter capture and focus the engine; `false` when the view takes no input or focus did not land. */
  capture(): boolean;
  /** Leave capture. */
  release(): void;
  /**
   * Give capture back after a paste review closed, if it was on when the review opened. The review
   * took focus, which ended capture; call this once the review is gone and focus can return.
   */
  resumeCapture(): void;
  /** Focus left the terminal or its capture control for `next`: capture ends unless it stayed. */
  focusLeft(next: EventTarget | null): void;
  /** Send the interrupt byte, then return focus to the engine so the reader stays in the terminal. */
  interrupt(): void;
  /** Send the reviewed paste. */
  acceptPaste(): void;
  /** Close the review without sending. */
  cancelPaste(): void;
  /** Settings changed: a view that no longer takes input leaves capture. */
  refresh(): void;
  /** Stop listening and sending. Whatever was pending is dropped, never sent late. */
  dispose(): void;
};

/** The refusal a failed controller operation maps to. */
function reasonForFailureCode(code: string): InputRefusalReason {
  switch (code) {
    case 'read-only':
      return 'read-only';
    case 'fifo-full':
      return 'paused';
    case 'frame-too-large':
      return 'oversized';
    case 'transport-failed':
    case 'backend-failed':
      return 'unknown-delivery';
    default:
      return 'closed';
  }
}

/**
 * Binds one session's input path to one mounted engine, and releases all of it exactly once.
 *
 * Everything the user can do to the shell passes through here, so this is where authority is
 * enforced for feedback (the host enforces it for security). The rules, in order:
 *
 * - The engine's key hook runs the routing in `key-routing.ts`; a throwing hook rejects that key
 *   and sends nothing.
 * - Engine reports become bytes by their own conversion, are split between atoms to fit one frame,
 *   and are offered to the controller in order. Nothing is queued while input is refused, retried
 *   after a failure, or replayed: input that did not reach the wire is gone.
 * - A failure after some of an input was accepted, or a delivery that may or may not have
 *   happened, freezes input for the life of this binding. The shell has seen part of the input and
 *   no later input can be trusted to mean what its author meant.
 * - Paste is intercepted before the engine sees it. A multiline or control-bearing paste is held
 *   for review; an accepted one goes through the engine so bracketing and line-break conversion
 *   stay the engine's; nothing is sent from a paste that was cancelled.
 */
export function createTerminalInput(options: TerminalInputOptions): TerminalInput {
  const { engine, host, controller } = options;
  let disposed = false;
  let frozen = false;
  /** The queue refused an input: nothing is offered until the view is writable again. */
  let saturated = false;
  /** While saturated, the view has been seen out of the writable state since the refusal. */
  let leftWritable = false;
  let captured = false;
  /** The engine is converting a paste, so what it reports is the paste and not typing. */
  let pasting = false;
  /** Capture was on when a review opened, and has not been given back yet. */
  let resumeAfterReview = false;
  let review: PasteReview | undefined;
  /** Keys held down while the review was open, and so still mid-press when it closed. */
  const heldDuringReview = new Set<string>();
  /** Keys whose remaining keydown, keypress and keyup events belong to a closed overlay. */
  const latchedKeys = new Set<string>();
  const document = host.ownerDocument;

  function refuse(refusal: InputRefusal): void {
    // Capture only means something while the terminal can take input. Authority that was revoked
    // or an input path that closed, with the state still `writable`, ends it as a lost state would.
    if (refusal.reason === 'read-only' || refusal.reason === 'closed') setCaptured(false);
    options.onRefused(refusal);
  }

  /** Why input is not accepted right now, or `undefined` when it is. */
  function refusalReason(): InputRefusalReason | undefined {
    if (disposed) return 'closed';
    if (frozen) return 'frozen';
    const settings = options.readSettings();
    if (!settings.writable) return settings.paused === true ? 'paused' : 'read-only';
    if (controller === undefined) return 'closed';
    if (controller.authorityRevoked) return 'read-only';
    return saturated ? 'paused' : undefined;
  }

  /** Whether pointer events may become input right now: opted in, captured and able to send. */
  function mouseReportingPermitted(): boolean {
    return options.readSettings().mouseReporting && captured && refusalReason() === undefined;
  }

  let mouseActive = false;
  /** Tell the caller when reporting turned on or off, once per change. */
  function syncMouseReporting(announce: boolean): void {
    const active = !disposed && engine.mouseTracking && mouseReportingPermitted();
    if (active === mouseActive) return;
    mouseActive = active;
    options.onMouseReportingChange?.(active, announce);
  }

  function setCaptured(next: boolean): void {
    if (captured === next) return;
    captured = next;
    options.onCaptureChange(next);
    syncMouseReporting(false);
  }

  const stopModeChanges = engine.onModeChange(() => syncMouseReporting(true));

  function freeze(): void {
    frozen = true;
    setCaptured(false);
  }

  function send(bytes: Uint8Array, kind: 'text' | 'binary', source?: InputRefusalSource): void {
    const reason = refusalReason();
    if (reason !== undefined || controller === undefined) {
      refuse({ reason: reason ?? 'closed', ...(source && { source }) });
      return;
    }
    const terms = controller.terms;
    if (terms === undefined) {
      refuse({ reason: 'closed', ...(source && { source }) });
      return;
    }
    // The advertised frame budget limits an input frame's payload; its fixed header is extra.
    const limit = terms.maxFrameBytes;
    // A binary report is a handful of raw bytes; it is whole or it is refused, never split.
    const chunks =
      kind === 'binary'
        ? bytes.length <= limit
          ? [bytes]
          : undefined
        : planInputChunks(bytes, limit);
    if (chunks === undefined || chunks.length > terms.maxQueuedOperations) {
      refuse({ reason: 'oversized', ...(source && { source }) });
      return;
    }
    const total = chunks.length;
    for (const [accepted, chunk] of chunks.entries()) {
      // Authority can change between operations; the rest of an input is not sent without it.
      const lost = accepted === 0 ? undefined : refusalReason();
      let failure: InputRefusalReason | undefined = lost;
      if (failure === undefined) {
        try {
          const result = controller.input(chunk);
          if (!result.ok) failure = reasonForFailureCode(result.failure.code);
        } catch {
          failure = 'unknown-delivery';
        }
      }
      if (failure === undefined) continue;
      // Part of an input is on the wire, or its fate is unknown: nothing after it can be trusted.
      if (accepted > 0 || failure === 'unknown-delivery') freeze();
      // Nothing of this input is on the wire, but a later keystroke sent in its place could change
      // what the dropped one meant, so a full queue holds input until the view is writable again.
      else if (failure === 'paused') saturated = true;
      refuse({
        reason: failure,
        acceptedOperations: accepted,
        totalOperations: total,
        ...(source && { source }),
      });
      return;
    }
  }

  /** A latched key's keyup can land outside the terminal, on a dialog still fading out. */
  function releaseLatch(event: KeyboardEvent): void {
    latchedKeys.delete(event.code || event.key);
  }
  document.addEventListener('keyup', releaseLatch);

  const stopInput = engine.onInput((report) => {
    if (disposed) return;
    // A pointer report is neither typing nor a refusal worth telling anyone about: it is dropped,
    // and the pointer does selection instead. A paste is never mistaken for one.
    if (!pasting && engine.mouseTracking && isMouseReport(report) && !mouseReportingPermitted()) {
      return;
    }
    const bytes =
      report.kind === 'text' ? encodeTextReport(report.data) : encodeBinaryReport(report.data);
    if (bytes === undefined) {
      refuse({ reason: 'malformed' });
      return;
    }
    send(bytes, report.kind, pasting ? 'paste' : undefined);
  });

  function trackReviewKey(event: KeyboardEvent): void {
    const key = event.code || event.key;
    if (event.type === 'keydown') heldDuringReview.add(key);
    else heldDuringReview.delete(key);
  }

  function closeReview(): void {
    if (review === undefined) return;
    review = undefined;
    document.removeEventListener('keydown', trackReviewKey, true);
    document.removeEventListener('keyup', trackReviewKey, true);
    // A key still down closed the review (Enter on a button); its press continues at the engine.
    for (const key of heldDuringReview) latchedKeys.add(key);
    heldDuringReview.clear();
    options.onReview(undefined);
  }

  function openReview(next: PasteReview): void {
    review = next;
    // The dialog is about to take focus, which ends capture; the paste happened while it was on.
    resumeAfterReview ||= captured;
    document.addEventListener('keydown', trackReviewKey, true);
    document.addEventListener('keyup', trackReviewKey, true);
    options.onReview(next);
  }

  function handleKey(event: KeyboardEvent): boolean {
    const key = event.code || event.key;
    if (latchedKeys.has(key)) {
      if (event.type === 'keyup') latchedKeys.delete(key);
      return false;
    }
    const decision = routeKey(event, {
      overlayOpen: review !== undefined,
      platform: options.readSettings().platform,
      captured,
      writable: refusalReason() === undefined,
      hasSelection: () => engine.hasSelection(),
    });
    if (decision.preventDefault) event.preventDefault();
    if (event.type === 'keydown') {
      if (decision.effect === 'release-capture') setCaptured(false);
      else if (decision.effect === 'interrupt') send(Uint8Array.of(INTERRUPT_BYTE), 'text');
      else if (decision.effect === 'copy-selection') noteCopy(event.timeStamp);
    }
    return decision.process;
  }

  engine.setKeyHook((event) => {
    if (disposed) return false;
    try {
      return handleKey(event);
    } catch {
      // The key is rejected: nothing was sent for it, and the browser does not act on it either.
      event.preventDefault();
      refuse({ reason: 'hook-failed' });
      return false;
    }
  });

  function pasteThroughEngine(text: string): void {
    pasting = true;
    try {
      engine.paste(text);
    } finally {
      pasting = false;
    }
  }

  function handlePaste(event: ClipboardEvent): void {
    // The engine would convert and send the paste at once. It is handled here, or not at all.
    event.preventDefault();
    event.stopPropagation();
    if (disposed || review !== undefined) return;
    const reason = refusalReason();
    if (reason !== undefined) {
      refuse({ reason, source: 'paste' });
      return;
    }
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text === '') return;
    const limit = options.readSettings().maximumPasteBytes;
    const analysis = analyzePaste(text, limit);
    // Bracketed mode reviews every paste, even a plain line: its bytes go out between the markers.
    if (!analysis.tooLarge && !analysis.needsReview && !engine.bracketedPaste) {
      pasteThroughEngine(text);
    } else {
      openReview(reviewPaste(text, limit, engine.bracketedPaste));
    }
  }

  /**
   * Whether `value` is a DOM node, whichever realm made it. An element from a same-origin iframe is
   * not an instance of this realm's `Node`, so the check cannot be `instanceof`.
   */
  function isNode(value: EventTarget | null): value is Node {
    return value !== null && typeof (value as Partial<Node>).nodeType === 'number';
  }

  function focusLeft(next: EventTarget | null): void {
    const stayed =
      isNode(next) && (host.contains(next) || options.isTerminalControl?.(next) === true);
    if (!stayed) setCaptured(false);
  }

  function handleFocusOut(event: FocusEvent): void {
    // A key that was down when the review closed has its keyup go wherever focus went; the latch
    // must not outlive the focus it was set for and swallow a later, ordinary press.
    latchedKeys.clear();
    focusLeft(event.relatedTarget);
  }

  /**
   * While the program tracks the mouse the engine reports every press instead of selecting, unless
   * a modifier asks for selection (Shift, or Option on a Mac). When reporting is not permitted the
   * press is handed to the engine again with that modifier, so native selection wins.
   */
  let rewriting = false;
  function handleMouseDown(event: MouseEvent): void {
    if (rewriting || event.button !== 0 || !engine.mouseTracking || mouseReportingPermitted()) {
      return;
    }
    const mac = options.readSettings().platform === 'mac';
    if (mac ? event.altKey : event.shiftKey) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    rewriting = true;
    try {
      event.target?.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: event.view,
          detail: event.detail,
          button: event.button,
          buttons: event.buttons,
          clientX: event.clientX,
          clientY: event.clientY,
          screenX: event.screenX,
          screenY: event.screenY,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: mac ? event.shiftKey : true,
          altKey: mac ? true : event.altKey,
        }),
      );
    } finally {
      rewriting = false;
    }
  }

  // Capture phase on the host runs before the engine's own listeners on the nodes below it.
  // A copy that began in the engine and has a selection is the reader copying terminal output.
  // The event is only observed: the engine and the browser complete the copy themselves.
  // Some engines raise no `copy` event for their own selection (Chromium), so the copy chord is
  // also a source. A `copy` event that follows the chord within this window is the same copy.
  const SAME_COPY_MILLISECONDS = 500;
  let lastChordCopy = Number.NEGATIVE_INFINITY;

  function noteCopy(timeStamp: number): void {
    lastChordCopy = timeStamp;
    options.onCopy?.();
  }

  function handleCopy(event: Event): void {
    if (disposed) return;
    if (event.timeStamp - lastChordCopy < SAME_COPY_MILLISECONDS) return;
    const target = event.target;
    if (!isNode(target) || !host.contains(target)) return;
    if (engine.hasSelection()) options.onCopy?.();
  }

  host.addEventListener('copy', handleCopy);
  host.addEventListener('paste', handlePaste, true);
  host.addEventListener('focusout', handleFocusOut);
  host.addEventListener('mousedown', handleMouseDown, true);

  function capture(): boolean {
    if (refusalReason() !== undefined) return false;
    engine.focus();
    const active = document.activeElement;
    if (active === null || !host.contains(active)) return false;
    setCaptured(true);
    return true;
  }

  return {
    get captured() {
      return captured;
    },
    capture,
    release() {
      setCaptured(false);
    },
    resumeCapture() {
      if (!resumeAfterReview) return;
      resumeAfterReview = false;
      capture();
    },
    focusLeft,
    interrupt() {
      send(Uint8Array.of(INTERRUPT_BYTE), 'text', 'interrupt');
      if (!disposed) engine.focus();
    },
    acceptPaste() {
      const accepted = review;
      if (accepted?.kind === 'confirm' && accepted.bracketedPaste !== engine.bracketedPaste) {
        // The mode changed while the reader decided, so what they approved described another
        // paste. Show it again as it would now go out; nothing is sent until they accept that.
        review = reviewPaste(
          accepted.text,
          options.readSettings().maximumPasteBytes,
          engine.bracketedPaste,
        );
        options.onReview(review);
        return;
      }
      closeReview();
      if (accepted?.kind !== 'confirm') return;
      // Authority can be revoked while the reader decides; the paste is then dropped, not queued.
      const reason = refusalReason();
      if (reason !== undefined) {
        refuse({ reason, source: 'paste' });
        return;
      }
      if (accepted.bytes > options.readSettings().maximumPasteBytes) {
        refuse({ reason: 'oversized', source: 'paste' });
        return;
      }
      pasteThroughEngine(accepted.text);
    },
    cancelPaste: closeReview,
    refresh() {
      // A full queue ends when the host reports the view out of the writable state and back.
      if (saturated) {
        if (!options.readSettings().writable) leftWritable = true;
        else if (leftWritable) saturated = leftWritable = false;
      }
      if (captured && refusalReason() !== undefined) setCaptured(false);
      syncMouseReporting(false);
    },
    dispose() {
      if (disposed) return;
      closeReview();
      disposed = true;
      resumeAfterReview = false;
      setCaptured(false);
      syncMouseReporting(false);
      stopModeChanges();
      stopInput();
      engine.setKeyHook(undefined);
      host.removeEventListener('copy', handleCopy);
      host.removeEventListener('paste', handlePaste, true);
      host.removeEventListener('focusout', handleFocusOut);
      host.removeEventListener('mousedown', handleMouseDown, true);
      document.removeEventListener('keyup', releaseLatch);
    },
  };
}
