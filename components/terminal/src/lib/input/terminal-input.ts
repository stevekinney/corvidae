import type { RendererEngine } from '../components/terminal/terminal-engine-adapter.ts';
import { encodeBinaryReport, encodeTextReport } from './input-bytes.ts';
import { planInputChunks } from './input-chunking.ts';
import {
  INTERRUPT_BYTE,
  type InputRefusal,
  type InputRefusalReason,
  type InputSettings,
  type TerminalInputController,
} from './input-types.ts';
import { routeKey } from './key-routing.ts';
import { analyzePaste, reviewPaste, type PasteReview } from './paste-review.ts';

/** What the input path needs of the engine; the full adapter satisfies it. */
export type InputEngine = Pick<
  RendererEngine,
  'onInput' | 'setKeyHook' | 'hasSelection' | 'paste' | 'focus'
>;

export type TerminalInputOptions = {
  engine: InputEngine;
  /** The element the engine rendered into. Paste is intercepted here, ahead of the engine. */
  host: HTMLElement;
  /** The controller input is sent to. Fixed for this binding: a new session is a new binding. */
  controller: TerminalInputController | undefined;
  readSettings: () => InputSettings;
  onCaptureChange: (captured: boolean) => void;
  /** A paste review opened (a review) or ended (`undefined`). The caller shows it. */
  onReview: (review: PasteReview | undefined) => void;
  /** Input, or part of it, did not reach the wire. Nothing is retried. */
  onRefused: (refusal: InputRefusal) => void;
};

export type TerminalInput = {
  /** Whether Tab and Shift+Tab go to the engine instead of the page. */
  readonly captured: boolean;
  /** Enter capture and focus the engine; `false` when the view takes no input or focus did not land. */
  capture(): boolean;
  /** Leave capture. */
  release(): void;
  /** Send the interrupt byte. */
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
  let captured = false;
  let review: PasteReview | undefined;
  /** Keys held down while the review was open, and so still mid-press when it closed. */
  const heldDuringReview = new Set<string>();
  /** Keys whose remaining keydown, keypress and keyup events belong to a closed overlay. */
  const latchedKeys = new Set<string>();
  const document = host.ownerDocument;

  function refuse(refusal: InputRefusal): void {
    options.onRefused(refusal);
  }

  /** Why input is not accepted right now, or `undefined` when it is. */
  function refusalReason(): InputRefusalReason | undefined {
    if (disposed) return 'closed';
    if (frozen) return 'frozen';
    if (!options.readSettings().writable) return 'read-only';
    if (controller === undefined) return 'closed';
    return controller.authorityRevoked ? 'read-only' : undefined;
  }

  function setCaptured(next: boolean): void {
    if (captured === next) return;
    captured = next;
    options.onCaptureChange(next);
  }

  function freeze(): void {
    frozen = true;
    setCaptured(false);
  }

  function send(bytes: Uint8Array, kind: 'text' | 'binary'): void {
    const reason = refusalReason();
    if (reason !== undefined || controller === undefined) {
      refuse({ reason: reason ?? 'closed' });
      return;
    }
    const terms = controller.terms;
    if (terms === undefined) {
      refuse({ reason: 'closed' });
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
      refuse({ reason: 'oversized' });
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
      refuse({ reason: failure, acceptedOperations: accepted, totalOperations: total });
      return;
    }
  }

  const stopInput = engine.onInput((report) => {
    if (disposed) return;
    const bytes =
      report.kind === 'text' ? encodeTextReport(report.data) : encodeBinaryReport(report.data);
    if (bytes === undefined) {
      refuse({ reason: 'malformed' });
      return;
    }
    send(bytes, report.kind);
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

  function handlePaste(event: ClipboardEvent): void {
    // The engine would convert and send the paste at once. It is handled here, or not at all.
    event.preventDefault();
    event.stopPropagation();
    if (disposed || review !== undefined) return;
    const reason = refusalReason();
    if (reason !== undefined) {
      refuse({ reason });
      return;
    }
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text === '') return;
    const limit = options.readSettings().maximumPasteBytes;
    const analysis = analyzePaste(text, limit);
    if (!analysis.tooLarge && !analysis.needsReview) engine.paste(text);
    else openReview(reviewPaste(text, limit));
  }

  function handleFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (!(next instanceof Node && host.contains(next))) setCaptured(false);
  }

  // Capture phase on the host runs before the engine's own listeners on the nodes below it.
  host.addEventListener('paste', handlePaste, true);
  host.addEventListener('focusout', handleFocusOut);

  return {
    get captured() {
      return captured;
    },
    capture() {
      if (refusalReason() !== undefined) return false;
      engine.focus();
      const active = document.activeElement;
      if (active === null || !host.contains(active)) return false;
      setCaptured(true);
      return true;
    },
    release() {
      setCaptured(false);
    },
    interrupt() {
      send(Uint8Array.of(INTERRUPT_BYTE), 'text');
    },
    acceptPaste() {
      const accepted = review;
      closeReview();
      if (accepted?.kind !== 'confirm') return;
      // Authority can be revoked while the reader decides; the paste is then dropped, not queued.
      const reason = refusalReason();
      if (reason !== undefined) {
        refuse({ reason });
        return;
      }
      if (accepted.bytes > options.readSettings().maximumPasteBytes) {
        refuse({ reason: 'oversized' });
        return;
      }
      engine.paste(accepted.text);
    },
    cancelPaste: closeReview,
    refresh() {
      if (captured && refusalReason() !== undefined) setCaptured(false);
    },
    dispose() {
      if (disposed) return;
      closeReview();
      disposed = true;
      setCaptured(false);
      stopInput();
      engine.setKeyHook(undefined);
      host.removeEventListener('paste', handlePaste, true);
      host.removeEventListener('focusout', handleFocusOut);
    },
  };
}
