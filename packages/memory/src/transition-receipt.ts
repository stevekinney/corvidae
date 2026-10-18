import { z } from 'zod';

import {
  PROJECTION_TRANSITION_KINDS,
  projectionReferenceSchema,
  revisionSchema,
} from './evidence-projection-schema';
import {
  digestOfText,
  MemoryEvidenceValidationError,
  parseWithRejectionCodes,
} from './evidence-schema';
import { digestSchema, epochMilliseconds, nonEmpty } from './evidence-schema-primitives';
import { memoryAuthoritySchema } from './transition-authority';
import { TRANSITION_PROPOSAL_KINDS } from './transition-proposal';

export const TRANSITION_RECEIPT_SCHEMA_VERSION = 1;

/** The checks the validator ran, in the order it runs them. */
export const TRANSITION_VALIDATION_CHECKS = [
  'candidate-count',
  'authorization',
  'coverage',
  'faithfulness',
  'prior-state',
  'temporal',
  'retention',
  'type-invariants',
] as const;
export type TransitionValidationCheck = (typeof TRANSITION_VALIDATION_CHECKS)[number];

const evidenceOutcomeSchema = z
  .object({
    id: nonEmpty,
    /** The evidence record's own content digest: the value a projection's `sources` names. */
    digest: digestSchema,
    /** What the batch that carried this receipt did with the record: `duplicate` when the identical record was already stored. */
    outcome: z.enum(['appended', 'duplicate']),
    supersedes: z.array(nonEmpty).min(1).optional(),
  })
  .strict();

const projectionOutcomeSchema = z
  .object({
    namespace: nonEmpty,
    id: nonEmpty,
    revision: revisionSchema,
    /** `sha256:` over the canonical bytes of the stored revision. */
    recordDigest: digestSchema,
    transition: z.enum(PROJECTION_TRANSITION_KINDS),
    /** What the batch that carried this receipt did with the revision; never a prediction. */
    outcome: z.enum(['written', 'duplicate']),
    supersedes: z.array(projectionReferenceSchema).min(1).optional(),
    supersededBy: projectionReferenceSchema.optional(),
    demotedBy: projectionReferenceSchema.optional(),
  })
  .strict();

const consolidationSchema = z
  .object({
    candidates: z
      .array(
        z.object({ id: nonEmpty, revision: revisionSchema, recordDigest: digestSchema }).strict(),
      )
      .min(2),
    outcome: z.enum(['supersede', 'demote']),
    projectorRevision: nonEmpty,
    promptRevision: nonEmpty,
    summary: z
      .object({
        id: nonEmpty,
        revision: z.literal(1),
        recordDigest: digestSchema,
        textDigest: digestSchema,
      })
      .strict(),
    retired: z
      .array(
        z
          .object({
            id: nonEmpty,
            revision: revisionSchema,
            transition: z.enum(['superseded', 'demoted']),
          })
          .strict(),
      )
      .min(2),
  })
  .strict();

/**
 * The durable record of one committed transition, written in the same batch as
 * the transition itself so one never exists without the other.
 *
 * It holds references and digests, never content: no evidence text, no payload,
 * no summary text. An auditor can prove which bytes it vouches for without the
 * receipt being a copy that deletion would have to chase.
 *
 * Only `committed` receipts are ever persisted. A rejected, conflicted,
 * canceled, or unknown submission writes no batch (or loses it), so there is
 * nothing to record. Widening `outcome` is additive if a later issue persists
 * refusals.
 *
 * Retention: a receipt is an audit record and the idempotency witness for its
 * operation id, so deleting one re-enables the id. It lives for at least the
 * tenant's audit-receipt retention (`auditReceiptMilliseconds`, one year at
 * minimum), measured from `committedAt`. Nothing here prunes receipts: the sweep
 * that removes expired ones is retention enforcement and belongs with the
 * governance work, which scans `t:<tenant>:r:` and reads `committedAt`.
 */
