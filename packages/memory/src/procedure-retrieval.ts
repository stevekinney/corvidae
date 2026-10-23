import { buildDerivedIndexes, readConsistently } from './derived-indexes';
import type {
  EvidenceProjectionRecord,
  ProcedurePayloadV2,
  ProjectionReference,
  ProjectionSource,
} from './evidence-projection-schema';
import type { EvidenceProjectionStorage } from './evidence-projection-storage';
import { hasMemoryCapability, type MemoryAuthority } from './governance/authority';
import type { MemoryRecallStopReason } from './governance/retrieval-plan';

type ProcedureRecord = Extract<EvidenceProjectionRecord, { kind: 'procedure' }>;

/** One dependency of the environment a procedure would run in. */
export interface ProcedureEnvironmentEntry {
  readonly name: string;
  readonly version: string;
}

/** What {@link retrieveProcedures} looks for, and the environment it must fit. */
export interface RetrieveProceduresOptions {
  readonly storage: EvidenceProjectionStorage;
  /** Needs `memory:search`; it sees only procedures whose evidence it may search. */
  readonly authority: MemoryAuthority;
  readonly namespace: string;
  readonly query: string;
  /**
   * The environment the procedure would run in. A procedure fits when every
   * dependency it was validated against is present here, at the same version
   * or a more specific one (`2.11` fits `2.11.4`, not `2.12`).
   */
  readonly environment: readonly ProcedureEnvironmentEntry[];
  /** The capabilities the run holds now; a procedure needing one it lacks does not fit. */
  readonly capabilities: readonly string[];
  /** The preconditions known to hold. When given, a procedure fits only if all of its own hold. */
  readonly satisfiedPreconditions?: readonly string[];
  /** Defaults to 5. */
  readonly limit?: number;
  readonly now: () => number;
}

/** Why a procedure the caller may see was left out, before anything was scored. */
export type ProcedureExclusionReason =
  | 'unvalidated'
  | 'environment-missing'
  | 'environment-mismatch'
  | 'capability-missing'
  | 'precondition-unmet';

/** One procedure that fit, with what a caller needs to judge it beyond its steps. */
export interface ProcedureMatch {
  readonly procedure: ProjectionReference;
  readonly status: 'active' | 'demoted';
  readonly payload: ProcedurePayloadV2;
  readonly score: number;
  /** The evidence the procedure rests on, and the validation that promoted it. */
  readonly proof: {
    readonly sources: readonly ProjectionSource[];
    readonly validation: ProcedurePayloadV2['provenance']['validation'];
    readonly review?: ProcedurePayloadV2['provenance']['review'];
  };
  /** When the current revision took effect, and how old it was at retrieval. */
  readonly freshness: {
    readonly validFrom: number;
    readonly changedAt: number;
    readonly ageMilliseconds: number;
  };
  readonly confidence: number;
  readonly knownFailures: ProcedurePayloadV2['knownFailures'];
  /** The revision this one replaced, when it is a rebuilt replacement; the episode that demoted it, when demoted. */
  readonly lineage: { readonly replaces?: number; readonly demotedBy?: ProjectionReference };
}

/** What a retrieval found and why it stopped. */
export interface ProcedureRetrieval {
  readonly matches: readonly ProcedureMatch[];
  readonly exclusions: readonly {
    readonly procedure: ProjectionReference;
    readonly reason: ProcedureExclusionReason;
    readonly detail: string;
  }[];
  readonly stopReason: MemoryRecallStopReason;
}

/** Whether `available` is `required` or a more specific version of it. */
function versionFits(required: string, available: string): boolean {
  return available === required || available.startsWith(`${required}.`);
}

/** The first reason a procedure does not fit the caller's environment, capabilities, or preconditions. */
function compatibility(
  options: RetrieveProceduresOptions,
  payload: ProcedurePayloadV2,
): { reason: ProcedureExclusionReason; detail: string } | undefined {
  for (const dependency of payload.environment) {
    // An environment may list a dependency more than once; any installed version that fits will do.
    const versions = options.environment
      .filter((entry) => entry.name === dependency.name)
      .map((entry) => entry.version);
    if (versions.length === 0) {
      return {
        reason: 'environment-missing',
        detail: `${dependency.name} is not in the environment.`,
      };
    }
    if (!versions.some((version) => versionFits(dependency.version, version))) {
      return {
        reason: 'environment-mismatch',
        detail: `${dependency.name} ${versions.join(', ')} does not fit the validated ${dependency.version}.`,
      };
    }
  }
  const missing = payload.requiredCapabilities.find(
    (capability) => !options.capabilities.includes(capability),
  );
  if (missing !== undefined) {
    return { reason: 'capability-missing', detail: `The run does not hold ${missing}.` };
  }
  const satisfied = options.satisfiedPreconditions;
  const unmet =
    satisfied === undefined
      ? undefined
      : payload.preconditions.find((item) => !satisfied.includes(item));
  return unmet === undefined
    ? undefined
    : { reason: 'precondition-unmet', detail: `"${unmet}" does not hold.` };
}

