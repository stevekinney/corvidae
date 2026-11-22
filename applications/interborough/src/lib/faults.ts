/**
 * Fault → UI treatment mapping (plan §10.4, T1.5). Frozen after the Phase 1
 * Foundation gate — see PROJECT-BRIEF "Shared contracts".
 *
 * Weft's wire `FaultCode` (17 values, `@lostgradient/weft`) is more granular
 * than the console's UI treatment vocabulary. The plan's "one FaultDisplay
 * treatment, six codes" (§10.4) is that coarser bucket, derived here from
 * `FaultCode` and its documented REST HTTP status
 * (`packages/backchannel/src/operation-fault.ts` `FAULT_CODE_TO_HTTP_STATUS`)
 * rather than invented independently, so the mapping cannot silently drift
 * from the wire contract.
 *
 * ## What `HttpClientError` carries
 *
 * `HttpClientError` exposes `status`, `message`, an optional coarse
 * `faultCode` (`FaultCode`), an optional fine-grained `weftCode`
 * (`WeftErrorCode`, e.g. `IdempotencyKeyPurgedError`), an optional
 * `data?: Readonly<Record<string, unknown>>` carrying the wire fault's typed
 * payload (field-level `issues`, the conflicting `resource`/`identifier`, …),
 * and the fault's `retryable` and `remediation`. A REST error body is
 * `{ error, weftCode?, data?, retryable, remediation? }`
 * (`shapeRestFaultBody` in Backchannel's `operation-fault.ts`), so REST
 * carries `data` and the advice too; JSON-RPC carries all of them in
 * `error.data`. REST still carries no coarse `faultCode`, so a REST fault is
 * bucketed by its HTTP status. `classifyFault` reads `data.issues` into
 * `invalid.fieldErrors` and copies the error's `retryable` and `remediation`
 * onto the treatment. The error carries them only if its transport put them
 * there: Weft's own clients do, and a transport that builds its own
 * `HttpClientError` (`postBureauCall` in `bureau-transport.ts`, the schedule
 * occurrence controls in `schedule-queries.ts`) copies them from the body with
 * `faultAdviceOf`; an error built without them classifies without them.
 * `conflict`/`not-found` do not attach a
 * resource link beyond what `message` says in prose.
 *
 * `weftCode` (and therefore `isSpentIdempotencyKey` below) is REST-only: the
 * JSON-RPC fault envelope writes its own coarse `weftCode: fault.code` (e.g.
 * `'Conflict'`) into `data` LAST (`fault-to-json-rpc.ts`), which overwrites
 * any fine-grained `weftCode` (e.g. `'IdempotencyKeyPurgedError'`) the
 * fault's own per-code payload carried — and `httpClientCatalogTransport`
 * never forwards a `weftCode` onto the thrown error regardless. Deliberate
 * upstream design, not a bug to fix here: don't "fix" the JSON-RPC path to
 * try to recover it.
 */
// `isWeftFault` (and the rest of the `isWeftError*` family) is exported from
// `@lostgradient/weft` as of `@lostgradient/weft@0.12.0`
// (https://github.com/stevekinney/weft/issues/722, fixed upstream #733) —
// importing it from there, rather than the package root (whose barrel also
// re-exports server-only code reaching `node:crypto`), is what actually
// keeps this module's dependency graph browser-only end to end.
import { type FaultCode } from '@lostgradient/backchannel';
import { HttpClientError, isWeftFault, type WeftErrorCode } from '@lostgradient/weft';

/** The six `FaultDisplay` UI treatment buckets (plan §10.4). */
export type FaultTreatmentKind =
  | 'not-found'
  | 'conflict'
  | 'invalid'
  | 'unauthorized'
  | 'not-supported'
  | 'internal'
  | 'unreachable';

/**
 * A single field-level validation error, read from the fault's `data.issues`:
 * `path` joins the issue's path with dots (`''` for the root).
 */
export interface FaultFieldError {
  readonly path: string;
  readonly message: string;
}

/**
 * What the server's fault said about the way on. Both are absent for a response that carried
 * neither, as one from an older server or a network failure does.
 */
export interface FaultAdvice {
  /** `true` when repeating the identical call later can succeed. */
  readonly retryable?: boolean;
  /** One line of plain text saying what to do next. */
  readonly remediation?: string;
}

