import { sha256HexSync } from '@lostgradient/cryptography';
import { z } from 'zod';

import {
  chunkHasOneSource,
  embeddingSchema,
  hasDistinctSources,
  PROJECTION_PAYLOAD_SCHEMAS,
  type ProjectionKind,
  projectionRecordBase,
  projectionReferenceSchema,
  revisionSchema,
  sourceSchema,
} from './evidence-projection-schema';
import {
  evidenceRecordShape,
  hasValidSupersedes,
  SUPERSEDES_RULE_MESSAGE,
} from './evidence-schema';
import { epochMilliseconds, nonEmpty } from './evidence-schema-primitives';
import { memoryAuthoritySchema } from './transition-authority';

export const TRANSITION_PROPOSAL_KINDS = [
  'append-evidence',
  'correct-evidence',
  'create-projection',
  'revise-projection',
  'consolidate',
] as const;
export type TransitionProposalKind = (typeof TRANSITION_PROPOSAL_KINDS)[number];

/** A proposal failed its schema. Nothing about the store was consulted, so it is a throw, not an outcome. */
export class MemoryTransitionProposalError extends Error {
  readonly code = 'malformed';

  constructor(detail: string) {
    super(`The transition proposal is malformed: ${detail}`);
    this.name = 'MemoryTransitionProposalError';
  }
}

/** An evidence record as proposed: everything the stored record has except `writtenAt`. */
const { writtenAt: _writtenAt, ...proposedEvidenceShape } = evidenceRecordShape;
const proposedEvidenceSchema = z
  .object(proposedEvidenceShape)
  .strict()
  .refine(hasValidSupersedes, SUPERSEDES_RULE_MESSAGE);

/**
 * A projection as proposed for creation: no `schemaVersion`, `revision`,
 * `status`, `transition`, or `policyRevision`, which the engine stamps, and an
 * optional `validity`.
 */
const {
  schemaVersion: _schemaVersion,
  revision: _revision,
  status: _status,
  transition: _transition,
  policyRevision: _policyRevision,
  validity: _validity,
  ...proposedProjectionBase
} = projectionRecordBase;

const proposedValiditySchema = z
  .object({ validFrom: epochMilliseconds.optional(), validUntil: epochMilliseconds.optional() })
  .strict()
  .refine(
    (validity) =>
      validity.validFrom === undefined ||
      validity.validUntil === undefined ||
      validity.validUntil > validity.validFrom,
    'validity is half-open and non-empty',
  );

function createdProjection<Kind extends ProjectionKind, Payload extends z.ZodType>(
  kind: Kind,
  payload: Payload,
) {
  return z
    .object({
      ...proposedProjectionBase,
      kind: z.literal(kind),
      payload,
      validity: proposedValiditySchema.optional(),
      supersedes: z.array(projectionReferenceSchema).min(1).optional(),
    })
    .strict();
}

const proposedCreatedProjectionSchema = z
  .discriminatedUnion('kind', [
    createdProjection('fact', PROJECTION_PAYLOAD_SCHEMAS.fact),
    createdProjection('episode', PROJECTION_PAYLOAD_SCHEMAS.episode),
    createdProjection('procedure', PROJECTION_PAYLOAD_SCHEMAS.procedure),
    createdProjection('preference', PROJECTION_PAYLOAD_SCHEMAS.preference),
    createdProjection('summary', PROJECTION_PAYLOAD_SCHEMAS.summary),
    createdProjection('chunk', PROJECTION_PAYLOAD_SCHEMAS.chunk),
  ])
  .refine(hasDistinctSources, 'sources are distinct')
  .refine(chunkHasOneSource, 'a chunk projects exactly one source');

const confidenceSchema = z.number().min(0).max(1);

/** Deepest nesting a rebuilt payload may have; a payload this deep is not a record of memory. */
const MAXIMUM_PAYLOAD_DEPTH = 64;

/**
 * Whether a value survives a JSON round trip unchanged: plain objects and
 * arrays of strings, finite numbers, booleans, and null, with no cycles. A
 * `rebuilt` payload is `unknown` until the engine narrows it, so this is the
 * check that keeps a `bigint` or a cyclic object from escaping as a raw
 * `TypeError` when the proposal is digested.
 */
