import type { TerminalFrameStatus } from '@lostgradient/cinder';
import type { HTMLAttributes } from 'svelte/elements';

import type { InputRefusal, TerminalInputController } from '../../input/input-types.ts';

/**
 * The interaction states the terminal surface renders, as specified in
 * `documentation/terminal/experience.md`. The renderer owns the display of every state; which
 * state applies is decided by the session controller and passed in.
 */
export type TerminalState =
  | 'empty'
  | 'loading'
  | 'connecting'
  | 'writable'
  | 'read-only'
  | 'backpressured'
  | 'exited'
  | 'disconnected'
  | 'denied'
  | 'failed'
  | 'cleanup-incomplete'
  | 'engine-load-failed';

/**
 * The closed `TerminalFrame` status each terminal state renders inside. Copy and recovery controls
 * refine a state; they never introduce another frame status.
 */
export const TERMINAL_FRAME_STATUS: Readonly<Record<TerminalState, TerminalFrameStatus>> = {
  empty: 'disconnected',
  loading: 'connecting',
  connecting: 'connecting',
  writable: 'connected',
  'read-only': 'connected',
  backpressured: 'connected',
  exited: 'disconnected',
  disconnected: 'disconnected',
  denied: 'error',
  failed: 'error',
  'cleanup-incomplete': 'error',
  'engine-load-failed': 'error',
};

/** The visible status text for each state, which is also exposed to assistive technology. */
export const TERMINAL_STATE_MESSAGE: Readonly<Record<TerminalState, string>> = {
  empty: 'No terminal session',
  loading: 'Loading terminal…',
  connecting: 'Connecting…',
  writable: 'Connected',
  'read-only': 'Read-only',
  backpressured: 'Backpressure: input paused',
  exited: 'Process exited',
  disconnected: 'Disconnected',
  denied: 'Access denied',
  failed: 'Terminal failed',
  'cleanup-incomplete': 'Cleanup incomplete—new sessions are disabled',
  'engine-load-failed': 'Terminal engine unavailable',
};

/** Measured character-cell geometry. Only positive finite whole numbers are ever reported. */
export type TerminalGeometry = {
  columns: number;
  rows: number;
};

/**
 * Receives one chunk of terminal output bytes. The renderer calls `parsed` exactly once per chunk,
 * when the engine has finished parsing it. That is the accepted parse boundary: painting may still
 * be pending, and a chunk written to an engine that has since been disposed is never acknowledged.
 */
export type TerminalOutputListener = (chunk: Uint8Array, parsed: () => void) => void;

/** Where in its life the renderer failed. */
export type TerminalRendererFailurePhase = 'load' | 'initialize' | 'parse' | 'render';

/** A renderer failure. The renderer fails closed: it disposes the engine and shows the failure. */
export type TerminalRendererFailure = {
  phase: TerminalRendererFailurePhase;
  message: string;
};

/**
 * The narrowest view of a session controller the renderer consumes. The component borrows the
 * controller it is given: replacing or unmounting the component unsubscribes from it and never
 * disposes it, terminates its process, or closes its attachment.
 */
export type TerminalRendererController = {
  /** Subscribe to ordered output bytes. The returned function unsubscribes. */
  subscribeOutput(listener: TerminalOutputListener): () => void;
  /**
   * The renderer failed and has already disposed its engine. The controller revokes input and
   * runs cleanup; the renderer never switches engines, resets silently, or replays input.
   */
  rendererFailed(failure: TerminalRendererFailure): void;
  /**
   * Where input goes. Absent, the terminal is a viewer: it sends nothing, whatever its state says.
   * Replacing the controller ends the old session's input for good; nothing is sent to it again.
   */
  readonly input?: TerminalInputController;
};

export type TerminalProps = Omit<HTMLAttributes<HTMLDivElement>, 'class' | 'title'> & {
  /** Title shown in the frame chrome. */
  title: string;
  /** The state to render. Defaults to `'empty'`. @default 'empty' */
  state?: TerminalState;
  /** Recovery message shown with the frame's reload control while it is non-empty. */
  error?: string;
  /** Called when the reader activates the frame's recovery control. */
  onRecoveryRequest?: () => void;
  /**
   * The session controller whose output the terminal renders. It is borrowed: the terminal
   * unsubscribes when the controller is replaced or the component unmounts and never disposes it.
   */
  controller?: TerminalRendererController;
  /**
   * Called with the engine's measured geometry, once per accepted change. The engine's cell
   * measurement is the sole resize authority; the frame's own estimate is never forwarded. A
   * read-only terminal never calls it.
   */
  onGeometryChange?: (geometry: TerminalGeometry) => void;
  /**
   * The grid the session's owner dictates. A `'read-only'` terminal adopts it, scrolling locally
   * when it is larger than the viewport, instead of fitting itself to the viewport.
   */
  ownerGeometry?: TerminalGeometry;
  /** Accessible name of the terminal input surface. @default 'Terminal' */
  ariaLabel?: string;
  /** Mirror engine output into a bounded screen-reader live region. @default false */
  announceOutput?: boolean;
  /**
   * Called with a visible HTTPS address the reader deliberately activated. Links are disabled
   * unless this is set; hidden OSC 8 destinations, paths, and other schemes are never offered.
   */
  onLinkActivate?: (url: string) => void;
  /** Called with the terminal title the program set, as bounded plain text. */
  onTitleChange?: (title: string) => void;
  /**
   * The most paste text, in UTF-8 bytes, that is offered for review. A larger paste is refused
   * whole and nothing is sent. An integer from 1 to 262144; anything else uses the default.
   * @default 65536
   */
  maximumPasteBytes?: number;
  /**
   * Called when input, or part of it, did not reach the wire. Input is never queued, retried, or
   * replayed, so this is the machine-readable record of what was dropped and why; the reader is
   * also told through the status region, except for typing into a read-only view.
   */
  onInputRefused?: (refusal: InputRefusal) => void;
  /** Additional class merged with the component's root class. */
  class?: string;
};
