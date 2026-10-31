/**
 * Refresh-outcome presentation (COR-166): turns the wire outcome of
 * `weft.workflows.refresh` into text an operator can act on, the way
 * `preload-outcome.ts` does for a preload. It labels what comes back and
 * never decides it.
 *
 * A check resolves with a status: `not-modified` (the source answered 304),
 * `installed` (the candidate is installed and warmed but not active), or
 * `activated`. A check that installed a candidate but could not activate it
 * resolves `installed` with the catalog's structured refusal in `activation`
 * (stale generation, incompatible contract, conflict). A check that failed
 * faults with a bounded `data.reason`, never the host's own message:
 *
 * - `Conflict`: `refresh-integrity`, `refresh-identity`, `refresh-contract`,
 *   `refresh-runtime`, or `refresh-warming` (the candidate was refused and
 *   nothing was installed), or a catalog conflict.
 * - `Unavailable`: `refresh-source` or `refresh-stopped`.
 * - `NotFound`: no refresh source is registered for the workflow.
 * - `InvalidParams`, `Unauthorized`, `Forbidden`.
 *
 * The reason literals are hand-declared mirrors of closed unions in
 * server-only modules: a value import from the package root would pull
 * Weft's server module graph into the browser bundle (see
 * `../../lib/faults.ts`).
 */
import { HttpClientError } from '@lostgradient/weft';

import { compatibilityReasonLabel } from './compatibility-verdict.ts';

/** Why a candidate was refused, named by the `refresh-` fault reason. */
export const REFRESH_REFUSAL_REASONS = [
  'integrity',
  'identity',
  'contract',
  'runtime',
  'warming',
] as const;

export type RefreshRefusalReason = (typeof REFRESH_REFUSAL_REASONS)[number];

const REFUSAL_LABELS: Readonly<Record<RefreshRefusalReason, string>> = {
  integrity:
    'Integrity check failed: the artifact does not match its digest or its bound envelope, or it exceeds the size limit.',
  identity: 'Identity mismatch: the artifact is not the requested workflow and revision.',
  contract: 'Contract hash mismatch: the artifact’s manifest or contract hash failed validation.',
  runtime: 'Runtime validation failed: the host refused the artifact’s runtime proof.',
  warming: 'Warming failed: the host could not warm the candidate.',
};

/** Why the last check failed, for every reason a source's diagnostics can report. */
const FAILURE_LABELS: Readonly<Record<string, string>> = {
  ...REFUSAL_LABELS,
  'not-registered': 'No refresh source is registered.',
  source: 'The refresh source could not be reached or returned an unusable response.',
  conflict: 'The workflow catalog refused to install the candidate.',
  cancelled: 'The check was cancelled.',
  stopped: 'Refresh is stopped.',
  internal: 'The check failed inside the server.',
};

/** Operator copy for one diagnostics `reason`, or an honest fallback for one this build does not know. */
export function refreshFailureLabel(reason: string): string {
  return Object.hasOwn(FAILURE_LABELS, reason)
    ? (FAILURE_LABELS[reason] ?? reason)
    : `Unknown failure reason: ${reason}`;
}

function isRefusalReason(value: string): value is RefreshRefusalReason {
  return (REFRESH_REFUSAL_REASONS as readonly string[]).includes(value);
}

/** Why an installed candidate was not activated. */
export type RefreshNotActivated =
  | {
      readonly reason: 'stale-generation' | 'expected-generation-required';
      readonly currentGeneration: number;
    }
  | { readonly reason: 'incompatible'; readonly compatibilityReasons: readonly string[] }
  | { readonly reason: 'conflict' };

/** A render-ready check outcome. Every variant is an expected result rendered as text. */
export type RefreshOutcome =
  | { readonly kind: 'not-modified'; readonly etag: string | undefined }
  | { readonly kind: 'installed'; readonly revision: string | undefined }
  | {
      readonly kind: 'activated';
      readonly revision: string;
      readonly generation: number;
    }
  | {
      readonly kind: 'not-activated';
      readonly revision: string | undefined;
      readonly refusal: RefreshNotActivated;
    }
  | { readonly kind: 'refused'; readonly reason: RefreshRefusalReason; readonly message: string }
  | { readonly kind: 'source-unavailable'; readonly message: string }
  | { readonly kind: 'catalog-conflict'; readonly message: string }
  | { readonly kind: 'no-source'; readonly message: string }
  | { readonly kind: 'revision-removed'; readonly message: string }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'denied'; readonly message: string }
  | { readonly kind: 'malformed'; readonly message: string }
  | { readonly kind: 'faulted'; readonly message: string };

/** One attempt at `weft.workflows.refresh`: either it resolved, or it threw. */
export type RefreshAttempt =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown };

type Fields = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): Fields | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function parseRefusal(value: unknown): RefreshNotActivated | undefined {
  const record = asRecord(value);
  if (record === undefined || record['applied'] !== false) return undefined;
  const reason = record['reason'];
  if (reason === 'conflict') return { reason };
  if (reason === 'incompatible') {
    const reasons = record['compatibilityReasons'];
    return Array.isArray(reasons) && reasons.every((entry) => typeof entry === 'string')
      ? { reason, compatibilityReasons: reasons }
      : undefined;
  }
  if (reason === 'stale-generation' || reason === 'expected-generation-required') {
    const currentGeneration = record['currentGeneration'];
    return typeof currentGeneration === 'number' ? { reason, currentGeneration } : undefined;
  }
  return undefined;
}

