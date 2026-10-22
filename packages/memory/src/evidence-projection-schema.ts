import { z } from 'zod';

import { MemoryEvidenceValidationError, parseWithRejectionCodes } from './evidence-schema';
import {
  digestSchema,
  epochMilliseconds,
  nonEmpty,
  producerSchema,
} from './evidence-schema-primitives';

export const PROJECTION_SCHEMA_VERSION = 1;
export const PROJECTION_KINDS = [
  'fact',
  'episode',
  'procedure',
  'preference',
  'summary',
  'chunk',
] as const;
export const PROJECTION_STATUSES = ['active', 'demoted', 'superseded', 'revoked'] as const;
export const PROJECTION_TRANSITION_KINDS = [
  'created',
  'rebuilt',
  'demoted',
  'superseded',
  'revoked',
] as const;
export const TRANSFORMATION_STEPS = ['extract', 'ocr', 'caption', 'transcript', 'chunk'] as const;
/** Ten decimal digits: the history key pads the revision to this width. */
export const MAX_PROJECTION_REVISION = 9_999_999_999;

export type ProjectionKind = (typeof PROJECTION_KINDS)[number];
export type ProjectionStatus = (typeof PROJECTION_STATUSES)[number];

export const revisionSchema = z.number().int().positive().max(MAX_PROJECTION_REVISION);
export const projectionReferenceSchema = z
  .object({ id: nonEmpty, revision: revisionSchema })
  .strict();
export const sourceSchema = z.object({ evidenceId: nonEmpty, digest: digestSchema }).strict();
const transformationStepSchema = z
  .object({
    step: z.enum(TRANSFORMATION_STEPS),
    producer: producerSchema,
    inputDigest: digestSchema,
    outputDigest: digestSchema,
  })
  .strict();

export type ProjectionReference = z.infer<typeof projectionReferenceSchema>;
export type ProjectionSource = z.infer<typeof sourceSchema>;
export type TransformationStep = z.infer<typeof transformationStepSchema>;

const transitionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('created'),
      at: epochMilliseconds,
      supersedes: z.array(projectionReferenceSchema).min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('rebuilt'),
      at: epochMilliseconds,
      rebuiltFromRevision: revisionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('demoted'),
      at: epochMilliseconds,
      demotedBy: projectionReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('superseded'),
      at: epochMilliseconds,
      supersededBy: projectionReferenceSchema,
    })
    .strict(),
  z.object({ kind: z.literal('revoked'), at: epochMilliseconds, reasonCode: nonEmpty }).strict(),
]);

export const embeddingSchema = z
  .object({ model: nonEmpty, vector: z.array(z.number()).min(1) })
  .strict();

export const projectionRecordBase = {
  schemaVersion: z.literal(PROJECTION_SCHEMA_VERSION),
  id: nonEmpty,
  tenantId: nonEmpty,
  namespace: nonEmpty,
  revision: revisionSchema,
  projectorRevision: nonEmpty,
  policyRevision: nonEmpty,
  sources: z.array(sourceSchema).min(1),
  validity: z
    .object({ validFrom: epochMilliseconds, validUntil: epochMilliseconds.optional() })
    .strict()
    .refine(
      (validity) => validity.validUntil === undefined || validity.validUntil > validity.validFrom,
      'validity is half-open and non-empty',
    ),
  confidence: z.number().min(0).max(1),
  status: z.enum(PROJECTION_STATUSES),
  transition: transitionSchema,
  embedding: embeddingSchema.optional(),
};

export const factPayload = z.object({ statement: nonEmpty, entities: z.array(nonEmpty) }).strict();
export const episodePayload = z
  .object({
    summary: nonEmpty,
    occurredFrom: epochMilliseconds,
    occurredTo: epochMilliseconds.optional(),
  })
  .strict()
  .refine(
    (payload) => payload.occurredTo === undefined || payload.occurredTo >= payload.occurredFrom,
    'an episode does not end before it begins',
  );
