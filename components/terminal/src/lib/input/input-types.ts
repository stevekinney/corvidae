import type { AttachmentTerms, ProtocolResult } from '@lostgradient/ventriloquist';

/**
 * The narrowest view of the client controller that the input path consumes. It is structural, in
 * the way `TerminalRendererController` is: the controller that owns the wire conversation
 * satisfies it, and the terminal borrows it without ever disposing it.
 *
 * `input` offers one operation's bytes to the wire. It returns the protocol's own typed result so
 * the refusal code survives, and it may throw when the transport fails after the frame was built:
 * delivery is then unknown, which this package never treats as success and never replays.
 */
export type TerminalInputController = {
  /** Offer `data` as one input operation. A throw means delivery is unknown. */
  input(data: Uint8Array): ProtocolResult<unknown>;
  /** The controller may no longer send input: it asked to stop, or the host revoked it. */
  readonly authorityRevoked: boolean;
  /** The negotiated frame and operation budgets, once the host's capabilities were accepted. */
  readonly terms: Pick<AttachmentTerms, 'maxFrameBytes' | 'maxQueuedOperations'> | undefined;
};

/** The most paste text one operation may carry by default: 64 KiB, from the security budgets. */
export const DEFAULT_MAXIMUM_PASTE_BYTES = 64 * 1024;
/** The smallest and largest paste limit a host may configure: 1 to 256 KiB. */
export const MINIMUM_PASTE_BYTES = 1;
export const MAXIMUM_PASTE_BYTES = 256 * 1024;

/** The ETX byte a terminal sends to interrupt the foreground process. */
export const INTERRUPT_BYTE = 0x03;

/** Why input did not (fully) reach the wire. Nothing is queued, retried, or replayed for any. */
export type InputRefusalReason =
  /** The view is not writable: the state says so, or the controller's authority was revoked. */
  | 'read-only'
  /**
   * The operation queue is full. The refused input was not sent, and input stays paused until the
   * view leaves and returns to the writable state, because a later keystroke could change what the
   * dropped one meant.
   */
  | 'paused'
  /** There is no live controller, or it reported the attachment gone. */
  | 'closed'
  /** One piece of input cannot fit one frame without being split mid-sequence; nothing was sent. */
  | 'oversized'
  /** The report cannot be encoded to bytes without rewriting it; nothing was sent. */
  | 'malformed'
  /** A failure after some input was sent, or an unknown delivery, froze input for good. */
  | 'frozen'
  /** The transport failed after the frame was built, so the host may or may not have it. */
  | 'unknown-delivery'
  /** The key routing threw, so the key was rejected and nothing was sent. */
  | 'hook-failed';

/** A deliberate action that sends input: a paste or the Interrupt control. */
export type InputRefusalSource = 'paste' | 'interrupt';

export type InputRefusal = {
  reason: InputRefusalReason;
  /** For a multi-operation input, how many operations were accepted before the refusal. */
  acceptedOperations?: number;
  /** For a multi-operation input, how many operations it was split into. */
  totalOperations?: number;
  /**
   * Set when the reader asked for this input with a deliberate action rather than by typing, so
   * the refusal is worth telling them about even when typing would be refused silently.
   */
  source?: InputRefusalSource;
};

/** The platform family key routing needs. */
export type InputPlatform = 'mac' | 'other';

/** What the component feeds the input path, read again at every event. */
export type InputSettings = {
  /** Whether the state accepts input at all (a `writable` view). */
  writable: boolean;
  /** The configured paste limit in UTF-8 bytes; invalid values were already replaced. */
  maximumPasteBytes: number;
  platform: InputPlatform;
};
