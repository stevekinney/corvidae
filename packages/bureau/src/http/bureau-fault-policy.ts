/**
 * Bureau's one policy for the faults a {@link BureauError} becomes (COR-2518).
 *
 * A `BureauError` reaches the caller as the same fault whichever operation raised it, with the
 * same `remediation`. {@link bureauFaultPolicy} is what the Bureau handler is built with, so an
 * operation that maps nothing of its own still answers the mapped fault, never `EngineFailure`.
 * An operation that knows more than the error does (the resource it was asked for, the field a
 * refusal is about) passes that in a {@link BureauFaultContext} to {@link bureauFaultOf}: the
 * context refines the fault's `data` or picks its other form, and never decides a code by
 * itself. No other file under `http` reads a `BureauError`'s class or code to build a fault.
 *
 * @module http/bureau-fault-policy
 */

import type { FaultCode, FaultPolicy, OperationFault } from '@lostgradient/backchannel';
import { weftFaultPolicy } from '@lostgradient/weft';

import { BUREAU_ERROR_CODES, BureauError, type BureauErrorCode } from '../bureau-errors.ts';

/**
 * The fault code each {@link BureauErrorCode} answers by default. The record is exhaustive over
 * the codes, so a new code cannot compile without a mapping, and the check below fails at load if
 * one of {@link BUREAU_ERROR_CODES} has none.
 */
const BUREAU_ERROR_FAULT_CODE: Readonly<Record<BureauErrorCode, FaultCode>> = Object.freeze({
  NOT_FOUND: 'NotFound',
  CONFLICT: 'Conflict',
  NOT_CONFIGURED: 'UnsupportedCapability',
  BAD_REQUEST: 'InvalidParams',
  RATE_LIMITED: 'RateLimited',
  UNSUPPORTED_CAPABILITY: 'Unprocessable',
  STORAGE_UNAVAILABLE: 'Unavailable',
});

/**
 * What each code tells the caller to do next: one line of plain text, fixed per code so it never
 * repeats an error message that could name an internal. It is the `remediation` of every fault
 * {@link bureauFault} builds, however the context shapes the rest of it.
 */
const BUREAU_ERROR_REMEDIATION: Readonly<Record<BureauErrorCode, string>> = Object.freeze({
  NOT_FOUND:
    'Check the identifier, and list the resource to find the current one; a resource you cannot see answers the same way.',
  CONFLICT:
    'Read the resource again to see its current state, then repeat the request if it still applies.',
  NOT_CONFIGURED:
    'Ask the operator to configure the capability this Bureau lacks; repeating the request does not help until they do.',
  BAD_REQUEST: 'Correct the field the message names and send the request again.',
  RATE_LIMITED: 'Wait before repeating the request, and send fewer requests in the same period.',
  UNSUPPORTED_CAPABILITY:
    'Use an operation this Bureau supports; it has no support for what the request asked.',
  STORAGE_UNAVAILABLE:
    "Repeat the request after a short wait; if it keeps failing, ask the operator to check the Bureau's storage.",
});

// The records are exhaustive at compile time; this holds at run time too, where a cast or a
// stale build could drop a code, and a code with no fault must fail loudly rather than answer
// `EngineFailure` one request at a time.
for (const code of BUREAU_ERROR_CODES) {
  if (
    !Object.hasOwn(BUREAU_ERROR_FAULT_CODE, code) ||
    !Object.hasOwn(BUREAU_ERROR_REMEDIATION, code)
  ) {
    throw new Error(`The Bureau fault policy maps no fault, or no remediation, for ${code}.`);
  }
}

/**
 * The other form a code takes where an operation's contract differs from the default:
 * `unprocessable` answers `Unprocessable` with the message as its reason, and `shutting-down`
 * answers `Unavailable` with the reason `shutting-down`.
 */
type BureauRefusalForm = 'unprocessable' | 'shutting-down';

/** What an operation knows that its {@link BureauError} does not. Every field is optional. */
export type BureauFaultContext = {
  /** The resource a `NOT_FOUND` is about: the fault names it as `data.resource` and `data.identifier`. */
  readonly notFound?: { readonly resource: string; readonly identifier: string };
  /** The request field a `BAD_REQUEST` is about, as the path of its one `InvalidParams` issue. */
  readonly invalidPath?: readonly string[];
  /** The capability a `NOT_CONFIGURED` names, in place of the one its subject says. */
  readonly capability?: string;
  /** Codes this operation answers in their other form. */
  readonly forms?: Readonly<Partial<Record<BureauErrorCode, BureauRefusalForm>>>;
};

