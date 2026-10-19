/**
 * Render-ready mapping for `weft.workflows.refresh.diagnostics` (COR-166).
 * Framework-free, like `workflow-revisions-view.ts`: every value comes from the
 * operation's response. The console computes no identity, state, backoff, or
 * next-check time itself, and a response that fails the guard below is a
 * malformed response, never a partial one.
 */
import { formatRelativeTime } from '../../lib/format/index.ts';

/** The states `WorkflowRefreshDiagnostics.state` reports. */
export const REFRESH_STATES = [
  'idle',
  'checking',
  'not-modified',
  'warming',
  'activated',
  'installed',
  'failed',
] as const;

export type RefreshState = (typeof REFRESH_STATES)[number];

/** Operator copy for each state: a word, so a state never relies on color. */
export const REFRESH_STATE_LABELS: Readonly<Record<RefreshState, string>> = {
  idle: 'Never checked',
  checking: 'Checking',
  'not-modified': 'Not modified',
  warming: 'Warming',
  activated: 'Activated',
  installed: 'Installed, not activated',
  failed: 'Failed',
};

/** The artifact a check fetched and validated. */
export interface RefreshCandidateView {
  readonly revision: string;
  readonly digest: string;
  readonly contractHash: string;
}

/** The revision active now; `digest` is present only for an artifact refresh activated. */
export interface RefreshCurrentView {
  readonly revision: string;
  readonly generation: number;
  readonly contractHash?: string;
  readonly digest?: string;
}

export interface RefreshSourceView {
  readonly name: string;
  readonly state: RefreshState;
  readonly etag?: string;
  readonly checkedAt?: number;
  readonly generation?: number;
  /** The bounded reason the last check failed. */
  readonly reason?: string;
  readonly candidate?: RefreshCandidateView;
  readonly current?: RefreshCurrentView;
}

/** The polling policy and state, present only while opt-in polling runs. */
export interface RefreshPollingView {
  readonly intervalMilliseconds: number;
  readonly maxBackoffMilliseconds: number;
  readonly backoffMilliseconds: number;
  readonly nextCheckAt?: number;
}

export interface RefreshDiagnosticsView {
  readonly polling?: RefreshPollingView;
  readonly sources: readonly RefreshSourceView[];
}

type Fields = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): Fields | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function isRefreshState(value: unknown): value is RefreshState {
  return typeof value === 'string' && (REFRESH_STATES as readonly string[]).includes(value);
}