/**
 * A classified fault, ready for presentation. One variant per
 * `FaultTreatmentKind`, each carrying only the detail that treatment can
 * actually act on (plan §10.4's per-code list), plus the fault's
 * {@link FaultAdvice} when the wire carried it.
 */
export type FaultTreatment = FaultTreatmentVariant & FaultAdvice;

type FaultTreatmentVariant =
  | { readonly kind: 'not-found'; readonly message: string }
  | {
      readonly kind: 'conflict';
      readonly message: string;
      /**
       * `true` when the conflict is a spent idempotency key
       * (`IdempotencyKeyPurgedError` — the key maps to a purged run; see
       * `weft/src/core/engine/lifecycle/start-or-signal.ts`). REST-only —
       * see the module doc.
       */
      readonly isSpentIdempotencyKey: boolean;
    }
  | {
      readonly kind: 'invalid';
      readonly message: string;
      /** One per issue in the fault's `data.issues`; `[]` when the fault carried none. */
      readonly fieldErrors: readonly FaultFieldError[];
    }
  | {
      readonly kind: 'unauthorized';
      readonly message: string;
      /** `401` → no credential was accepted, re-authenticate. `403` → a valid credential lacks the required scope. */
      readonly mode: 'reauth' | 'forbidden';
    }
  | { readonly kind: 'not-supported'; readonly message: string }
  /**
   * The request never reached a server that answered: the host is stopped, the network is down,
   * or the connection was cut. Unlike every other kind it says nothing about the request, so a
   * 5xx the server sent is `internal`, never this.
   */
  | { readonly kind: 'unreachable'; readonly message: string }
  | {
      readonly kind: 'internal';
      readonly message: string;
      /**
       * `true` when the fault crossed REST through the canonical
       * `shapeRestFault` masking path (`weft/src/server/operations/operation-helpers.ts`):
       * `EngineFailure` collapses to `{ error: "Internal server error" }` with
       * no `faultCode` on the wire, so this is the only signal the client has
       * that real detail exists server-side but wasn't sent. JSON-RPC and the
       * unmasked REST default (`faultToHttpResponse`) both carry a real
       * `faultCode` here and set this `false`.
       */
      readonly maskedByRest: boolean;
      /** Show a "try via JSON-RPC" hint — true exactly when `maskedByRest` is, since JSON-RPC is the transport that would carry the un-masked detail. */
      readonly tryViaJsonRpc: boolean;
      /**
       * Correlation id for cross-referencing server logs. Always `undefined`
       * today — weft has no request/correlation-id concept yet (grepped
       * `weft/src/server`; none exists). Never fabricate one here: a
       * client-made id would misleadingly imply server-side correlation.
       * Tracked in the same upstream issue as the `data` gap above.
       */
      readonly requestId?: string;
    };

/**
 * Every `FaultCode` mapped to its treatment kind. `satisfies` over
 * `Record<FaultCode, FaultTreatmentKind>` forces a compile error if
 * `@lostgradient/weft` adds a new `FaultCode` this map doesn't account for.
 */
const FAULT_CODE_TREATMENT_KIND = {
  NotFound: 'not-found',
  MethodNotFound: 'not-found',
  Conflict: 'conflict',
  Unprocessable: 'invalid',
  InvalidParams: 'invalid',
  PayloadTooLarge: 'invalid',
  Unauthorized: 'unauthorized',
  Forbidden: 'unauthorized',
  NotImplemented: 'not-supported',
  UnsupportedTransport: 'not-supported',
  // A timeout is transient by nature (unlike the 4xx codes, retrying with the
  // same input can succeed), so it is bucketed with `internal`, and query.ts's
  // retry policy treats it as retryable. See query.ts `shouldRetryQuery`.
  Timeout: 'internal',
  SubscriptionOverflow: 'internal',
  StaleRevision: 'conflict',
  // Transient by nature, like `Timeout`: a retry after the advertised delay
  // can succeed, so they share its `internal` (retryable) bucket.
  RateLimited: 'internal',
  Unavailable: 'internal',
  UnsupportedCapability: 'not-supported',
  EngineFailure: 'internal',
} as const satisfies Record<FaultCode, FaultTreatmentKind>;

/** HTTP status → treatment fallback for responses with no `faultCode` (e.g. a REST-masked `EngineFailure`, or a plain network/proxy error that never carried a Weft fault at all). */
function treatmentKindForStatus(status: number): FaultTreatmentKind {
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === 400 || status === 413 || status === 422) return 'invalid';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 501) return 'not-supported';
  return 'internal';
}