function isJsonValue(value: unknown, ancestors: readonly object[] = []): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (ancestors.includes(value) || ancestors.length >= MAXIMUM_PAYLOAD_DEPTH) return false;
  const path = [...ancestors, value];
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, path));
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every((member) => isJsonValue(member, path));
}

/**
 * A revision of one projection, at the revision the proposer expects it to be
 * at. `rebuilt.payload` is `unknown` here because the stored `kind` is not known
 * until the current revision is read; the engine narrows it against that kind.
 * A rebuilt revision carries exactly the embedding it proposes: a rebuild
 * replaces the payload, so an embedding of the old one is not kept.
 */
const proposedRevisionSchema = z
  .object({
    namespace: nonEmpty,
    id: nonEmpty,
    expectedRevision: revisionSchema,
    change: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('demoted'), demotedBy: projectionReferenceSchema }).strict(),
      z.object({ kind: z.literal('superseded'), supersededBy: projectionReferenceSchema }).strict(),
      z.object({ kind: z.literal('revoked'), reasonCode: nonEmpty }).strict(),
      z
        .object({
          kind: z.literal('rebuilt'),
          sources: z.array(sourceSchema).min(1),
          payload: z
            .unknown()
            .refine((value) => value !== undefined, 'a rebuild needs a payload')
            .refine(isJsonValue, 'a rebuilt payload must be plain JSON, without cycles'),
          embedding: embeddingSchema.optional(),
          confidence: confidenceSchema.optional(),
          projectorRevision: nonEmpty.optional(),
        })
        .strict(),
    ]),
    validity: proposedValiditySchema.optional(),
    confidence: confidenceSchema.optional(),
  })
  .strict();

const proposalBase = {
  operationId: nonEmpty,
  tenantId: nonEmpty,
  authority: memoryAuthoritySchema,
};

const appendEvidenceSchema = z
  .object({
    ...proposalBase,
    kind: z.literal('append-evidence'),
    evidence: z.array(proposedEvidenceSchema).min(1),
  })
  .strict()
  .refine(
    (proposal) => proposal.evidence.every((record) => record.supersedes === undefined),
    'append-evidence never supersedes; use correct-evidence',
  );

const correctEvidenceSchema = z
  .object({
    ...proposalBase,
    kind: z.literal('correct-evidence'),
    successor: proposedEvidenceSchema,
    projections: z.array(proposedCreatedProjectionSchema).optional(),
    revisions: z.array(proposedRevisionSchema).optional(),
  })
  .strict()
  .refine(
    (proposal) => proposal.successor.supersedes !== undefined,
    'correct-evidence supersedes at least one record',
  );

const createProjectionSchema = z
  .object({
    ...proposalBase,
    kind: z.literal('create-projection'),
    projections: z.array(proposedCreatedProjectionSchema).min(1),
  })
  .strict();

const reviseProjectionSchema = z
  .object({
    ...proposalBase,
    kind: z.literal('revise-projection'),
    revisions: z.array(proposedRevisionSchema).min(1),
  })
  .strict();

/** `candidates` has no minimum here: fewer than two is the validator's reason code, not a schema failure. */
const consolidateSchema = z
  .object({
    ...proposalBase,
    kind: z.literal('consolidate'),
    namespace: nonEmpty,
    candidates: z.array(projectionReferenceSchema),
    outcome: z.enum(['supersede', 'demote']),
    summary: z
      .object({
        id: nonEmpty,
        text: nonEmpty,
        embedding: embeddingSchema.optional(),
        confidence: confidenceSchema.optional(),
      })
      .strict(),
    projectorRevision: nonEmpty,
    promptRevision: nonEmpty,
  })
  .strict();

type ParsedProposal =
  | z.infer<typeof appendEvidenceSchema>
  | z.infer<typeof correctEvidenceSchema>
  | z.infer<typeof createProjectionSchema>
  | z.infer<typeof reviseProjectionSchema>
  | z.infer<typeof consolidateSchema>;

