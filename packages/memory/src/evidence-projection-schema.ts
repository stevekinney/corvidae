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

const revisionSchema = z.number().int().positive().max(MAX_PROJECTION_REVISION);
const projectionReferenceSchema = z.object({ id: nonEmpty, revision: revisionSchema }).strict();
const sourceSchema = z.object({ evidenceId: nonEmpty, digest: digestSchema }).strict();
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

const projectionBase = {
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
  embedding: z
    .object({ model: nonEmpty, vector: z.array(z.number()).min(1) })
    .strict()
    .optional(),
};

const factPayload = z.object({ statement: nonEmpty, entities: z.array(nonEmpty) }).strict();
const episodePayload = z
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
const procedurePayload = z.object({ title: nonEmpty, steps: z.array(nonEmpty).min(1) }).strict();
const preferencePayload = z.object({ subject: nonEmpty, statement: nonEmpty }).strict();
const summaryPayload = z
  .object({ text: nonEmpty, covers: z.array(projectionReferenceSchema).min(1) })
  .strict();
const chunkPayload = z
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
    z.object({ ...projectionBase, kind: z.literal('fact'), payload: factPayload }).strict(),
    z.object({ ...projectionBase, kind: z.literal('episode'), payload: episodePayload }).strict(),
    z
      .object({ ...projectionBase, kind: z.literal('procedure'), payload: procedurePayload })
      .strict(),
    z
      .object({ ...projectionBase, kind: z.literal('preference'), payload: preferencePayload })
      .strict(),
    z.object({ ...projectionBase, kind: z.literal('summary'), payload: summaryPayload }).strict(),
    z.object({ ...projectionBase, kind: z.literal('chunk'), payload: chunkPayload }).strict(),
  ])
  .refine(
    (record) => record.status === STATUS_OF_TRANSITION[record.transition.kind],
    'status must follow from transition.kind',
  )
  .refine(
    (record) => (record.revision === 1) === (record.transition.kind === 'created'),
    'revision 1 is the created revision and nothing else is',
  )
  .refine(
    (record) =>
      new Set(record.sources.map((source) => source.evidenceId)).size === record.sources.length,
    'sources are distinct',
  )
  .refine(
    (record) => record.kind !== 'chunk' || record.sources.length === 1,
    'a chunk projects exactly one source',
  )
  .refine(
    (record) =>
      record.transition.kind !== 'rebuilt' ||
      record.transition.rebuiltFromRevision < record.revision,
    'a rebuild follows the revision it rebuilds',
  );

export type EvidenceProjectionRecord = z.infer<typeof evidenceProjectionRecordSchema>;

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
      return [record.payload.title, ...record.payload.steps].join('\n');
    case 'preference':
      return `${record.payload.subject} ${record.payload.statement}`;
    case 'summary':
      return record.payload.text;
    case 'chunk':
      return record.payload.text;
  }
}
