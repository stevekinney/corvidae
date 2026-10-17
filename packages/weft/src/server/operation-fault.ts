/**
 * Transport-neutral fault model for the operation pipeline.
 *
 * `OperationFault` is what `executeOperation` returns when a request fails.
 * It carries a stable `code` (the discriminator), a human-readable `message`
 * for logs, and a typed `data` payload narrowed per-code via discriminated
 * union — so transport adapters can serialize the fault into the exact
 * wire shape their protocol expects without a string-sniffing layer.
 *
 * Two pure mapper functions translate the fault into a transport-specific
 * shape:
 *   - `faultToHttpResponse(fault)` for REST.
 *   - `faultToJsonRpcError(fault)` for the JSON-RPC transports.
 * Both consume `OperationFault` directly; serialization is not a method on
 * the fault class because that would force every transport to know about
 * every other transport's wire shape.
 *
 * **Scope.** The union covers operation-pipeline faults — what
 * `executeOperation` produces. Pure protocol-frame errors (JSON parse
 * failure, invalid JSON-RPC request envelope) live in the JSON-RPC parser
 * and use the spec-mandated reserved codes (-32700 / -32600); they do NOT
 * pass through this fault model. The v1 union is open for additive
 * extension — future codes (e.g. `PreconditionFailed`, `PayloadTooLarge`,
 * `ResourceExhausted`) can be added without breaking existing serializers
 * because the per-code mapping tables are exhaustive `Record<FaultCode, T>`
 * and the JSON-RPC payload extractor is an exhaustive switch.
 *
 * **Every fault has a `data` field.** Even codes with no payload-specific
 * detail (`NotImplemented`, `EngineFailure`) carry `data: {}` so transport
 * adapters never branch on `data === undefined`. This uniformity is what
 * lets the exhaustive switch in `extractFaultDataPayload` stay small.
 *
 * The stable fault model with transport-neutral code, message, and typed
 * `data` payload forms the basis of cross-transport parity: every fault is
 * serialized consistently across REST and JSON-RPC transports.
 */

import type { WorkflowCompatibilityReason } from '../core/contract/compatibility.ts';
import type { FaultCode } from '../core/fault-code.ts';
import type { WorkflowSourceRejectionReason } from '../core/source/errors.ts';
import { isWeftErrorCode, type WeftErrorCode } from '../core/weft-error.ts';

/** Transport identifiers as seen by `executeOperation`. */
export type TransportKind = 'http-rest' | 'jsonRpcHttp' | 'jsonRpcWebSocket' | 'jsonRpcStdio';

/** A revision identifier: a counter or an opaque token. */
export type RevisionToken = string | number;

/** A flattened zod issue, kept loose so we don't pin a zod version here. */
export type FlattenedZodIssue = {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
  readonly code: string;
};

/**
 * Transport-neutral fault returned by `executeOperation`. Each variant has a
 * typed `data` payload — transport adapters destructure on `code` to access
 * the shape they need.
 */