/** A procedure as COR-769 first stored it: a title and its ordered steps. */
export const procedurePayloadV1 = z
  .object({ title: nonEmpty, steps: z.array(nonEmpty).min(1) })
  .strict();

/** What a procedure step does. A `tool` step names the tool it calls; the others carry their text. */
export const PROCEDURE_STEP_KINDS = ['command', 'code', 'tool', 'check'] as const;

/**
 * How much review promoting a procedure needs. A `high-impact` procedure is one
 * whose steps change state outside the run (deploy, delete, pay, send), and its
 * promotion waits for a human reviewer.
 */
export const PROCEDURE_SCOPES = ['routine', 'high-impact'] as const;

const procedureStepSchema = z
  .object({
    kind: z.enum(PROCEDURE_STEP_KINDS),
    text: nonEmpty,
    /** The tool a `tool` step calls; required for that kind and absent for the others. */
    tool: nonEmpty.optional(),
    /** Whether the extraction claims this step caused the outcome, rather than merely preceding it. */
    causal: z.boolean(),
  })
  .strict()
  .refine(
    (step) => (step.kind === 'tool') === (step.tool !== undefined),
    'a tool step names its tool, and only a tool step',
  );

/** The principal kinds that stand for a person, the only ones that may review a high-impact procedure. */
export const PROCEDURE_REVIEWER_KINDS = ['user', 'governance'] as const;

const procedureReviewSchema = z
  .object({
    reviewer: z.object({ kind: z.enum(PROCEDURE_REVIEWER_KINDS), id: nonEmpty }).strict(),
    decidedAt: epochMilliseconds,
    reviewId: nonEmpty,
  })
  .strict();

const procedureValidationSchema = z
  .object({
    evaluator: z
      .object({ name: nonEmpty, revision: nonEmpty, kind: z.enum(['deterministic', 'evaluator']) })
      .strict(),
    /** Digest of the exact fixture the validation ran. */
    fixtureDigest: digestSchema,
    outcome: z.literal('passed'),
    /** What the validation observed, verbatim, and its digest. */
    observation: nonEmpty,
    observationDigest: digestSchema,
  })
  .strict();

/**
 * A validated procedure (COR-770). It is a revision of the same `procedure`
 * kind, discriminated by `version`, so every procedure COR-769 stored still
 * parses unchanged. Confidence and lifecycle status live on the projection
 * record itself, like every other kind's.
 */
export const procedurePayloadV2 = z
  .object({
    version: z.literal(2),
    title: nonEmpty,
    objective: nonEmpty,
    taskClass: nonEmpty,
    preconditions: z.array(nonEmpty),
    requiredCapabilities: z.array(nonEmpty),
    /** Environment and dependency versions the procedure was validated against. */
    environment: z.array(z.object({ name: nonEmpty, version: nonEmpty }).strict()),
    steps: z.array(procedureStepSchema).min(1),
    expectedEvidence: z.array(nonEmpty),
    postconditions: z.array(nonEmpty),
    knownFailures: z.array(z.object({ signature: nonEmpty, remedy: nonEmpty.optional() }).strict()),
    sideEffects: z.array(nonEmpty),
    approval: z.object({ scope: z.enum(PROCEDURE_SCOPES), required: z.boolean() }).strict(),
    provenance: z
      .object({
        successfulEpisodes: z.array(projectionReferenceSchema),
        failedEpisodes: z.array(projectionReferenceSchema),
        validation: procedureValidationSchema,
        review: procedureReviewSchema.optional(),
      })
      .strict(),
  })
  .strict();

export const procedurePayload = z.union([procedurePayloadV1, procedurePayloadV2]);

export type ProcedurePayloadV2 = z.infer<typeof procedurePayloadV2>;
export type ProcedureStep = ProcedurePayloadV2['steps'][number];

/** One step's identity: two steps with the same key are the same step. */
export function procedureStepKey(step: string | ProcedureStep): string {
  return typeof step === 'string' ? step : JSON.stringify([step.kind, step.tool ?? '', step.text]);
}

/**
 * A procedure's searchable text. A validated procedure includes what it is for,
 * the tools it calls, and the failures it is known for, so a query that names
 * only an objective, a tool, or a failure signature still finds it.
 */
