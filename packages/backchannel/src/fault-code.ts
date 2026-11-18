/**
 * `FaultCode` is the stable, machine-readable discriminant that the server's
 * operation pipeline attaches to every fault. Transport adapters serialize it
 * onto the wire so clients can branch on the failure programmatically rather
 * than string-matching a human message:
 *
 *   - REST operation routes: the HTTP status derived from this code, plus a
 *     `{ error, weftCode?, data? }` body. The body never carries the
 *     `FaultCode` itself: its optional `weftCode` is the fine-grained
 *     `WeftErrorCode` of the originating error class (see
 *     `shapeRestFaultAsJson` in `operation-fault.ts`). `EngineFailure` is
 *     masked to exactly `{ "error": "Internal server error" }`.
 *   - JSON-RPC: `error.data.weftCode` is this coarse `FaultCode`, alongside
 *     `error.data.httpStatus` (see `fault-to-json-rpc.ts`). The fine-grained
 *     `WeftErrorCode` is not carried on this transport.
 *
 * The same key therefore names different vocabularies per transport; see
 * `documentation/reference/api-errors.md#wire-envelopes`.
 *
 * The type lives in its own file because the server (which produces faults)
 * and the client (which consumes them off the wire) both need it, and it
 * imports nothing, so it stays with the transport-neutral operation layer.
 * `core/fault-code.ts` keeps `FAULT_CODE_TO_FAILURE_CATEGORY`, the mapping onto
 * Weft's execution taxonomy.
 */

/**
 * Every stable fault code name, in declaration order. The full vocabulary is
 * closed for v1; new codes can be added additively, and the maps keyed by
 * {@link FaultCode} force every new code to be handled at compile time.
 */
export const FAULT_CODES = [
  'Unauthorized',
  'Forbidden',
  'NotFound',
  'Conflict',
  'Unprocessable',
  'Timeout',
  'PayloadTooLarge',
  'NotImplemented',
  'UnsupportedTransport',
  'SubscriptionOverflow',
  'InvalidParams',
  'MethodNotFound',
  'StaleRevision',
  'RateLimited',
  'Unavailable',
  'UnsupportedCapability',
  'EngineFailure',
] as const;

/**
 * Stable fault code names. The full vocabulary is closed for v1; new codes can
 * be added additively, and the `satisfies` map in `core/fault-code.ts` forces
 * every new code to declare its failure category at compile time.
 *
 * See `documentation/reference/api-errors.md#faultcode` for the HTTP status,
 * JSON-RPC error code, and failure category of every fault code.
 *
 * @example
 * ```ts
 * import { type FaultCode } from '@lostgradient/backchannel';
 * import { HttpClientError } from '@lostgradient/weft';
 *
 * function describe(error: HttpClientError): string {
 *   const code: FaultCode | undefined = error.faultCode;
 *   return code === 'NotFound' ? 'missing resource' : (code ?? 'unknown');
 * }
 * void describe;
 * ```
 */
export type FaultCode = (typeof FAULT_CODES)[number];

const faultCodes = new Set<unknown>(FAULT_CODES);

/**
 * Type guard: narrows an unknown wire value to a known {@link FaultCode}.
 *
 * @example
 * ```ts
 * import { isFaultCode } from '@lostgradient/backchannel';
 *
 * isFaultCode('NotFound'); // true
 * isFaultCode('teapot'); // false
 * ```
 */
export function isFaultCode(value: unknown): value is FaultCode {
  return faultCodes.has(value);
}
