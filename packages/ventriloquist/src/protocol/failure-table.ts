import { FAILURE_CLOSE_CODES, type FailureCode } from './failure-codes.ts';

/** One row of the failure and cleanup table in `documentation/terminal/contract.md`, as data. */
export type FailureDisposition = {
  readonly code: FailureCode;
  /** Which side reports it: the `server`, the `client`, or `either` side. */
  readonly direction: 'server' | 'client' | 'either';
  readonly operation: string;
  /** The "Result and attachment" column, verbatim. */
  readonly resultAndAttachment: string;
  /** Whether the current attachment generation stops being valid. */
  readonly revokesGeneration: boolean;
  /** Whether the ownership slot stays quarantined afterwards. */
  readonly quarantinesSlot: boolean;
  readonly closeCode: number;
  /** The "Drain and cleanup" column, verbatim. */
  readonly drainAndCleanup: string;
};

type DispositionRow = Omit<FailureDisposition, 'code' | 'closeCode'>;

const ROWS: Record<FailureCode, DispositionRow> = {
  'protocol-version-unsupported': {
    direction: 'server',
    operation: 'handshake',
    resultAndAttachment: 'reject; no generation issued',
    revokesGeneration: false,
    quarantinesSlot: false,
    drainAndCleanup: 'discard frame; close transport',
  },
  'malformed-frame': {
    direction: 'either',
    operation: 'decode',
    resultAndAttachment: 'reject; current generation revoked',
    revokesGeneration: true,
    quarantinesSlot: false,
    drainAndCleanup: 'drain bounded queue; kill owned process',
  },
  'frame-too-large': {
    direction: 'either',
    operation: 'decode',
    resultAndAttachment: 'reject; current generation revoked',
    revokesGeneration: true,
    quarantinesSlot: false,
    drainAndCleanup: 'drain bounded queue; kill owned process',
  },
  'stale-generation': {
    direction: 'either',
    operation: 'operation',
    resultAndAttachment: 'explicit failure; authority unchanged',
    revokesGeneration: false,
    quarantinesSlot: false,
    drainAndCleanup: 'leave current attachment live',
  },
  'read-only': {
    direction: 'client',
    operation: 'input/query',
    resultAndAttachment: 'explicit failure; authority unchanged',
    revokesGeneration: false,
    quarantinesSlot: false,
    drainAndCleanup: 'operation is not queued',
  },
  'fifo-full': {
    direction: 'client',
    operation: 'input/resize',
    resultAndAttachment: 'explicit failure; authority unchanged',
    revokesGeneration: false,
    quarantinesSlot: false,
    drainAndCleanup: 'preserve existing queue; no process action',
  },
  'unsupported-runtime': {
    direction: 'server',
    operation: 'startup',
    resultAndAttachment: 'startup failure; no attachment',
    revokesGeneration: false,
    quarantinesSlot: false,
    drainAndCleanup: 'close PTY/pipe handles',
  },
  'spawn-failed': {
    direction: 'server',
    operation: 'startup',
    resultAndAttachment: 'startup failure; generation revoked',
    revokesGeneration: true,
    quarantinesSlot: false,
    drainAndCleanup: 'terminate descendants; quarantine if uncertain',
  },
  'backend-failed': {
    direction: 'server',
    operation: 'submitted operation',
    resultAndAttachment: 'operation failure; generation revoked',
    revokesGeneration: true,
    quarantinesSlot: false,
    drainAndCleanup: 'cancel unsent operations; cleanup',
  },
  'transport-failed': {
    direction: 'either',
    operation: 'live session',
    resultAndAttachment: 'unknown delivery; generation revoked',
    revokesGeneration: true,
    quarantinesSlot: false,
    drainAndCleanup: 'disable input; cleanup',
  },
  'cleanup-incomplete': {
    direction: 'server',
    operation: 'disposal',
    resultAndAttachment: 'explicit incomplete result; slot quarantined',
    revokesGeneration: false,
    quarantinesSlot: true,
    drainAndCleanup: 'retain quarantine record; no replacement',
  },
};

/** Every failure code's complete row of the failure and cleanup table. */
export const FAILURE_TABLE: Readonly<Record<FailureCode, FailureDisposition>> = Object.fromEntries(
  (Object.keys(ROWS) as FailureCode[]).map((code) => [
    code,
    { code, ...ROWS[code], closeCode: FAILURE_CLOSE_CODES[code] },
  ]),
) as Record<FailureCode, FailureDisposition>;

/** The failure table row for `code`. */
export function describeFailure(code: FailureCode): FailureDisposition {
  return FAILURE_TABLE[code];
}

/** The codes an `operation-failure` message may carry: an input or resize that did not complete. */
export const OPERATION_FAILURE_CODES = [
  'read-only',
  'fifo-full',
  'backend-failed',
  'transport-failed',
] as const satisfies readonly FailureCode[];

/** The codes an `attachment-error` message may carry: a startup or attachment failure. */
export const ATTACHMENT_ERROR_CODES = [
  'unsupported-runtime',
  'spawn-failed',
  'backend-failed',
  'transport-failed',
] as const satisfies readonly FailureCode[];