/** A present field must be of the expected type; an absent one is fine. */
function optional<T>(
  record: Fields,
  key: string,
  check: (value: unknown) => value is T,
): { readonly ok: true; readonly value: T | undefined } | { readonly ok: false } {
  const value = record[key];
  if (value === undefined) return { ok: true, value: undefined };
  return check(value) ? { ok: true, value } : { ok: false };
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function parseCandidate(value: unknown): RefreshCandidateView | undefined | null {
  if (value === undefined) return undefined;
  const record = asRecord(value);
  if (
    record === undefined ||
    !isString(record['revision']) ||
    !isString(record['digest']) ||
    !isString(record['contractHash'])
  ) {
    return null;
  }
  return {
    revision: record['revision'],
    digest: record['digest'],
    contractHash: record['contractHash'],
  };
}

function parseCurrent(value: unknown): RefreshCurrentView | undefined | null {
  if (value === undefined) return undefined;
  const record = asRecord(value);
  if (record === undefined || !isString(record['revision']) || !isNumber(record['generation'])) {
    return null;
  }
  const contractHash = optional(record, 'contractHash', isString);
  const digest = optional(record, 'digest', isString);
  if (!contractHash.ok || !digest.ok) return null;
  return {
    revision: record['revision'],
    generation: record['generation'],
    ...(contractHash.value === undefined ? {} : { contractHash: contractHash.value }),
    ...(digest.value === undefined ? {} : { digest: digest.value }),
  };
}

function parseSource(value: unknown): RefreshSourceView | undefined {
  const record = asRecord(value);
  if (record === undefined || !isString(record['name']) || !isRefreshState(record['state'])) {
    return undefined;
  }
  const etag = optional(record, 'etag', isString);
  const checkedAt = optional(record, 'checkedAt', isNumber);
  const generation = optional(record, 'generation', isNumber);
  const reason = optional(record, 'reason', isString);
  const candidate = parseCandidate(record['candidate']);
  const current = parseCurrent(record['current']);
  if (
    !etag.ok ||
    !checkedAt.ok ||
    !generation.ok ||
    !reason.ok ||
    candidate === null ||
    current === null
  ) {
    return undefined;
  }
  return {
    name: record['name'],
    state: record['state'],
    ...(etag.value === undefined ? {} : { etag: etag.value }),
    ...(checkedAt.value === undefined ? {} : { checkedAt: checkedAt.value }),
    ...(generation.value === undefined ? {} : { generation: generation.value }),
    ...(reason.value === undefined ? {} : { reason: reason.value }),
    ...(candidate === undefined ? {} : { candidate }),
    ...(current === undefined ? {} : { current }),
  };
}

function parsePolling(value: unknown): RefreshPollingView | undefined | null {
  if (value === undefined) return undefined;
  const record = asRecord(value);
  if (
    record === undefined ||
    !isNumber(record['intervalMilliseconds']) ||
    !isNumber(record['maxBackoffMilliseconds']) ||
    !isNumber(record['backoffMilliseconds'])
  ) {
    return null;
  }
  const nextCheckAt = optional(record, 'nextCheckAt', isNumber);
  if (!nextCheckAt.ok) return null;
  return {
    intervalMilliseconds: record['intervalMilliseconds'],
    maxBackoffMilliseconds: record['maxBackoffMilliseconds'],
    backoffMilliseconds: record['backoffMilliseconds'],
    ...(nextCheckAt.value === undefined ? {} : { nextCheckAt: nextCheckAt.value }),
  };
}

/** The view of a `weft.workflows.refresh.diagnostics` response, or `undefined` when it is malformed. */
export function parseRefreshDiagnostics(raw: unknown): RefreshDiagnosticsView | undefined {
  const record = asRecord(raw);
  if (record === undefined || !Array.isArray(record['sources'])) return undefined;
  const sources: RefreshSourceView[] = [];
  for (const entry of record['sources']) {
    const source = parseSource(entry);
    if (source === undefined) return undefined;
    sources.push(source);
  }
  const polling = parsePolling(record['polling']);
  if (polling === null) return undefined;
  return { sources, ...(polling === undefined ? {} : { polling }) };
}

/** One labelled value in a source's description list. */
export interface RefreshField {
  readonly term: string;
  readonly value: string;
}

const NOT_REPORTED = 'Not reported';

function hashField(term: string, value: string | undefined): RefreshField {
  return { term, value: value ?? NOT_REPORTED };
}

/** Current identity, then candidate identity, ETag, and the last check, in display order. */
export function sourceFields(source: RefreshSourceView, now: number): readonly RefreshField[] {
  const { current, candidate } = source;
  return [
    { term: 'Current revision', value: current?.revision ?? 'None active' },
    hashField('Current contract hash', current?.contractHash),
    hashField('Current digest', current?.digest),
    { term: 'Candidate revision', value: candidate?.revision ?? 'No candidate' },
    hashField('Candidate contract hash', candidate?.contractHash),
    hashField('Candidate digest', candidate?.digest),
    { term: 'ETag', value: source.etag ?? NOT_REPORTED },
    {
      term: 'Last check',
      value:
        source.checkedAt === undefined
          ? 'Never'
          : `${formatRelativeTime(source.checkedAt, now)} (${new Date(source.checkedAt).toISOString()})`,
    },
  ];
}

/** Whether a validated candidate is installed that is not the active revision. */
export function hasPendingCandidate(source: RefreshSourceView): boolean {
  return source.candidate !== undefined && source.candidate.revision !== source.current?.revision;
}

/** The generation fence a check or activation should send: the active generation, or 0 before any activation. */
export function activeGeneration(source: RefreshSourceView): number {
  return source.current?.generation ?? 0;
}

/**
 * A duration in the largest unit that shows it exactly: `500ms`, `90s`, `15m`,
 * `2h`. Never rounded, so the policy reads as the server set it.
 */
export function formatPollDuration(milliseconds: number): string {
  if (milliseconds % 1000 !== 0) return `${milliseconds}ms`;
  const seconds = milliseconds / 1000;
  if (seconds % 3600 === 0 && seconds !== 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0 && seconds !== 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** The checking mode: manual maintenance, or polling with its policy. */
export type RefreshModeSummary =
  | { readonly mode: 'manual'; readonly description: string }
  | {
      readonly mode: 'polling';
      readonly description: string;
      readonly fields: readonly RefreshField[];
    };

/**
 * What the server says about how checks run. Polling is engine-wide, so this
 * is the same for every source; the panel shows it only beside a source.
 */
export function modeSummary(
  polling: RefreshPollingView | undefined,
  now: number,
): RefreshModeSummary {
  if (polling === undefined) {
    return {
      mode: 'manual',
      description:
        'Manual maintenance: this source is checked only when you or the host start a check.',
    };
  }
  return {
    mode: 'polling',
    description: 'Polling: the engine checks this source on a schedule.',
    fields: [
      { term: 'Interval', value: formatPollDuration(polling.intervalMilliseconds) },
      { term: 'Maximum backoff', value: formatPollDuration(polling.maxBackoffMilliseconds) },
      { term: 'Current backoff', value: formatPollDuration(polling.backoffMilliseconds) },
      {
        term: 'Next check',
        value:
          polling.nextCheckAt === undefined
            ? 'A check is running'
            : `${formatRelativeTime(polling.nextCheckAt, now)} (${new Date(polling.nextCheckAt).toISOString()})`,
      },
    ],
  };
}