export type OperationFault =
  | { code: 'Unauthorized'; message: string; data: { reason: string } }
  | { code: 'Forbidden'; message: string; data: { reason: string } }
  | {
      code: 'NotFound';
      message: string;
      // `weftCode` carries the fine-grained originating public error (e.g.
      // `WorkflowNotFoundError`) so REST clients can branch transport-uniformly
      // via `isWeftFault`; the coarse `NotFound` code alone cannot distinguish a
      // missing workflow from a missing schedule. Set only at sites holding the
      // typed error, never defaulted, so existing faults stay byte-identical.
      data: { resource: string; identifier?: string | undefined; weftCode?: WeftErrorCode };
    }
  | {
      code: 'Conflict';
      message: string;
      data: {
        reason: string;
        // See the `NotFound.weftCode` note: `Conflict` collapses several typed
        // errors (`WorkflowAlreadyExistsError`, `StartOrSignalConflictError`,
        // `IdempotencyKeyPurgedError`), and `weftCode` recovers which one.
        weftCode?: WeftErrorCode;
        missingTypes?: readonly string[] | undefined;
        missingWorkflowCount?: number | undefined;
        samplesTruncated?: boolean | undefined;
        // WFT-11: `engine.workflows.activate()`'s `applied: false` refusal
        // variants (`stale-generation`, `expected-generation-required`)
        // report the durable generation the caller should have supplied.
        currentGeneration?: number | undefined;
        // WFT-11: the `incompatible` refusal variant's full, ordered list of
        // `WorkflowCompatibilityReason`s — a caller branching on why
        // activation was refused needs every reason, not just the first.
        compatibilityReasons?: readonly WorkflowCompatibilityReason[] | undefined;
        // WFT-15/16: `engine.workflows.preload()`'s loaded-module-fails-
        // validation refusal — `WorkflowSourceValidationError`'s own full,
        // ordered `reasons` array (distinct from `compatibilityReasons`,
        // which is manifest-compatibility-specific).
        sourceValidationReasons?: readonly WorkflowSourceRejectionReason[] | undefined;
      };
    }
  | { code: 'Unprocessable'; message: string; data: { reason: string } }
  | { code: 'PayloadTooLarge'; message: string; data: { maxBytes: number } }
  // `Timeout` allows callers to construct `data: { operationName: undefined }`
  // legally — the wire serializers strip undefined-valued keys via
  // `filterDefined`. Spelling `| undefined` explicitly accepts that under
  // `exactOptionalPropertyTypes`.
  | { code: 'Timeout'; message: string; data: { operationName?: string | undefined } }
  | { code: 'NotImplemented'; message: string; data: Record<string, never> }
  | {
      code: 'UnsupportedTransport';
      message: string;
      data: { transport: TransportKind; supported: ReadonlyArray<TransportKind> };
    }
  | {
      code: 'SubscriptionOverflow';
      message: string;
      data: { subscriptionId: string; droppedCount: number };
    }
  | {
      code: 'InvalidParams';
      message: string;
      // See the `NotFound.weftCode` note: `WorkflowNotRegisteredError` maps to
      // `InvalidParams`, and `weftCode` recovers that originating code for
      // transport-uniform branching.
      data: { issues: ReadonlyArray<FlattenedZodIssue>; weftCode?: WeftErrorCode };
    }
  | { code: 'MethodNotFound'; message: string; data: { method: string } }
  // The caller's optimistic-concurrency precondition no longer holds: the
  // resource has moved past the revision the caller expected. Distinct from
  // `Conflict` so a client can re-read and retry without parsing a reason.
  | {
      code: 'StaleRevision';
      message: string;
      data: {
        expectedRevision?: RevisionToken | undefined;
        // Required: it is what tells a client to re-read and retry, rather than
        // treat the fault as a plain `Conflict`.
        currentRevision: RevisionToken;
      };
    }
  // A rate or quota limit was hit. `retryAfterSeconds` is emitted as the REST
  // `Retry-After` header and mirrored into `data` on both transports.
  | { code: 'RateLimited'; message: string; data: { retryAfterSeconds?: number | undefined } }
  // The server (or a dependency) cannot serve the request right now but may
  // later. `reason` is JSON-RPC only; REST discloses just `retryAfterSeconds`.
  | {
      code: 'Unavailable';
      message: string;
      data: { reason?: string | undefined; retryAfterSeconds?: number | undefined };
    }
  // The server understands the request but lacks a capability it needs.
  | { code: 'UnsupportedCapability'; message: string; data: { capability: string } }
  | { code: 'EngineFailure'; message: string; data: Record<string, never> };

/**
 * HTTP status code for each fault, used by `faultToHttpResponse`. Values
 * align with REST conventions; both `NotImplemented` and
 * `UnsupportedTransport` map to 501 because the caller asked for something
 * the server cannot fulfill.
 */
export const FAULT_CODE_TO_HTTP_STATUS: Readonly<Record<FaultCode, number>> = Object.freeze({
  Unauthorized: 401,
  Forbidden: 403,
  NotFound: 404,
  Conflict: 409,
  Unprocessable: 422,
  Timeout: 408,
  PayloadTooLarge: 413,
  NotImplemented: 501,
  UnsupportedTransport: 501,
  SubscriptionOverflow: 500,
  InvalidParams: 400,
  MethodNotFound: 404,
  StaleRevision: 409,
  RateLimited: 429,
  Unavailable: 503,
  UnsupportedCapability: 501,
  EngineFailure: 500,
});

