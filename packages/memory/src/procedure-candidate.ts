import type {
  PROCEDURE_SCOPES,
  ProcedurePayloadV2,
  ProjectionReference,
  ProjectionSource,
} from './evidence-projection-schema';
import type { EvidenceProjectionStorage } from './evidence-projection-storage';

/**
 * What a proposer claims a procedure is, before anything validates it. Every
 * field of the validated payload except its provenance, which extraction and
 * promotion fill in, and its approval requirement, which follows from `scope`.
 */
export interface ProcedureDraft extends Omit<
  ProcedurePayloadV2,
  'version' | 'approval' | 'provenance'
> {
  readonly scope: (typeof PROCEDURE_SCOPES)[number];
}

/**
 * A proposed procedure linked to the episodes it was extracted from. It is a
 * value, not a stored record: nothing is retrievable until promotion validates
 * it and commits it as a `procedure` projection.
 */
export interface ProcedureCandidate {
  readonly tenantId: string;
  readonly namespace: string;
  readonly draft: ProcedureDraft;
  readonly successfulEpisodes: readonly ProjectionReference[];
  readonly failedEpisodes: readonly ProjectionReference[];
  /** The episodes' evidence, deduplicated: what the promoted procedure rests on besides its validation. */
  readonly sources: readonly ProjectionSource[];
}

/** Why an extraction was refused. */
export type ProcedureCandidateErrorCode =
  | 'episode-not-found'
  | 'not-an-episode'
  | 'episode-not-current'
  | 'no-successful-episode'
  | 'no-causal-step'
  | 'contradictory-episodes';

/** Thrown for a candidate that cannot be extracted from the episodes it names. */
export class ProcedureCandidateError extends Error {
  constructor(
    readonly code: ProcedureCandidateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProcedureCandidateError';
  }
}

/** What {@link extractProcedureCandidate} reads: the draft and the exact episode revisions it came from. */
export interface ExtractProcedureCandidateOptions {
  readonly storage: EvidenceProjectionStorage;
  readonly tenantId: string;
  readonly namespace: string;
  readonly draft: ProcedureDraft;
  /** The exact episode revisions the procedure worked in. At least one. */
  readonly successfulEpisodes: readonly ProjectionReference[];
  /** The exact episode revisions it failed in; they are kept as provenance, never dropped. */
  readonly failedEpisodes?: readonly ProjectionReference[];
}

/**
 * Refuses episode lists that name an episode twice, or call one episode both a
 * success and a failure, so a procedure's provenance can never contradict itself.
 */
export function assertDistinctEpisodes(
  successful: readonly ProjectionReference[],
  failed: readonly ProjectionReference[],
): void {
  const ids = [...successful, ...failed].map((reference) => reference.id);
  if (new Set(ids).size !== ids.length) {
    throw new ProcedureCandidateError(
      'contradictory-episodes',
      'An episode is named twice, or as both a success and a failure.',
    );
  }
}

/**
 * Reads each episode at its exact revision and checks it is still the current,
 * unrevoked revision, returning their evidence. Promotion runs it again, so an
 * episode withdrawn after extraction cannot back a procedure.
 */
export async function readCurrentEpisodes(
  options: Pick<ExtractProcedureCandidateOptions, 'storage' | 'tenantId' | 'namespace'>,
  references: readonly ProjectionReference[],
): Promise<ProjectionSource[]> {
  const sources: ProjectionSource[] = [];
  for (const reference of references) {
    const label = `${options.namespace}/${reference.id}@${reference.revision}`;
    const episode = await options.storage.getProjectionRevision(
      options.tenantId,
      options.namespace,
      reference.id,
      reference.revision,
    );
    if (episode === undefined) {
      throw new ProcedureCandidateError('episode-not-found', `Episode ${label} does not exist.`);
    }
    if (episode.kind !== 'episode') {
      throw new ProcedureCandidateError(
        'not-an-episode',
        `${label} is a ${episode.kind}, not an episode.`,
      );
    }
    const current = await options.storage.getProjection(
      options.tenantId,
      options.namespace,
      reference.id,
    );
    if (current?.revision !== reference.revision || current.status === 'revoked') {
      throw new ProcedureCandidateError(
        'episode-not-current',
        `Episode ${label} is no longer its current, unrevoked revision.`,
      );
    }
    sources.push(...episode.sources);
  }
  return sources;
}

/**
 * Links a drafted procedure to the successful and failed episodes it came from.
 * The draft must claim at least one step as causal: a sequence of steps that
 * merely preceded a success is not a procedure. Extraction stores nothing, and
 * no number of successful episodes promotes a candidate by itself; only
 * `promoteProcedure`, with a validator, can.
 */
export async function extractProcedureCandidate(
  options: ExtractProcedureCandidateOptions,
): Promise<ProcedureCandidate> {
  const failedEpisodes = options.failedEpisodes ?? [];
  if (options.successfulEpisodes.length === 0) {
    throw new ProcedureCandidateError(
      'no-successful-episode',
      'A procedure is extracted from at least one episode it succeeded in.',
    );
  }
  if (!options.draft.steps.some((step) => step.causal)) {
    throw new ProcedureCandidateError(
      'no-causal-step',
      'The draft claims no step caused the outcome, so it describes a run, not a procedure.',
    );
  }
  assertDistinctEpisodes(options.successfulEpisodes, failedEpisodes);
  const sources = [
    ...(await readCurrentEpisodes(options, options.successfulEpisodes)),
    ...(await readCurrentEpisodes(options, failedEpisodes)),
  ];
  const distinct = new Map(sources.map((source) => [source.evidenceId, source]));
  return {
    tenantId: options.tenantId,
    namespace: options.namespace,
    draft: options.draft,
    successfulEpisodes: options.successfulEpisodes,
    failedEpisodes,
    sources: [...distinct.values()],
  };
}