function treatmentKindForError(error: HttpClientError): FaultTreatmentKind {
  if (error.faultCode) return FAULT_CODE_TREATMENT_KIND[error.faultCode];
  return treatmentKindForStatus(error.status);
}

/** `401` (no credential accepted) vs `403` (credential accepted, scope denied) — prefers the coarse `faultCode` when present, falls back to the raw status otherwise. */
function unauthorizedMode(error: HttpClientError): 'reauth' | 'forbidden' {
  if (error.faultCode === 'Forbidden') return 'forbidden';
  if (error.faultCode === 'Unauthorized') return 'reauth';
  return error.status === 403 ? 'forbidden' : 'reauth';
}

/** What the person is told when a request got no answer. */
const UNREACHABLE_MESSAGE =
  'The server did not answer. Check that Interborough is running, then try again.';

/**
 * The messages browsers and runtimes give a `fetch` that never got a response: Chromium's
 * "Failed to fetch", Bun's and Node's "fetch failed", Firefox's "NetworkError when attempting to
 * fetch resource", Safari's "Load failed". A bare `TypeError` is not enough, because a bug thrown
 * while rendering is one too and must not raise the connection banner.
 */
const NETWORK_FAILURE_MESSAGE =
  /failed to fetch|fetch failed|networkerror|load failed|network request failed|network connection was lost|connection (was )?(refused|reset|closed)|socket (hang up|connection)/i;

/**
 * What a change refused while the server is unreachable throws. It is a network failure by
 * definition: the request was never sent, so the person reads the same words as for one that was
 * sent and got no answer.
 */
export class ServerUnreachableError extends Error {
  constructor() {
    super(UNREACHABLE_MESSAGE);
    this.name = 'ServerUnreachableError';
  }
}

/** Whether `error` is a request that got no answer from the server, as opposed to a fault the server sent. */
export function isNetworkFailure(error: unknown): boolean {
  if (error instanceof ServerUnreachableError) return true;
  if (error instanceof HttpClientError) return false;
  if (error instanceof DOMException) return error.name === 'NetworkError';
  return error instanceof TypeError && NETWORK_FAILURE_MESSAGE.test(error.message);
}

/**
 * The `retryable` and `remediation` a fault's wire carried, for a transport that builds its own
 * `HttpClientError`: `source` is the REST error body or the JSON-RPC `error.data`, both of which
 * hold the two fields at their top level. Only a boolean and a string survive; anything else, and a
 * response from an older server, leaves the field out.
 */
export function faultAdviceOf(source: unknown): FaultAdvice {
  if (typeof source !== 'object' || source === null) return {};
  const { retryable, remediation } = source as { retryable?: unknown; remediation?: unknown };
  return {
    ...(typeof retryable === 'boolean' ? { retryable } : {}),
    ...(typeof remediation === 'string' ? { remediation } : {}),
  };
}

const SPENT_IDEMPOTENCY_KEY_CODE: WeftErrorCode = 'IdempotencyKeyPurgedError';

/**
 * Classifies an error caught from a `client.*`/`client.operations[...]` call
 * into a `FaultTreatment`. Returns `null` for errors that never crossed the
 * Weft fault wire (a network failure, a programming error thrown during
 * render) — callers fall back to `UNKNOWN_FAULT_TREATMENT` (or use
 * `faultTreatment()`, which does that for them) rather than one of the six
 * documented treatments for those.
 */
export function classifyFault(error: unknown): FaultTreatment | null {
  if (isNetworkFailure(error)) return { kind: 'unreachable', message: UNREACHABLE_MESSAGE };
  if (!(error instanceof HttpClientError)) return null;
  const treatment = classifyHttpClientError(error);
  if (treatment === null) return null;
  return {
    ...treatment,
    ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
    ...(error.remediation === undefined ? {} : { remediation: error.remediation }),
  };
}

/** The `data.issues` of a fault as field errors: an issue with no text message is skipped. */
function fieldErrorsFromData(
  data: Readonly<Record<string, unknown>> | undefined,
): readonly FaultFieldError[] {
  const issues = data?.['issues'];
  if (!Array.isArray(issues)) return [];
  const fieldErrors: FaultFieldError[] = [];
  for (const issue of issues as unknown[]) {
    if (typeof issue !== 'object' || issue === null) continue;
    const { path, message } = issue as { path?: unknown; message?: unknown };
    if (typeof message !== 'string') continue;
    fieldErrors.push({ path: Array.isArray(path) ? path.join('.') : '', message });
  }
  return fieldErrors;
}