function procedureText(payload: z.infer<typeof procedurePayload>): string {
  if (!('version' in payload)) return [payload.title, ...payload.steps].join('\n');
  return [
    payload.title,
    payload.objective,
    payload.taskClass,
    ...payload.preconditions,
    ...payload.steps.flatMap((step) =>
      step.tool === undefined ? [step.text] : [step.text, step.tool],
    ),
    ...payload.expectedEvidence,
    ...payload.postconditions,
    ...payload.knownFailures.map((failure) => failure.signature),
    ...payload.sideEffects,
  ].join('\n');
}

/** The text of each step, for search and for the `steps-distinct` title check. */
export function procedureStepText(step: string | ProcedureStep): string {
  return typeof step === 'string' ? step : step.text;
}
export const preferencePayload = z.object({ subject: nonEmpty, statement: nonEmpty }).strict();
export const summaryPayload = z
  .object({ text: nonEmpty, covers: z.array(projectionReferenceSchema).min(1) })
  .strict();
export const chunkPayload = z
  .object({
    text: nonEmpty,
    ordinal: z.number().int().nonnegative(),
    startLine: z.number().int().nonnegative(),
    endLine: z.number().int().nonnegative(),
    heading: nonEmpty.optional(),
    steps: z.array(transformationStepSchema).min(1),
  })
  .strict()
  .refine(
    (payload) => payload.endLine >= payload.startLine,
    'a chunk does not end before it begins',
  );

/** Each kind's payload schema, so a proposal can narrow a payload against a stored kind. */
export const PROJECTION_PAYLOAD_SCHEMAS = {
  fact: factPayload,
  episode: episodePayload,
  procedure: procedurePayload,
  preference: preferencePayload,
  summary: summaryPayload,
  chunk: chunkPayload,
} as const satisfies Record<(typeof PROJECTION_KINDS)[number], z.ZodType>;

/** Sources name distinct evidence records. */
export function hasDistinctSources(record: {
  readonly sources: ReadonlyArray<{ readonly evidenceId: string }>;
}): boolean {
  return new Set(record.sources.map((source) => source.evidenceId)).size === record.sources.length;
}

/** A chunk projects exactly one source. */
export function chunkHasOneSource(record: {
  readonly kind: string;
  readonly sources: readonly unknown[];
}): boolean {
  return record.kind !== 'chunk' || record.sources.length === 1;
}

const STATUS_OF_TRANSITION: Readonly<
  Record<(typeof PROJECTION_TRANSITION_KINDS)[number], ProjectionStatus>
> = {
  created: 'active',
  rebuilt: 'active',
  demoted: 'demoted',
  superseded: 'superseded',
  revoked: 'revoked',
};

export const evidenceProjectionRecordSchema = z
  .discriminatedUnion('kind', [
    z.object({ ...projectionRecordBase, kind: z.literal('fact'), payload: factPayload }).strict(),
    z
      .object({ ...projectionRecordBase, kind: z.literal('episode'), payload: episodePayload })
      .strict(),
    z
      .object({ ...projectionRecordBase, kind: z.literal('procedure'), payload: procedurePayload })
      .strict(),
    z
      .object({
        ...projectionRecordBase,
        kind: z.literal('preference'),
        payload: preferencePayload,
      })
      .strict(),
    z
      .object({ ...projectionRecordBase, kind: z.literal('summary'), payload: summaryPayload })
      .strict(),
    z.object({ ...projectionRecordBase, kind: z.literal('chunk'), payload: chunkPayload }).strict(),
  ])
  .refine(
    (record) => record.status === STATUS_OF_TRANSITION[record.transition.kind],
    'status must follow from transition.kind',
  )
  .refine(
    (record) => (record.revision === 1) === (record.transition.kind === 'created'),
    'revision 1 is the created revision and nothing else is',
  )
  .refine(hasDistinctSources, 'sources are distinct')
  .refine(chunkHasOneSource, 'a chunk projects exactly one source')
  .refine(
    (record) =>
      record.transition.kind !== 'rebuilt' ||
      record.transition.rebuiltFromRevision < record.revision,
    'a rebuild follows the revision it rebuilds',
  );

