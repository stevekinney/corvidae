/** JSON Schema (draft 2020-12) for the props of the public Terminal component. */
export type TerminalSchema = {
  readonly $schema: 'https://json-schema.org/draft/2020-12/schema';
  readonly type: 'object';
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required: readonly string[];
  readonly metadata: {
    readonly unsupportedProps: ReadonlyArray<{
      readonly name: string;
      readonly reason: 'function-or-snippet' | 'unknown-shape';
      readonly required?: boolean;
      readonly description: string;
    }>;
  };
};

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'Title shown in the frame chrome.',
    },
    state: {
      enum: [
        'empty',
        'loading',
        'connecting',
        'writable',
        'read-only',
        'backpressured',
        'exited',
        'disconnected',
        'denied',
        'failed',
        'cleanup-incomplete',
        'engine-load-failed',
      ],
      description:
        "The state to render. The session controller decides which state applies; the renderer shows an engine failure of its own as 'engine-load-failed'. Default `'empty'`.",
    },
    error: {
      type: 'string',
      description: "Recovery message shown with the frame's reload control while it is non-empty.",
    },
    ownerGeometry: {
      type: 'object',
      properties: {
        columns: { type: 'integer', minimum: 1, maximum: 65535 },
        rows: { type: 'integer', minimum: 1, maximum: 65535 },
      },
      required: ['columns', 'rows'],
      additionalProperties: false,
      description:
        "The grid the session's owner dictates. A `'read-only'` terminal adopts it, scrolling locally when it is larger than the viewport, instead of fitting itself to the viewport.",
    },
    ariaLabel: {
      type: 'string',
      description: 'Accessible name of the terminal input surface. Default `Terminal`.',
    },
    announceOutput: {
      type: 'boolean',
      description:
        'Mirror engine output into a bounded screen-reader live region. Default `false`.',
    },
    mouseReporting: {
      type: 'boolean',
      description:
        'Send the mouse to the program (tmux, vim) as reports, while key capture is on and the view is writable. Default `false`: otherwise the pointer selects text and no report is sent.',
    },
    maximumPasteBytes: {
      type: 'integer',
      minimum: 1,
      maximum: 262144,
      description:
        'The most paste text, in UTF-8 bytes, offered for review. A larger paste is refused whole and nothing is sent. Anything outside the range uses the default. Default `65536`.',
    },
    cleanupPending: {
      type: 'boolean',
      description:
        'Cleanup of the previous attachment has not finished. Replacing the session (`New session`, and `Retry` after a failure) is blocked until it has, so those buttons are disabled. Default `false`.',
    },
    class: {
      type: 'string',
      description: "Additional class merged with the component's root class.",
    },
  },
  required: ['title'],
  metadata: {
    unsupportedProps: [
      {
        name: 'controller',
        reason: 'unknown-shape',
        description:
          'The session controller whose output the terminal renders. It is borrowed: the terminal unsubscribes when the controller is replaced or the component unmounts and never disposes it.',
      },
      {
        name: 'onCancel',
        reason: 'function-or-snippet',
        description:
          'Called when the reader activates `Cancel` in `loading`, `connecting` or `backpressured`. The button renders only when this is provided; the host cancels construction or the connection and returns the state to `empty`, or cancels the unsent operations while the output stays readable.',
      },
      {
        name: 'onCheckCleanup',
        reason: 'function-or-snippet',
        description:
          'Called when the reader activates `Check cleanup` in `cleanup-incomplete`. The button renders only when this is provided; no replacement, retry, input or replay is offered while cleanup is incomplete.',
      },
      {
        name: 'onNewSession',
        reason: 'function-or-snippet',
        description:
          'Called when the reader activates `New session` in `empty`, `writable`, `exited`, `disconnected` or `denied`; `read-only` shows it disabled. The button renders only when this is provided, and is disabled while `cleanupPending` is set. It never resumes or replays a session.',
      },
      {
        name: 'onGeometryChange',
        reason: 'function-or-snippet',
        description:
          "Called with the engine's measured geometry, once per accepted change. The engine's cell measurement is the sole resize authority; the frame's own estimate is never forwarded. A terminal that does not own the grid never calls it.",
      },
      {
        name: 'onInputRefused',
        reason: 'function-or-snippet',
        description:
          'Called when input, or part of it, did not reach the wire. Input is never queued, retried, or replayed, so this is the machine-readable record of what was dropped and why; the reader is also told through the status region, except for typing into a read-only view. `source` is set when a paste or the Interrupt control asked for the input.',
      },
      {
        name: 'onInspectionEvent',
        reason: 'function-or-snippet',
        description:
          'Called with a typed metric when the reader searches, steps through matches, clears, opens or refreshes the accessible output, exports, or activates a listed link. An event holds counts, booleans and fixed words only: never output, a query, a keystroke, an argument, an environment value or a credential. A handler that throws changes nothing about the session.',
      },
      {
        name: 'onLinkActivate',
        reason: 'function-or-snippet',
        description:
          'Called with a visible HTTPS address the reader deliberately activated. Links are disabled unless this is set; hidden OSC 8 destinations, paths, and other schemes are never offered.',
      },
      {
        name: 'onRecoveryRequest',
        reason: 'function-or-snippet',
        description: "Called when the reader activates the frame's recovery control.",
      },
      {
        name: 'onRetry',
        reason: 'function-or-snippet',
        description:
          'Called when the reader activates `Retry` in `failed`. The button renders only when this is provided, and is disabled while `cleanupPending` is set. For `engine-load-failed`, `onRecoveryRequest` is the handler.',
      },
      {
        name: 'onTryAgain',
        reason: 'function-or-snippet',
        description:
          'Called when the reader activates `Try again` in `denied`, which repeats connection authorization only. The button renders only when this is provided.',
      },
      {
        name: 'onTitleChange',
        reason: 'function-or-snippet',
        description: 'Called with the terminal title the program set, as bounded plain text.',
      },
    ],
  },
} satisfies TerminalSchema;

export default schema as TerminalSchema;
