import {
  embeddingProfileOf,
  type EvidenceProjectionRecord,
  sameEmbeddingProfile,
} from './evidence-projection-schema';
import type { TransitionRefusal } from './transition-outcome';
import {
  plannedProjections,
  projectionLabel,
  type TransitionPlan,
  type TransitionValidationContext,
} from './transition-plan';

/**
 * Check 7: one invariant set per projection kind, plus an embedding-fit
 * invariant for any projection that carries an embedding. Each is decidable
 * from the proposal and reads of current revisions in the namespace; none needs
 * the batch. A failure begins its detail with the invariant's name.
 *
 * The record schema already enforces the rest (an episode ends after it
 * begins, a chunk ends after it starts, a chunk has one source, sources are
 * distinct, status follows transition), so none is repeated here.
 */

function violation(
  name: string,
  record: EvidenceProjectionRecord,
  what: string,
): TransitionRefusal {
  return {
    reason: 'type-invariant-violated',
    detail: `${name}: ${projectionLabel(record)} ${what}`,
  };
}

function hasRepeat(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

/** Invariants a record carries by itself, from its own payload. */
function ownInvariant(record: EvidenceProjectionRecord): TransitionRefusal | undefined {
  switch (record.kind) {
    case 'fact':
      return hasRepeat(record.payload.entities)
        ? violation('fact.entities-distinct', record, 'names an entity twice.')
        : undefined;
    case 'episode':
      return record.validity.validFrom < record.payload.occurredFrom
        ? violation(
            'episode.recall-not-before-occurrence',
            record,
            `is valid from ${record.validity.validFrom}, before the episode began (${record.payload.occurredFrom}).`,
          )
        : undefined;
    case 'procedure':
      return hasRepeat(record.payload.steps) || record.payload.steps.includes(record.payload.title)
        ? violation(
            'procedure.steps-distinct',
            record,
            'repeats a step, or a step repeats its title.',
          )
        : undefined;
    case 'preference':
      return record.payload.subject === record.payload.statement
        ? violation('preference.subject-differs', record, 'states nothing beyond its subject.')
        : undefined;
    case 'chunk': {
      const last = record.payload.steps.at(-1);
      return last?.step === 'chunk'
        ? undefined
        : violation(
            'chunk.chain-ends-in-chunk',
            record,
            'does not end its transformation chain in a chunk step.',
          );
    }
    case 'summary':
      return undefined;
  }
}

/** The summary's sources cover those of everything it covers, read at the covered revision. */
async function summaryCovers(
  context: TransitionValidationContext,
  built: readonly EvidenceProjectionRecord[],
  record: EvidenceProjectionRecord,
): Promise<TransitionRefusal | undefined> {
  if (record.kind !== 'summary') return undefined;
  const { covers } = record.payload;
  const addresses = covers.map((cover) => `${cover.id}@${cover.revision}`);
  if (hasRepeat(addresses) || covers.some((cover) => cover.id === record.id)) {
    return violation('summary.sources-cover', record, 'covers a revision twice, or covers itself.');
  }
  const summarized = new Set(
    record.sources.map((source) => `${source.evidenceId}|${source.digest}`),
  );
  for (const cover of covers) {
    const covered =
      built.find(
        (candidate) =>
          candidate.namespace === record.namespace &&
          candidate.id === cover.id &&
          candidate.revision === cover.revision,
      ) ?? (await context.reader.projectionRevision(record.namespace, cover.id, cover.revision));
    if (covered === undefined) continue;
    for (const source of covered.sources) {
      if (!summarized.has(`${source.evidenceId}|${source.digest}`)) {
        return violation(
          'summary.sources-cover',
          record,
          `does not carry evidence "${source.evidenceId}" of the ${cover.id}@${cover.revision} it covers.`,
        );
      }
    }
  }
  return undefined;
}

/** Chunks of one proposal that share a source evidence record have distinct ordinals. */
function chunkOrdinals(built: readonly EvidenceProjectionRecord[]): TransitionRefusal | undefined {
  const seen = new Map<string, string>();
  for (const record of built) {
    if (record.kind !== 'chunk') continue;
    const key = `${record.namespace}|${record.sources[0]?.evidenceId}|${record.payload.ordinal}`;
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      return violation(
        'chunk.ordinal-distinct',
        record,
        `repeats ordinal ${record.payload.ordinal} of ${earlier}, from the same evidence.`,
      );
    }
    seen.set(key, projectionLabel(record));
  }
  return undefined;
}