function tenantsAgree(proposal: ParsedProposal): boolean {
  const { tenantId } = proposal;
  if (proposal.authority.tenantId !== tenantId) return false;
  switch (proposal.kind) {
    case 'append-evidence':
      return proposal.evidence.every((record) => record.tenantId === tenantId);
    case 'correct-evidence':
      return (
        proposal.successor.tenantId === tenantId &&
        (proposal.projections ?? []).every((record) => record.tenantId === tenantId)
      );
    case 'create-projection':
      return proposal.projections.every((record) => record.tenantId === tenantId);
    default:
      return true;
  }
}

/** No record, projection, or revision is named twice in one proposal. */
function namesAreDistinct(proposal: ParsedProposal): boolean {
  const addresses: string[] = [];
  const address = (namespace: string, id: string) => JSON.stringify([namespace, id]);
  switch (proposal.kind) {
    case 'append-evidence': {
      const ids = proposal.evidence.map((record) => record.id);
      return new Set(ids).size === ids.length;
    }
    case 'consolidate':
      addresses.push(address(proposal.namespace, proposal.summary.id));
      for (const candidate of proposal.candidates) {
        addresses.push(address(proposal.namespace, candidate.id));
      }
      break;
    case 'correct-evidence':
    case 'create-projection':
    case 'revise-projection':
      for (const record of 'projections' in proposal ? (proposal.projections ?? []) : []) {
        addresses.push(address(record.namespace, record.id));
      }
      for (const revision of 'revisions' in proposal ? (proposal.revisions ?? []) : []) {
        addresses.push(address(revision.namespace, revision.id));
      }
      break;
  }
  return new Set(addresses).size === addresses.length;
}

export const transitionProposalSchema = z
  .discriminatedUnion('kind', [
    appendEvidenceSchema,
    correctEvidenceSchema,
    createProjectionSchema,
    reviseProjectionSchema,
    consolidateSchema,
  ])
  .refine(tenantsAgree, 'every record and the authority carry the proposal tenant')
  .refine(namesAreDistinct, 'no record is named twice');

export type TransitionProposal = z.infer<typeof transitionProposalSchema>;
export type AppendEvidenceProposal = Extract<TransitionProposal, { kind: 'append-evidence' }>;
export type CorrectEvidenceProposal = Extract<TransitionProposal, { kind: 'correct-evidence' }>;
export type CreateProjectionProposal = Extract<TransitionProposal, { kind: 'create-projection' }>;
export type ReviseProjectionProposal = Extract<TransitionProposal, { kind: 'revise-projection' }>;
export type ConsolidateProposal = Extract<TransitionProposal, { kind: 'consolidate' }>;
export type ProposedEvidence = z.infer<typeof proposedEvidenceSchema>;
export type ProposedProjection = z.infer<typeof proposedCreatedProjectionSchema>;
export type ProposedRevision = z.infer<typeof proposedRevisionSchema>;

/** Parses a proposal, or throws {@link MemoryTransitionProposalError}. */
export function parseTransitionProposal(raw: unknown): TransitionProposal {
  const result = transitionProposalSchema.safeParse(raw);
  if (result.success) return result.data;
  throw new MemoryTransitionProposalError(
    result.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; '),
  );
}

/**
 * JSON with every object's keys sorted. A `rebuilt` payload is `unknown` until
 * the engine narrows it, so its key order is the caller's; sorting makes the
 * digest independent of it.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item ?? null)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The idempotency digest: `sha256:` over the canonical JSON of the parsed
 * proposal, where canonical means every object's keys sorted and arrays left in
 * order. Parsing first drops absent optionals and rejects unknown keys. The
 * proposal carries none of the fields the engine stamps from its clock
 * (`writtenAt`, `transition.at`, and a `validity` bound derived from `now()`),
 * so two submissions of one proposal under different clocks share a digest.
 * Caller-supplied times such as `eventAt` and `observedAt` are in the proposal
 * and therefore in the digest. Order is semantic, so arrays are not sorted.
 */
export function transitionDigest(proposal: unknown): string {
  return digestOfParsedProposal(parseTransitionProposal(proposal));
}

/** {@link transitionDigest} for a proposal that has already been parsed. */
export function digestOfParsedProposal(proposal: TransitionProposal): string {
  let canonical: string;
  try {
    canonical = canonicalJson(proposal);
  } catch (error) {
    throw new MemoryTransitionProposalError(
      `it has no canonical form: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return `sha256:${sha256HexSync(canonical)}`;
}
