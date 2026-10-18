import { sha256HexSync } from '@lostgradient/cryptography';
import { z } from 'zod';

import {
  digestSchema,
  epochMilliseconds,
  nonEmpty,
  principalSchema,
  producerSchema,
} from './evidence-schema-primitives';
import type { MemoryRetentionRule, MemorySourceKind } from './governance/policy';
import { MEMORY_TRUST_LEVELS } from './governance/policy';

export const EVIDENCE_SCHEMA_VERSION = 1;

/** `MEMORY_SOURCE_KINDS` without `derived`: derived content is a projection, never evidence. */
export const EVIDENCE_KINDS = [
  'conversation',
  'model-tool',
  'tool-result',
  'ingested-document',
  'operator',
  'system',
] as const satisfies readonly MemorySourceKind[];

export const MEMORY_CLASSIFICATIONS = ['public', 'internal', 'confidential', 'restricted'] as const;

/**
 * Why a stored or incoming record was refused. These are the five rejection
 * classes of the evidence contract.
 */
export type MemoryEvidenceRejectionCode =
  'malformed' | 'unsupported-revision' | 'source-less' | 'cross-tenant' | 'digest-mismatch';

/** A record failed validation before it could reach an index or retrieval. */
export class MemoryEvidenceValidationError extends Error {
  readonly code: MemoryEvidenceRejectionCode;
  readonly record: 'evidence' | 'projection' | 'receipt';

  constructor(
    code: MemoryEvidenceRejectionCode,
    record: 'evidence' | 'projection' | 'receipt',
    message: string,
  ) {
    super(message);
    this.name = 'MemoryEvidenceValidationError';
    this.code = code;
    this.record = record;
  }
}

const retentionRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('run-lifetime') }).strict(),
  z.object({ kind: z.literal('duration'), milliseconds: z.number().positive() }).strict(),
  z
    .object({ kind: z.literal('until-superseded'), supersededMilliseconds: z.number().positive() })
    .strict(),
  z.object({ kind: z.literal('subject-deletable') }).strict(),
  z.object({ kind: z.literal('source-linked') }).strict(),
]) satisfies z.ZodType<MemoryRetentionRule>;

/**
 * The evidence record's fields, exported so the transition proposal can be
 * composed from them (everything except the fields the engine stamps) instead
 * of retyping them.
 */
export const evidenceRecordShape = {
  schemaVersion: z.literal(EVIDENCE_SCHEMA_VERSION),
  id: nonEmpty,
  tenantId: nonEmpty,
  ownerId: nonEmpty,
  kind: z.enum(EVIDENCE_KINDS),
  sourceLocator: nonEmpty,
  content: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('inline'), text: nonEmpty }).strict(),
    z
      .object({
        kind: z.literal('managed-asset'),
        assetId: nonEmpty,
        revision: z.number().int().positive().optional(),
      })
      .strict(),
  ]),
  digest: digestSchema,
  producer: producerSchema,
  principal: principalSchema,
  trustTier: z.enum(MEMORY_TRUST_LEVELS),
  eventAt: epochMilliseconds,
  observedAt: epochMilliseconds,
  writtenAt: epochMilliseconds,
  classification: z.enum(MEMORY_CLASSIFICATIONS),
  authorizationScope: z
    .object({ visibility: z.enum(['private', 'shared']), sharedWith: z.array(nonEmpty) })
    .strict(),
  retention: retentionRuleSchema,
  causation: z
    .object({
      runId: nonEmpty.optional(),
      sessionId: nonEmpty.optional(),
      toolCallId: nonEmpty.optional(),
      externalCommandId: nonEmpty.optional(),
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0, 'causation needs at least one identifier')
    .optional(),
  supersedes: z.array(nonEmpty).min(1).optional(),
} satisfies z.ZodRawShape;

/** `supersedes` names distinct ids other than the record itself. */
export function hasValidSupersedes(record: {
  readonly id: string;
  readonly supersedes?: readonly string[] | undefined;
}): boolean {
  return (
    record.supersedes === undefined ||
    (new Set(record.supersedes).size === record.supersedes.length &&
      !record.supersedes.includes(record.id))
  );
}

export const SUPERSEDES_RULE_MESSAGE =
  'supersedes must be distinct ids other than the record itself';

export const evidenceRecordSchema = z
  .object(evidenceRecordShape)
  .strict()
  .refine(hasValidSupersedes, SUPERSEDES_RULE_MESSAGE);

export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;

export const EVIDENCE_SUPERSESSION_SCHEMA_VERSION = 1;