function classifyHttpClientError(error: HttpClientError): FaultTreatmentVariant | null {
  const kind = treatmentKindForError(error);
  switch (kind) {
    case 'not-found':
      return { kind, message: error.message };
    case 'conflict':
      return {
        kind,
        message: error.message,
        isSpentIdempotencyKey: isWeftFault(error, SPENT_IDEMPOTENCY_KEY_CODE),
      };
    case 'invalid':
      return { kind, message: error.message, fieldErrors: fieldErrorsFromData(error.data) };
    case 'unauthorized':
      return { kind, message: error.message, mode: unauthorizedMode(error) };
    case 'not-supported':
      return { kind, message: error.message };
    case 'internal': {
      // See `FaultTreatment.internal.maskedByRest` doc: no `faultCode` at
      // all is the only signal available that detail was masked/dropped.
      const maskedByRest = error.faultCode === undefined;
      return { kind, message: error.message, maskedByRest, tryViaJsonRpc: maskedByRest };
    }
    default:
      return null;
  }
}

/** Generic fallback for errors `classifyFault` can't attribute to a wire fault (offline, a thrown bug reaching a boundary, …). */
export const UNKNOWN_FAULT_TREATMENT: FaultTreatment = {
  kind: 'internal',
  message: 'Something went wrong. Check your connection and try again.',
  maskedByRest: false,
  tryViaJsonRpc: false,
};

/** `classifyFault(error) ?? UNKNOWN_FAULT_TREATMENT` — the treatment every caller should present, never `null`. */
export function faultTreatment(error: unknown): FaultTreatment {
  return classifyFault(error) ?? UNKNOWN_FAULT_TREATMENT;
}

/**
 * What a fault adds to a Cinder `ErrorState`, for every screen that shows a classified fault: the
 * fault's `remediation` as its own line under the description (never the title), and `onRetry` only
 * when asking again can help, which is every fault except one that says `retryable: false`. A
 * fault that carries no advice, such as a network failure or one from an older server, keeps Retry.
 * Keys that do not apply are absent, so the result spreads onto `ErrorState` under
 * `exactOptionalPropertyTypes`.
 */
export interface FaultErrorStateAdvice {
  readonly remediation?: string;
  readonly onRetry?: () => void;
}

/** Whether Retry can help with `treatment`: `false` only when the server said repeating the call cannot succeed. */
export function canRetryFault(treatment: FaultAdvice): boolean {
  return treatment.retryable !== false;
}

/** The {@link FaultErrorStateAdvice} of a classified fault, given what Retry does when it is offered (none: a state with no Retry). */
export function treatmentErrorStateAdvice(
  treatment: FaultAdvice,
  onRetry?: () => void,
): FaultErrorStateAdvice {
  return {
    ...(treatment.remediation === undefined || treatment.remediation === ''
      ? {}
      : { remediation: treatment.remediation }),
    ...(onRetry === undefined || !canRetryFault(treatment) ? {} : { onRetry }),
  };
}

/**
 * The error to advise from when one screen reads several things and any of them can fail: the first
 * that does not say `retryable: false` (so Retry stays while asking again could still help one of
 * the reads), else the first that failed, else `undefined`. `null` and `undefined` are reads that
 * did not fail.
 */
export function faultAdvisingRetry(errors: readonly unknown[]): unknown {
  const failed = errors.filter((error) => error !== null && error !== undefined);
  return (
    failed.find((error) => !(error instanceof HttpClientError) || error.retryable !== false) ??
    failed[0]
  );
}

/** {@link treatmentErrorStateAdvice} for the error a call rejected with, classified by {@link faultTreatment}. */
export function faultErrorStateAdvice(error: unknown, onRetry?: () => void): FaultErrorStateAdvice {
  return treatmentErrorStateAdvice(faultTreatment(error), onRetry);
}

/** Sentence-case heading for each treatment kind (plan §10.10 copy voice), shared by every surface presenting a `FaultTreatment`. */
export const FAULT_TREATMENT_TITLE: Readonly<Record<FaultTreatmentKind, string>> = {
  'not-found': 'Not found',
  conflict: 'Conflict',
  invalid: 'Invalid input',
  unauthorized: 'Not authorized',
  'not-supported': 'Not supported',
  internal: 'Something went wrong',
  unreachable: 'Server unreachable',
};
