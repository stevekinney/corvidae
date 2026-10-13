import type { FailureCode } from './failure-codes.ts';

/** The precise rule a rejected frame or message broke, finer-grained than its failure code. */
export type FailureReason =
  | 'oversized'
  | 'truncated'
  | 'trailing-bytes'
  | 'invalid-json'
  | 'not-an-object'
  | 'unknown-kind'
  | 'wrong-version'
  | 'direction-mismatch'
  | 'wrong-direction'
  | 'binary-kind-in-text'
  | 'invalid-field'
  | 'unknown-field'
  | 'invalid-session-identifier'
  | 'invalid-generation'
  | 'invalid-sequence'
  | 'invalid-dimension'
  | 'invalid-capabilities'
  | 'invalid-limits'
  | 'invalid-count'
  | 'stale-session'
  | 'stale-generation'
  | 'attachment-revoked'
  | 'authority-revoked'
  | 'duplicate-sequence'
  | 'out-of-order-sequence'
  | 'sequence-overflow'
  | 'unexpected-message'
  | 'duplicate-handshake'
  | 'handshake-incomplete'
  | 'operation-not-permitted'
  | 'operation-window-full'
  | 'channel-not-permitted'
  | 'stale-acknowledgement'
  | 'duplicate-acknowledgement'
  | 'future-acknowledgement'
  | 'over-counted-acknowledgement'
  | 'out-of-order-acknowledgement'
  | 'already-reported';

/** Why a frame or message was refused. It is returned, never thrown, and never contains a token. */
export type ProtocolFailure = {
  readonly code: FailureCode;
  readonly reason: FailureReason;
  /** For a soft rejection the host answers itself: the encoded `operation-failure` to send back. */
  readonly reply?: string;
};

export type ProtocolResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly failure: ProtocolFailure };

export function accept<Value>(value: Value): ProtocolResult<Value> {
  return { ok: true, value };
}

export function reject(
  code: FailureCode,
  reason: FailureReason,
  reply?: string,
): { readonly ok: false; readonly failure: ProtocolFailure } {
  return { ok: false, failure: reply === undefined ? { code, reason } : { code, reason, reply } };
}

/** The failure code a structural problem maps to: an unknown version fails closed, all else is malformed. */
export function codeForReason(reason: FailureReason): FailureCode {
  if (reason === 'wrong-version') return 'protocol-version-unsupported';
  if (reason === 'oversized') return 'frame-too-large';
  return 'malformed-frame';
}