export const transitionReceiptSchema = z
  .object({
    schemaVersion: z.literal(TRANSITION_RECEIPT_SCHEMA_VERSION),
    operationId: nonEmpty,
    tenantId: nonEmpty,
    kind: z.enum(TRANSITION_PROPOSAL_KINDS),
    /** The idempotency digest of the proposal. */
    digest: digestSchema,
    authority: memoryAuthoritySchema,
    outcome: z.literal('committed'),
    /** The clock read at entry to `submit()`. */
    requestedAt: epochMilliseconds,
    /** The clock read that stamped every record the receipt vouches for. */
    committedAt: epochMilliseconds,
    validation: z
      .object({
        /** The checks that ran, in order. Every one passed. */
        checks: z.array(z.enum(TRANSITION_VALIDATION_CHECKS)),
        policyRevision: nonEmpty,
      })
      .strict(),
    evidence: z.array(evidenceOutcomeSchema),
    projections: z.array(projectionOutcomeSchema),
    consolidation: consolidationSchema.optional(),
  })
  .strict()
  .refine(
    (receipt) => (receipt.kind === 'consolidate') === (receipt.consolidation !== undefined),
    'only a consolidate receipt carries a consolidation record',
  )
  .refine(
    (receipt) =>
      receipt.authority.tenantId === receipt.tenantId &&
      receipt.validation.policyRevision === receipt.authority.policyRevision,
    'the authority and the validation policy agree with the receipt',
  );

export type TransitionReceipt = z.infer<typeof transitionReceiptSchema>;

/** Canonical bytes for a receipt: parse first, then stringify, as the other records do. */
export function encodeTransitionReceipt(receipt: TransitionReceipt): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(transitionReceiptSchema.parse(receipt)));
}

/** Validates a persisted receipt. A receipt of another tenant is `cross-tenant`. */
export function decodeTransitionReceipt(
  raw: unknown,
  context: { tenantId: string },
): TransitionReceipt {
  const parsed = parseWithRejectionCodes(transitionReceiptSchema, raw, {
    record: 'receipt',
    schemaVersion: TRANSITION_RECEIPT_SCHEMA_VERSION,
    sourceKey: undefined,
  });
  if (parsed.tenantId !== context.tenantId) {
    throw new MemoryEvidenceValidationError(
      'cross-tenant',
      'receipt',
      `Receipt "${parsed.operationId}" belongs to another tenant.`,
    );
  }
  return parsed;
}

/** `sha256:` over canonical bytes, the digest a receipt records for a stored revision. */
export function digestOfBytes(bytes: Uint8Array): string {
  return digestOfText(new TextDecoder().decode(bytes));
}

/**
 * Receipt key family. One sub-family, `r:`, keyed per tenant then operation id,
 * so a lookup is one `get` and another tenant's receipt is unreachable with this
 * tenant's id: the tenant is a key component.
 *
 * Disjointness: the memory prefixes all share `app:agent-bureau:memory`, then
 * continue `:v1:` (records), `-evidence`, `-projection`, `-governance`, and
 * `-transition`. After `memory-` the first letters are `e`, `p`, `g`, `t`, all
 * distinct, so none is a prefix of another. Weft's reserved prefixes that begin
 * `app` continue with a letter where these continue with `:`, and every other
 * reserved prefix differs in its first character.
 */
export const DEFAULT_TRANSITION_KEY_PREFIX = 'app:agent-bureau:memory-transition:v1:';

export interface TransitionKeys {
  readonly prefix: string;
  /** Every receipt of one tenant. */
  receiptScan(tenantId: string): string;
  receipt(tenantId: string, operationId: string): string;
  operationIdOfKey(key: string, scan: string): string;
}

/** `encodeURIComponent` is what Weft's key encoding does, so no `:` survives it; this module imports nothing from Weft. */
export function createTransitionKeys(
  prefix: string = DEFAULT_TRANSITION_KEY_PREFIX,
): TransitionKeys {
  const tenantScope = (tenantId: string): string => `${prefix}t:${encodeURIComponent(tenantId)}:`;
  return {
    prefix,
    receiptScan: (tenantId) => `${tenantScope(tenantId)}r:`,
    receipt: (tenantId, operationId) =>
      `${tenantScope(tenantId)}r:${encodeURIComponent(operationId)}`,
    operationIdOfKey: (key, scan) => decodeURIComponent(key.slice(scan.length)),
  };
}