/**
 * Format an `InvalidParams` fault as a single human-readable error string
 * suitable for the body of a JSON response. Joins each Zod issue as
 * `path: message` (or just `message` at the root) with `; ` separators.
 */
export function formatInvalidParamsMessage(
  fault: Extract<OperationFault, { code: 'InvalidParams' }>,
): string {
  return fault.data.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

export type RestFaultResponseOptions = {
  /** REST-only status override for a binding with an established non-canonical status. */
  readonly status?: number;
  /** REST-only public message override for a binding with an established response message. */
  readonly message?: string;
};

/**
 * The REST fault body. `weftCode` is the fine-grained {@link WeftErrorCode} of
 * the originating error class, present only when the fault carried one; the
 * coarse {@link FaultCode} is not in the body at all. The HTTP status is
 * derived from it, but that mapping is not injective (`NotFound` and
 * `MethodNotFound` are both 404, for example), so a REST consumer cannot
 * recover the exact `FaultCode` from the status. JSON-RPC uses
 * the same `weftCode` key for the coarse `FaultCode` instead (see
 * `fault-to-json-rpc.ts`).
 */
export type RestFaultBody = {
  readonly error: string;
  readonly weftCode?: WeftErrorCode;
  readonly data?: Readonly<Record<string, unknown>>;
};

type RestProjectableFault = Exclude<OperationFault, { code: 'EngineFailure' }>;

type RestFaultDataExtractor<Code extends RestProjectableFault['code']> = (
  data: Extract<RestProjectableFault, { code: Code }>['data'],
) => Readonly<Record<string, unknown>>;

type RestFaultDataExtractors = {
  [Code in RestProjectableFault['code']]: RestFaultDataExtractor<Code>;
};

const NO_REST_FAULT_DATA: Readonly<Record<string, unknown>> = Object.freeze({});

/**
 * REST is a deliberately smaller disclosure boundary than JSON-RPC. This
 * exhaustive table is deny-by-default: adding a new `FaultCode` cannot compile
 * until its REST-visible fields are reviewed explicitly.
 */
const REST_FAULT_DATA_EXTRACTORS: RestFaultDataExtractors = {
  Unauthorized: () => NO_REST_FAULT_DATA,
  Forbidden: () => NO_REST_FAULT_DATA,
  NotFound: (data) =>
    filterDefined({
      resource: data.resource,
      identifier:
        data.identifier === undefined || data.identifier.length === 0 ? undefined : data.identifier,
    }),
  Conflict: (data) =>
    filterDefined({
      missingTypes: data.missingTypes === undefined ? undefined : [...data.missingTypes],
      missingWorkflowCount: data.missingWorkflowCount,
      samplesTruncated: data.samplesTruncated,
      // WFT-11: intentionally NOT `reason` — REST has never disclosed the
      // internal `Conflict.data.reason` string (see this table's own
      // "deny-by-default" doc comment); these two fields are additive and
      // narrower. A REST caller that must branch on WHICH of
      // `engine.workflows.activate()`'s four refusal reasons occurred
      // should use JSON-RPC, which gets full fidelity via `dataForConflict`
      // in `fault-to-json-rpc.ts`.
      currentGeneration: data.currentGeneration,
      compatibilityReasons:
        data.compatibilityReasons === undefined ? undefined : [...data.compatibilityReasons],
      sourceValidationReasons:
        data.sourceValidationReasons === undefined ? undefined : [...data.sourceValidationReasons],
    }),
  Unprocessable: () => NO_REST_FAULT_DATA,
  PayloadTooLarge: (data) => ({ maxBytes: data.maxBytes }),
  Timeout: (data) => filterDefined({ operationName: data.operationName }),
  NotImplemented: () => NO_REST_FAULT_DATA,
  UnsupportedTransport: (data) => ({
    transport: data.transport,
    supported: [...data.supported],
  }),
  SubscriptionOverflow: (data) => ({ droppedCount: data.droppedCount }),
  InvalidParams: (data) =>
    data.issues.length === 0
      ? NO_REST_FAULT_DATA
      : {
          issues: data.issues.map((issue) => ({
            path: [...issue.path],
            message: issue.message,
            code: issue.code,
          })),
        },
  MethodNotFound: (data) => ({ method: data.method }),
  // Typed data lets a REST client tell "re-read and retry" (`StaleRevision`)
  // from a plain `Conflict`, and learn when to retry. `Unavailable.reason` is
  // internal detail and stays JSON-RPC only.
  StaleRevision: (data) => ({
    currentRevision: data.currentRevision,
    ...(data.expectedRevision === undefined ? {} : { expectedRevision: data.expectedRevision }),
  }),
  RateLimited: (data) =>
    filterDefined({ retryAfterSeconds: usableRetryAfterSeconds(data.retryAfterSeconds) }),
  Unavailable: (data) =>
    filterDefined({ retryAfterSeconds: usableRetryAfterSeconds(data.retryAfterSeconds) }),
  UnsupportedCapability: (data) => ({ capability: data.capability }),
};

/**
 * Map an `OperationFault` to the canonical additive REST body:
 * `{ error, weftCode?, data? }`. The existing string `error` and optional
 * fine-grained `weftCode` (a {@link WeftErrorCode}, never a {@link FaultCode})
 * remain unchanged; `data` contains only fields from the audited allowlist
 * above. JSON-RPC uses its own broader projection, whose `data.weftCode` is the
 * coarse `FaultCode`.
 *
 * `EngineFailure` is a hard exception: its exact body remains
 * `{ "error": "Internal server error" }`, regardless of response overrides.
 */
export function shapeOperationFaultAsJson(
  fault: OperationFault,
  options: RestFaultResponseOptions = {},
): Response {
  const message =
    options.message ??
    (fault.code === 'InvalidParams' ? formatInvalidParamsMessage(fault) : undefined);
  return shapeRestFaultAsJson(fault, { ...options, ...(message === undefined ? {} : { message }) });
}

/** Canonical REST response used by bindings and route-dispatch fallback. */
export function shapeRestFaultAsJson(
  fault: OperationFault,
  options: RestFaultResponseOptions = {},
): Response {
  const safeFault = wireSafeFault(fault);
  const body = shapeRestFaultBody(safeFault, options.message);
  const status =
    safeFault.code === 'EngineFailure'
      ? 500
      : (options.status ?? FAULT_CODE_TO_HTTP_STATUS[safeFault.code]);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const retryAfter = retryAfterHeaderValue(safeFault);
  if (retryAfter !== undefined) headers['Retry-After'] = retryAfter;

  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * The `Retry-After` delay-seconds value for a fault that carries
 * `retryAfterSeconds`. A non-finite or negative value is dropped rather than
 * emitted as a malformed header, and a fraction rounds up so a client never
 * retries earlier than the server asked.
 */
function retryAfterHeaderValue(fault: OperationFault): string | undefined {
  if (fault.code !== 'RateLimited' && fault.code !== 'Unavailable') return undefined;
  const seconds = usableRetryAfterSeconds(fault.data.retryAfterSeconds);
  return seconds === undefined ? undefined : String(Math.ceil(seconds));
}

/**
 * Refuse a fault whose `data` carries a number that JSON cannot represent.
 * `NaN` and `Infinity` serialize as `null`, so a `StaleRevision` with a
 * non-finite `currentRevision`, for one, would put a `null` on the wire where
 * the schema requires a revision. That is a programming error in whoever built
 * the fault, so it throws rather than producing a body that violates the
 * contract. The one exception is `retryAfterSeconds`, a hint a client can do
 * without: {@link usableRetryAfterSeconds} drops it from every projection.
 *
 * Called by the fault factories. The wire projections use {@link wireSafeFault}
 * instead, so a fault written as an object literal still gets a reply.
 */
export function assertFiniteFaultData(fault: OperationFault): void {
  const field = findNonFiniteFaultField(fault);
  if (field !== undefined) {
    throw new TypeError(
      `The ${fault.code} fault's data.${field} must be a finite number, got ${String(faultDataValue(fault, field))}`,
    );
  }
}

/** The first `data` field (other than `retryAfterSeconds`) holding a non-finite number. */
function findNonFiniteFaultField(fault: OperationFault): string | undefined {
  for (const [field, value] of Object.entries(fault.data)) {
    if (field === 'retryAfterSeconds') continue;
    if (typeof value === 'number' && !Number.isFinite(value)) return field;
  }
  return undefined;
}

function faultDataValue(fault: OperationFault, field: string): unknown {
  return (fault.data as Record<string, unknown>)[field];
}

/**
 * The fault a wire projection may send. A fault whose `data` holds a non-finite
 * number is a programming error that slipped past the factories (for example,
 * a fault written as an object literal). Throwing from a projection would leave
 * the request without a reply (a JSON-RPC WebSocket client would wait forever),
 * so the projection logs it and answers with the masked internal error instead,
 * keeping the request's id.
 */
export function wireSafeFault(fault: OperationFault): OperationFault {
  const field = findNonFiniteFaultField(fault);
  if (field === undefined) return fault;
  console.error(
    `[weft] The ${fault.code} fault's data.${field} is not a finite number (${String(faultDataValue(fault, field))}); answering with an internal error instead.`,
  );
  return { code: 'EngineFailure', message: 'internal error', data: {} };
}

/**
 * Build a `StaleRevision` fault. Throws a `TypeError` when `currentRevision` or
 * `expectedRevision` is a non-finite number ({@link assertFiniteFaultData}).
 */
export function staleRevisionFault(
  message: string,
  data: Extract<OperationFault, { code: 'StaleRevision' }>['data'],
): Extract<OperationFault, { code: 'StaleRevision' }> {
  const fault = { code: 'StaleRevision', message, data } as const;
  assertFiniteFaultData(fault);
  return fault;
}

/**
 * A `retryAfterSeconds` a client can act on: finite and not negative. `NaN`
 * and `Infinity` do not survive JSON (they serialize as `null`), and a
 * negative delay is meaningless, so every wire projection drops them.
 */
export function usableRetryAfterSeconds(seconds: number | undefined): number | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;
  return seconds;
}

/** Build the audited canonical REST body. */
function shapeRestFaultBody(fault: OperationFault, message?: string): RestFaultBody {
  if (fault.code === 'EngineFailure') return { error: 'Internal server error' };

  const error = message ?? fault.message;
  const weftCode = weftCodeFromFaultData(fault.data);
  const data = restDataFromFault(fault);
  const body: {
    error: string;
    weftCode?: WeftErrorCode;
    data?: Readonly<Record<string, unknown>>;
  } = { error };
  if (weftCode !== undefined) body.weftCode = weftCode;
  if (Object.keys(data).length > 0) body.data = data;
  return body;
}

function restDataFromFault(fault: RestProjectableFault): Readonly<Record<string, unknown>> {
  // The table maps every discriminant to the matching data extractor. TypeScript
  // cannot preserve that correlation through a dynamic lookup, so this narrow
  // assertion reconnects the already-exhaustive key/value relationship.
  const extractor = REST_FAULT_DATA_EXTRACTORS[fault.code] as RestFaultDataExtractor<
    typeof fault.code
  >;
  return extractor(fault.data);
}

function weftCodeFromFaultData(data: OperationFault['data']): WeftErrorCode | undefined {
  if (typeof data !== 'object' || data === null || !('weftCode' in data)) return undefined;
  return isWeftErrorCode(data.weftCode) ? data.weftCode : undefined;
}

function filterDefined(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
}

/**
 * JSON-RPC error code for each fault. Reserved codes (-32700..-32603) keep
 * the spec meanings (`InvalidParams`, `MethodNotFound`); Weft domain codes
 * live in -32010..-32099 documented per design decision 4.
 */
export const FAULT_CODE_TO_JSON_RPC_CODE: Readonly<Record<FaultCode, number>> = Object.freeze({
  Unauthorized: -32010,
  Forbidden: -32011,
  NotFound: -32020,
  Conflict: -32021,
  Unprocessable: -32022,
  Timeout: -32023,
  PayloadTooLarge: -32024,
  NotImplemented: -32025,
  UnsupportedTransport: -32030,
  SubscriptionOverflow: -32031,
  EngineFailure: -32099,
  InvalidParams: -32602,
  MethodNotFound: -32601,
  StaleRevision: -32026,
  RateLimited: -32027,
  Unavailable: -32028,
  UnsupportedCapability: -32029,
});
