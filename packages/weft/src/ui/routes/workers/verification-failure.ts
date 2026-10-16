/**
 * Tells a strict payload-boundary failure apart from a contract mismatch (COR-162).
 *
 * A remote worker validates every activity result and heartbeat payload with
 * `packages/weft/src/worker/strict-json.ts` before it crosses the wire. A value JSON would erase
 * or rewrite (`undefined`, a non-finite number, `-0`, a `BigInt`, a function, a symbol, a sparse
 * slot, a cycle, a class instance) throws a `WorkerJsonValidationError`, whose message is
 * `<path>: <reason>` with `<path>` rooted at `activity result`. The worker reports a failed task
 * with only that message (`taskResult.error`), so the server's task ledger carries it as
 * `TaskLedgerDetail.error`.
 *
 * This module recognizes that message's shape. It never decides which values are valid worker
 * JSON: that rule lives in `strict-json.ts`, which is CLI- and worker-internal and is not
 * imported here. A contract mismatch, by contrast, arrives as a `Conflict` fault carrying
 * `compatibilityReasons`, read with `compatibility-verdict.ts`'s `readActivationConflictData`.
 *
 * @module routes/workers/verification-failure
 */
import { readActivationConflictData } from '../system/compatibility-verdict.ts';

export type VerificationFailure =
  | {
      readonly kind: 'payload-boundary';
      /** Where the rejected value sat, for example `activity result.items[2]`. */
      readonly path: string;
      /** Why the value was rejected, as the worker reported it. */
      readonly detail: string;
    }
  | { readonly kind: 'contract-mismatch'; readonly reasons: readonly string[] };

/** `activity result` (or the validator's default root, `value`) followed by property and index segments. */
const PAYLOAD_PATH = String.raw`(?:activity result|value)(?:\.[A-Za-z_$][\w$]*|\[(?:\d+|"(?:[^"\\]|\\.)*")\])*`;
const PAYLOAD_FAILURE = new RegExp(`^(${PAYLOAD_PATH}): (.+)$`, 's');

/** The endings `strict-json.ts`'s `fail()` calls produce. */
const PAYLOAD_FAILURE_ENDINGS = [
  'is not valid worker JSON',
  'number must be finite',
  'is not a plain JSON object',
] as const;

function payloadBoundaryFromMessage(message: string): VerificationFailure | undefined {
  const match = PAYLOAD_FAILURE.exec(message);
  if (match === null) return undefined;
  const path = match[1]!;
  const detail = match[2]!;
  if (!PAYLOAD_FAILURE_ENDINGS.some((ending) => detail.endsWith(ending))) return undefined;
  return { kind: 'payload-boundary', path, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Classifies a failure the server reported. Accepts a task ledger error string, an `Error` (a
 * `WorkerJsonValidationError` keeps its name when it reaches the dashboard in-process), or an
 * `HttpClientError`. Returns `undefined` for anything that is neither kind, so the caller keeps
 * its own generic treatment.
 */
export function classifyVerificationFailure(failure: unknown): VerificationFailure | undefined {
  if (typeof failure === 'string') return payloadBoundaryFromMessage(failure);

  const conflict = readActivationConflictData(failure);
  if (conflict?.compatibilityReasons !== undefined) {
    return { kind: 'contract-mismatch', reasons: conflict.compatibilityReasons };
  }

  if (!isRecord(failure) || typeof failure['message'] !== 'string') return undefined;
  if (failure['name'] === 'WorkerJsonValidationError' && typeof failure['path'] === 'string') {
    const prefix = `${failure['path']}: `;
    const message = failure['message'];
    return {
      kind: 'payload-boundary',
      path: failure['path'],
      detail: message.startsWith(prefix) ? message.slice(prefix.length) : message,
    };
  }
  return payloadBoundaryFromMessage(failure['message']);
}