/**
 * Every embedding that stays recallable agrees with the namespace's on model
 * and dimension, since a vector index takes one of each. The namespace's
 * embedding profile marker is the profile by construction, so a proposal whose
 * embeddings all match it fits on that one read. Otherwise (no marker yet, or a
 * proposal that changes the profile) what stays recallable is the post-proposal
 * state: stored active or demoted projections the proposal does not retire, plus
 * what it writes. A demoted candidate stays recallable and is compared with; a
 * superseded or revoked one is not. The store plans the same marker in the
 * commit's batch, which is what keeps two proposals that each fit the state they
 * read from both applying.
 */
async function embeddingFits(
  context: TransitionValidationContext,
  plan: TransitionPlan,
  built: readonly EvidenceProjectionRecord[],
  written: readonly EvidenceProjectionRecord[],
): Promise<TransitionRefusal | undefined> {
  const namespaces = new Set(
    written.filter((record) => record.embedding !== undefined).map((record) => record.namespace),
  );
  for (const namespace of namespaces) {
    const marker = await context.reader.embeddingProfile(namespace);
    const matchesMarker = written
      .filter((record) => record.namespace === namespace && record.embedding !== undefined)
      .every(
        (record) =>
          marker !== undefined &&
          record.embedding !== undefined &&
          sameEmbeddingProfile(embeddingProfileOf(record.embedding), marker),
      );
    if (matchesMarker) continue;
    const touched = new Set(
      plan.revisions
        .filter((revision) => revision.namespace === namespace)
        .map((revision) => revision.id),
    );
    const recallable = await context.reader.recallable(namespace);
    const stored = recallable.filter((record) => !touched.has(record.id));
    const after = [...stored, ...built.filter((record) => record.namespace === namespace)].filter(
      (record) => record.status === 'active' || record.status === 'demoted',
    );
    for (const record of written) {
      if (record.namespace !== namespace || record.embedding === undefined) continue;
      for (const other of after) {
        if (other.id === record.id || other.embedding === undefined) continue;
        if (other.embedding.model !== record.embedding.model) {
          return violation(
            'embedding.fits-namespace',
            record,
            `is embedded with model "${record.embedding.model}", but "${other.id}" stays recallable with "${other.embedding.model}".`,
          );
        }
        if (other.embedding.vector.length !== record.embedding.vector.length) {
          return violation(
            'embedding.fits-namespace',
            record,
            `has ${record.embedding.vector.length} dimensions, but "${other.id}" stays recallable with ${other.embedding.vector.length}.`,
          );
        }
      }
    }
  }
  return undefined;
}

export async function checkTypeInvariants(
  context: TransitionValidationContext,
  plan: TransitionPlan,
): Promise<TransitionRefusal | undefined> {
  const built = plannedProjections(plan);
  // A non-rebuilt revision keeps its payload, so only what the proposal writes anew is checked.
  const written = [
    ...plan.created,
    ...plan.revisions.flatMap((revision) =>
      revision.changeKind === 'rebuilt' && revision.next !== undefined ? [revision.next] : [],
    ),
  ];
  for (const record of written) {
    const refusal = ownInvariant(record) ?? (await summaryCovers(context, built, record));
    if (refusal !== undefined) return refusal;
  }
  return chunkOrdinals(written) ?? (await embeddingFits(context, plan, built, written));
}
