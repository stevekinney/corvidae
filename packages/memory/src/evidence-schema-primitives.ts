import { z } from 'zod';

import { MEMORY_PRINCIPAL_KINDS } from './governance/authority';

/**
 * Field schemas shared by the evidence record and the projection record. Both
 * persisted shapes spell a non-empty string, an epoch-millisecond instant, a
 * `sha256:<hex>` digest, and a producer the same way, so they are written once.
 */

export const nonEmpty = z.string().min(1);

/** Epoch milliseconds, the convention `MemoryRecord` already uses. */
export const epochMilliseconds = z.number().int().nonnegative();

/** `sha256:` plus 64 lowercase hex characters, Bureau's managed-asset digest convention. */
export const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const principalSchema = z
  .object({ kind: z.enum(MEMORY_PRINCIPAL_KINDS), id: nonEmpty })
  .strict();

/**
 * Who or what produced a piece of content: an extractor, a model, a tool, or a
 * person. `version` is the producer's own version string.
 */
export const producerSchema = z
  .object({ kind: z.enum(MEMORY_PRINCIPAL_KINDS), id: nonEmpty, version: nonEmpty.optional() })
  .strict();

export type EvidenceProducer = z.infer<typeof producerSchema>;