/**
 * The write-once back-pointer stored beside a superseded evidence record. The
 * successor's `supersedes` array is the source of truth; this marker answers
 * "is this evidence still active" without a reverse scan. `at` is the
 * successor's `writtenAt`.
 */
export const evidenceSupersessionSchema = z
  .object({
    schemaVersion: z.literal(EVIDENCE_SUPERSESSION_SCHEMA_VERSION),
    supersededBy: nonEmpty,
    at: epochMilliseconds,
  })
  .strict();

export type EvidenceSupersession = z.infer<typeof evidenceSupersessionSchema>;

/** How a decoder reads one persisted shape: its version, and which path means "no source". */
export interface RejectionClassification {
  readonly record: 'evidence' | 'projection' | 'receipt';
  readonly schemaVersion: number;
  /** The top-level key whose absence or emptiness means the record names no source. */
  readonly sourceKey: string | undefined;
}

/**
 * Parses a persisted record and classifies a refusal by the ruled order: not an
 * object, then an absent or unsupported `schemaVersion` (checked before the
 * parse, so a record from a later schema reads as "you are older than this
 * record" rather than as an unknown-key failure), then a source-less record,
 * then anything else malformed. The caller applies the tenant and digest checks
 * on the parsed value.
 */
export function parseWithRejectionCodes<Output>(
  schema: z.ZodType<Output>,
  raw: unknown,
  classification: RejectionClassification,
): Output {
  const { record } = classification;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new MemoryEvidenceValidationError('malformed', record, `The ${record} is not an object.`);
  }
  if (!('schemaVersion' in raw)) {
    throw new MemoryEvidenceValidationError(
      'malformed',
      record,
      `The ${record} has no schemaVersion.`,
    );
  }
  if (raw.schemaVersion !== classification.schemaVersion) {
    throw new MemoryEvidenceValidationError(
      'unsupported-revision',
      record,
      `The ${record} has schemaVersion ${String(raw.schemaVersion)}; only ${classification.schemaVersion} is supported.`,
    );
  }
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const sourceless =
    classification.sourceKey !== undefined &&
    result.error.issues.some(
      (issue) => issue.path.length === 1 && issue.path[0] === classification.sourceKey,
    );
  throw new MemoryEvidenceValidationError(
    sourceless ? 'source-less' : 'malformed',
    record,
    sourceless
      ? `The ${record} names no source (${classification.sourceKey}).`
      : `The ${record} is malformed: ${result.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ')}`,
  );
}

/** The digest an inline piece of content must carry. */
export function digestOfText(text: string): string {
  return `sha256:${sha256HexSync(text)}`;
}

/**
 * Validates a persisted evidence record. In order: not an object; absent or
 * unsupported `schemaVersion`; strict parse (a `sourceLocator` issue is
 * `source-less`, anything else `malformed`); a tenant other than the caller's
 * (`cross-tenant`); an inline digest that does not match its text
 * (`digest-mismatch`). A managed asset's digest is checked for format only:
 * memory cannot fetch the asset's bytes, and Bureau verified them at admission.
 */
export function decodeEvidenceRecord(raw: unknown, context: { tenantId: string }): EvidenceRecord {
  const parsed = parseWithRejectionCodes(evidenceRecordSchema, raw, {
    record: 'evidence',
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    sourceKey: 'sourceLocator',
  });
  if (parsed.tenantId !== context.tenantId) {
    throw new MemoryEvidenceValidationError(
      'cross-tenant',
      'evidence',
      `Evidence "${parsed.id}" belongs to another tenant.`,
    );
  }
  if (parsed.content.kind === 'inline' && parsed.digest !== digestOfText(parsed.content.text)) {
    throw new MemoryEvidenceValidationError(
      'digest-mismatch',
      'evidence',
      `Evidence "${parsed.id}" carries a digest that does not match its content.`,
    );
  }
  return parsed;
}

/**
 * Canonical bytes for an evidence record. Parsing first fixes key order to the
 * schema's shape order and drops absent optionals, so two callers encoding the
 * same record produce identical bytes. Never `JSON.stringify` a caller's object.
 */
export function encodeEvidenceRecord(record: EvidenceRecord): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(evidenceRecordSchema.parse(record)));
}

/** Validates a persisted supersession marker with the evidence record's rules. */
export function decodeEvidenceSupersession(raw: unknown): EvidenceSupersession {
  return parseWithRejectionCodes(evidenceSupersessionSchema, raw, {
    record: 'evidence',
    schemaVersion: EVIDENCE_SUPERSESSION_SCHEMA_VERSION,
    sourceKey: undefined,
  });
}

export function encodeEvidenceSupersession(marker: EvidenceSupersession): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(evidenceSupersessionSchema.parse(marker)));
}