function matchOf(
  record: ProcedureRecord,
  payload: ProcedurePayloadV2,
  score: number,
  now: number,
): ProcedureMatch {
  const { transition } = record;
  return {
    procedure: { id: record.id, revision: record.revision },
    status: record.status === 'demoted' ? 'demoted' : 'active',
    payload,
    score,
    proof: {
      sources: record.sources,
      validation: payload.provenance.validation,
      ...(payload.provenance.review === undefined ? {} : { review: payload.provenance.review }),
    },
    freshness: {
      validFrom: record.validity.validFrom,
      changedAt: transition.at,
      ageMilliseconds: now - transition.at,
    },
    confidence: record.confidence,
    knownFailures: payload.knownFailures,
    lineage: {
      ...(transition.kind === 'rebuilt' ? { replaces: transition.rebuiltFromRevision } : {}),
      ...(transition.kind === 'demoted' ? { demotedBy: transition.demotedBy } : {}),
    },
  };
}

/**
 * Retrieves validated procedures that fit the caller. The stages run in a fixed
 * order, and nothing is scored until it passes every one before it: the
 * caller's authorization (the procedures whose evidence it may search, active
 * or demoted, never superseded or revoked), then validation (a COR-769 v1
 * procedure was never validated), then environment, capabilities, and
 * preconditions. Only the procedures left are scored, lexically over their
 * objective, steps, tools, and known failures, with a demoted one ranked lower.
 */
export async function retrieveProcedures(
  options: RetrieveProceduresOptions,
): Promise<ProcedureRetrieval> {
  const { authority, storage, namespace } = options;
  if (!hasMemoryCapability(authority, 'memory:search')) {
    return { matches: [], exclusions: [], stopReason: 'unavailable' };
  }
  const limit = options.limit ?? 5;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`A procedure retrieval limit is a positive integer, not ${limit}.`);
  }
  const now = options.now();
  // One consistent read: a correction that lands between separate reads could
  // pair old evidence with new projections and hide both revisions.
  const read = await readConsistently(storage, authority.tenantId, namespace);
  const { evidence, supersessions } = read;
  const procedures = read.projections.filter(
    (record): record is ProcedureRecord =>
      record.kind === 'procedure' && (record.status === 'active' || record.status === 'demoted'),
  );
  const visible = new Set(
    buildDerivedIndexes({ evidence, supersessions, projections: procedures, authority })
      .temporal.query({ asOf: now })
      .map((entry) => entry.id),
  );
  const exclusions: ProcedureRetrieval['exclusions'][number][] = [];
  const fitting: ProcedureRecord[] = [];
  for (const record of procedures) {
    if (!visible.has(record.id)) continue;
    const reference = { id: record.id, revision: record.revision };
    if (!('version' in record.payload)) {
      exclusions.push({
        procedure: reference,
        reason: 'unvalidated',
        detail: 'It was stored before procedures were validated.',
      });
      continue;
    }
    const misfit = compatibility(options, record.payload);
    if (misfit === undefined) fitting.push(record);
    else exclusions.push({ procedure: reference, ...misfit });
  }
  const hits = buildDerivedIndexes({
    evidence,
    supersessions,
    projections: fitting,
    authority,
  }).lexical.query(options.query, { limit });
  const byId = new Map(fitting.map((record) => [record.id, record]));
  const matches = hits.flatMap((hit) => {
    const record = byId.get(hit.id);
    return record === undefined || !('version' in record.payload)
      ? []
      : [matchOf(record, record.payload, hit.rankingScore, now)];
  });
  return { matches, exclusions, stopReason: matches.length >= limit ? 'sufficient' : 'exhausted' };
}