export type EvidenceProjectionRecord = z.infer<typeof evidenceProjectionRecordSchema>;

export const EMBEDDING_PROFILE_SCHEMA_VERSION = 1;

/**
 * The per-namespace embedding profile marker: the model and dimension the
 * namespace's recallable embeddings share. A vector index takes one of each, so
 * the store keeps this marker in the same batch that writes an embedded record,
 * and two commits that would give a namespace incompatible embeddings cannot
 * both apply. It is the projection family's second persisted shape.
 */
export const embeddingProfileSchema = z
  .object({
    schemaVersion: z.literal(EMBEDDING_PROFILE_SCHEMA_VERSION),
    model: nonEmpty,
    dimensions: z.number().int().positive(),
    /**
     * How many embedded writes the namespace has taken. Every commit that writes
     * an embedded record puts the marker with the stored generation plus one, so
     * the second of two such commits to apply fails its marker condition.
     */
    generation: z.number().int().positive(),
  })
  .strict();

export type EmbeddingProfile = z.infer<typeof embeddingProfileSchema>;

export function embeddingProfileOf(
  embedding: {
    readonly model: string;
    readonly vector: readonly number[];
  },
  generation = 1,
): EmbeddingProfile {
  return {
    schemaVersion: EMBEDDING_PROFILE_SCHEMA_VERSION,
    model: embedding.model,
    dimensions: embedding.vector.length,
    generation,
  };
}

/** Two profiles are the same when model and dimensions are; the generation is bookkeeping, not identity. */
export function sameEmbeddingProfile(left: EmbeddingProfile, right: EmbeddingProfile): boolean {
  return left.model === right.model && left.dimensions === right.dimensions;
}

export function encodeEmbeddingProfile(profile: EmbeddingProfile): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(embeddingProfileSchema.parse(profile)));
}

export function decodeEmbeddingProfile(raw: unknown): EmbeddingProfile {
  return parseWithRejectionCodes(embeddingProfileSchema, raw, {
    record: 'projection',
    schemaVersion: EMBEDDING_PROFILE_SCHEMA_VERSION,
    sourceKey: undefined,
  });
}

/**
 * Validates a persisted projection with the evidence decoder's order. The
 * source-less signal is the `sources` array being absent, not an array, or
 * empty; an issue inside an element (a bad digest) is `malformed`. The decoder
 * raises no `digest-mismatch`: a source digest is checked against stored
 * evidence by `commit()` at write time and again when indexes are built.
 */
export function decodeEvidenceProjectionRecord(
  raw: unknown,
  context: { tenantId: string },
): EvidenceProjectionRecord {
  const parsed = parseWithRejectionCodes(evidenceProjectionRecordSchema, raw, {
    record: 'projection',
    schemaVersion: PROJECTION_SCHEMA_VERSION,
    sourceKey: 'sources',
  });
  if (parsed.tenantId !== context.tenantId) {
    throw new MemoryEvidenceValidationError(
      'cross-tenant',
      'projection',
      `Projection "${parsed.id}" belongs to another tenant.`,
    );
  }
  return parsed;
}

/** Canonical bytes for a projection revision: parse first, then stringify. */
export function encodeEvidenceProjectionRecord(record: EvidenceProjectionRecord): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(evidenceProjectionRecordSchema.parse(record)));
}

/**
 * The single lexical surface of a projection, used by the lexical index and by
 * consolidation when it hands text to a summarizer.
 */
export function projectionText(record: EvidenceProjectionRecord): string {
  switch (record.kind) {
    case 'fact':
      return record.payload.statement;
    case 'episode':
      return record.payload.summary;
    case 'procedure':
      return procedureText(record.payload);
    case 'preference':
      return `${record.payload.subject} ${record.payload.statement}`;
    case 'summary':
      return record.payload.text;
    case 'chunk':
      return record.payload.text;
  }
}
