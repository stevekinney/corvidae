/**
 * Each failure code the wire schema defines, mapped to the WebSocket close code a host sends with it.
 * Code 1006 is reserved for a locally observed abnormal closure and never appears here because an
 * application-initiated close frame must not carry it.
 */
export const FAILURE_CLOSE_CODES = {
  'protocol-version-unsupported': 1002,
  'malformed-frame': 1002,
  'frame-too-large': 1009,
  'stale-generation': 1008,
  'read-only': 1008,
  'fifo-full': 1013,
  'unsupported-runtime': 1011,
  'spawn-failed': 1011,
  'backend-failed': 1011,
  'transport-failed': 1011,
  'cleanup-incomplete': 1000,
} as const;

export type FailureCode = keyof typeof FAILURE_CLOSE_CODES;

/** The WebSocket close code that accompanies `code`. */
export function closeCodeForFailure(code: FailureCode): number {
  return FAILURE_CLOSE_CODES[code];
}