const MALFORMED: RefreshOutcome = {
  kind: 'malformed',
  message: 'The server returned a check result this console does not recognize.',
};

function describeSuccess(value: unknown): RefreshOutcome {
  const record = asRecord(value);
  if (record === undefined) return MALFORMED;
  const revision = typeof record['revision'] === 'string' ? record['revision'] : undefined;
  const etag = typeof record['etag'] === 'string' ? record['etag'] : undefined;
  const activation = record['activation'];

  switch (record['status']) {
    case 'not-modified':
      return { kind: 'not-modified', etag };
    case 'activated': {
      const pointer = asRecord(asRecord(activation)?.['pointer']);
      return revision !== undefined && typeof pointer?.['generation'] === 'number'
        ? { kind: 'activated', revision, generation: pointer['generation'] }
        : MALFORMED;
    }
    case 'installed': {
      if (activation === undefined) return { kind: 'installed', revision };
      const refusal = parseRefusal(activation);
      return refusal === undefined ? MALFORMED : { kind: 'not-activated', revision, refusal };
    }
    default:
      return MALFORMED;
  }
}

function faultReason(error: HttpClientError): string | undefined {
  const data = asRecord(error.data);
  return typeof data?.['reason'] === 'string' ? data['reason'] : undefined;
}

function faultResource(error: HttpClientError): string | undefined {
  const resource = asRecord(error.data)?.['resource'];
  return typeof resource === 'string' ? resource : undefined;
}

function faultIdentifier(error: HttpClientError): string | undefined {
  const identifier = asRecord(error.data)?.['identifier'];
  return typeof identifier === 'string' ? identifier : undefined;
}

function describeConflict(error: HttpClientError): RefreshOutcome {
  const reason = faultReason(error)?.replace(/^refresh-/, '');
  if (reason !== undefined && isRefusalReason(reason)) {
    return { kind: 'refused', reason, message: REFUSAL_LABELS[reason] };
  }
  return {
    kind: 'catalog-conflict',
    message:
      'The workflow catalog rejected the install: this exact revision is already stored with different contract metadata, or the catalog changed concurrently.',
  };
}

function describeFault(error: HttpClientError, name: string): RefreshOutcome {
  switch (error.faultCode) {
    case 'NotFound':
      if (faultResource(error) === 'workflow-revision') {
        return {
          kind: 'revision-removed',
          message: `The revision ${faultIdentifier(error) ?? 'the check needed'} is no longer installed. It was removed while the check ran.`,
        };
      }
      return {
        kind: 'no-source',
        message: `No refresh source is registered for "${name}". The host registers a source with engine.workflows.registerRefreshSource().`,
      };
    case 'Conflict':
      return describeConflict(error);
    case 'Unavailable':
      return {
        kind: 'source-unavailable',
        message:
          faultReason(error) === 'refresh-stopped'
            ? 'Refresh is stopped on the server.'
            : 'The refresh source could not be reached or returned an unusable response. Nothing changed.',
      };
    case 'InvalidParams':
      return { kind: 'invalid', message: `Weft rejected the request: ${error.message}` };
    case 'Unauthorized':
    case 'Forbidden':
      return {
        kind: 'denied',
        message:
          'This principal is not allowed to check or activate refresh candidates (workflows:admin).',
      };
    default:
      return {
        kind: 'faulted',
        message: `Weft could not check "${name}": ${error.message}`,
      };
  }
}

/** Turns one {@link RefreshAttempt} into a {@link RefreshOutcome}. `name` is folded into the copy. */
export function describeRefreshOutcome(attempt: RefreshAttempt, name: string): RefreshOutcome {
  if (attempt.ok) return describeSuccess(attempt.value);
  if (!(attempt.error instanceof HttpClientError)) {
    return {
      kind: 'faulted',
      message:
        attempt.error instanceof Error
          ? `The check did not complete: ${attempt.error.message}`
          : 'The check did not complete.',
    };
  }
  return describeFault(attempt.error, name);
}

/** The sentence for an installed candidate that was not activated. */
export function notActivatedMessage(refusal: RefreshNotActivated): string {
  switch (refusal.reason) {
    case 'stale-generation':
      return `The active revision changed (current generation ${refusal.currentGeneration}). Refresh and try again.`;
    case 'expected-generation-required':
      return `The workflow already has an active revision, so activation needs its generation (current generation ${refusal.currentGeneration}).`;
    case 'incompatible':
      return 'The candidate is incompatible with the active revision.';
    case 'conflict':
      return 'Activation lost a concurrent write race. Re-read the active revision and try again.';
  }
}

/** Every compatibility reason of an incompatible refusal, as operator copy. */
export function refusalReasonLines(refusal: RefreshNotActivated): readonly string[] {
  return refusal.reason === 'incompatible'
    ? refusal.compatibilityReasons.map(
        (reason) => `${compatibilityReasonLabel(reason)} (${reason})`,
      )
    : [];
}