/** A message every {@link BureauError} that is a storage outage answers with, in place of its own. */
const STORAGE_UNAVAILABLE_MESSAGE = "The Bureau's storage is unavailable.";

/**
 * The fault a `BureauError` becomes, with its `remediation`. The code is the one of
 * {@link BUREAU_ERROR_FAULT_CODE} unless the context asks for the other form of that error code.
 */
function bureauFault(error: BureauError, context: BureauFaultContext = {}): OperationFault {
  const remediation = BUREAU_ERROR_REMEDIATION[error.code];
  const form = context.forms?.[error.code];
  if (form === 'shutting-down') {
    return {
      code: 'Unavailable',
      message: error.message,
      data: { reason: 'shutting-down' },
      remediation,
    };
  }
  if (form === 'unprocessable') {
    return {
      code: 'Unprocessable',
      message: error.message,
      data: { reason: error.message },
      remediation,
    };
  }
  switch (error.code) {
    case 'NOT_FOUND': {
      const { resource, identifier } = context.notFound ?? {
        resource: 'unknown',
        identifier: undefined,
      };
      return {
        code: 'NotFound',
        message:
          identifier === undefined ? error.message : `No ${resource} with id "${identifier}"`,
        data: identifier === undefined ? { resource } : { resource, identifier },
        remediation,
      };
    }
    case 'CONFLICT':
      return {
        code: 'Conflict',
        message: error.message,
        data: { reason: error.message },
        remediation,
      };
    case 'NOT_CONFIGURED':
      return {
        code: 'UnsupportedCapability',
        message: error.message,
        data: { capability: context.capability ?? error.subject ?? 'unknown' },
        remediation,
      };
    case 'BAD_REQUEST':
      return {
        code: 'InvalidParams',
        message: error.message,
        data: {
          issues: [
            { path: [...(context.invalidPath ?? [])], message: error.message, code: 'custom' },
          ],
        },
        remediation,
      };
    case 'RATE_LIMITED':
      return { code: 'RateLimited', message: error.message, data: {}, remediation };
    case 'UNSUPPORTED_CAPABILITY':
      return {
        code: 'Unprocessable',
        message: error.message,
        data: { reason: error.message },
        remediation,
      };
    case 'STORAGE_UNAVAILABLE':
      return { code: 'Unavailable', message: STORAGE_UNAVAILABLE_MESSAGE, data: {}, remediation };
  }
}

/**
 * `error` as the fault {@link bureauFault} makes of it when it is a {@link BureauError}, and
 * `error` itself otherwise, so an operation's `catch` ends in `throw bureauFaultOf(error, ...)`.
 */
export function bureauFaultOf(error: unknown, context?: BureauFaultContext): unknown {
  return error instanceof BureauError ? bureauFault(error, context) : error;
}

/**
 * How a mount that speaks another protocol than the operation catalog tells a refusal apart: a
 * request about something that is not there, or a request that is not valid. Those are the two
 * refusals an AG-UI or A2A caller is answered in its own terms; every other error is `undefined`.
 */
export function bureauRefusalKind(
  error: unknown,
): { readonly kind: 'not-found' | 'bad-request'; readonly message: string } | undefined {
  if (!(error instanceof BureauError)) return undefined;
  if (BUREAU_ERROR_FAULT_CODE[error.code] === 'NotFound') {
    return { kind: 'not-found', message: error.message };
  }
  if (BUREAU_ERROR_FAULT_CODE[error.code] === 'InvalidParams') {
    return { kind: 'bad-request', message: error.message };
  }
  return undefined;
}

/**
 * Weft's {@link FaultPolicy} with Bureau's on top: a `BureauError` answers {@link bureauFault}, and
 * everything else is Weft's to classify, with its strict-mode setting and error codes.
 */
export const bureauFaultPolicy: FaultPolicy = Object.freeze({
  ...weftFaultPolicy,
  classifyError: (error: unknown): OperationFault | undefined =>
    error instanceof BureauError ? bureauFault(error) : weftFaultPolicy.classifyError?.(error),
});
