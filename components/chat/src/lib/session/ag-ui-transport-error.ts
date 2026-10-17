/** Why an AG-UI event stream could not be turned into chat frames. */
export type AGUIChatTransportErrorKind =
  /** An event failed the pinned `@ag-ui/core` schema. */
  | 'invalid-event'
  /** Events arrived in an order the AG-UI protocol does not allow. */
  | 'protocol'
  /** The stream ended before `RUN_FINISHED` or `RUN_ERROR`. */
  | 'incomplete-stream'
  /** The messages a run produced could not be assembled into a conversation. */
  | 'history';

/**
 * Thrown from the transport's frame stream, which fails the run: the
 * controller aborts the turn, rolls its rows back, and rejects `sendMessage`
 * with this error. `eventIndex` is the zero-based position of the offending
 * event, and is absent when the stream ended without one.
 */
export class AGUIChatTransportError extends Error {
  readonly kind: AGUIChatTransportErrorKind;
  readonly eventIndex: number | undefined;

  constructor(
    kind: AGUIChatTransportErrorKind,
    message: string,
    options: { eventIndex?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AGUIChatTransportError';
    this.kind = kind;
    this.eventIndex = options.eventIndex;
  }
}
