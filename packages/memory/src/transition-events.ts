import { z } from 'zod';

import { revisionSchema } from './evidence-projection-schema';
import { digestSchema, epochMilliseconds, nonEmpty } from './evidence-schema-primitives';
import { MEMORY_PRINCIPAL_KINDS } from './governance/authority';
import { TRANSITION_PROPOSAL_KINDS } from './transition-proposal';

export const TRANSITION_EVENT_KINDS = [
  'requested',
  'validation-started',
  'rejected',
  'conflicted',
  'committed',
  'superseded',
  'canceled',
  'recovery-reconciled',
  'failed',
] as const;
export type TransitionEventKind = (typeof TRANSITION_EVENT_KINDS)[number];

/** A redacted reference: ids and digests, never content. */
const sourceReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('evidence'), id: nonEmpty, digest: digestSchema }).strict(),
  z
    .object({
      kind: z.literal('projection'),
      namespace: nonEmpty,
      id: nonEmpty,
      revision: revisionSchema,
    })
    .strict(),
]);
export type TransitionSourceReference = z.infer<typeof sourceReferenceSchema>;

const eventBase = {
  /** The causal identifier: the proposal's operation id. Every event carries it. */
  operationId: nonEmpty,
  tenantId: nonEmpty,
  proposalKind: z.enum(TRANSITION_PROPOSAL_KINDS),
  principal: z.object({ kind: z.enum(MEMORY_PRINCIPAL_KINDS), id: nonEmpty }).strict(),
  ownerId: nonEmpty,
  at: epochMilliseconds,
};

/**
 * The lifecycle events of one transition. The schema is strict on purpose: the
 * test that no event carries source content parses every event with it, so an
 * extra key fails the test instead of passing an inspection. Events are not
 * persisted and never reach the fleet event feed; this is a contract for the
 * emitters that consume them, not a storage format.
 */
export const transitionEventSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...eventBase,
      kind: z.literal('requested'),
      digest: digestSchema,
      sources: z.array(sourceReferenceSchema),
    })
    .strict(),
  z.object({ ...eventBase, kind: z.literal('validation-started') }).strict(),
  z
    .object({ ...eventBase, kind: z.literal('rejected'), reason: nonEmpty, detail: z.string() })
    .strict(),
  z
    .object({ ...eventBase, kind: z.literal('conflicted'), reason: nonEmpty, detail: z.string() })
    .strict(),
  z
    .object({
      ...eventBase,
      kind: z.literal('committed'),
      evidence: z.array(sourceReferenceSchema),
      projections: z.array(sourceReferenceSchema),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      kind: z.literal('superseded'),
      subject: sourceReferenceSchema,
      successor: sourceReferenceSchema,
    })
    .strict(),
  z.object({ ...eventBase, kind: z.literal('canceled') }).strict(),
  z.object({ ...eventBase, kind: z.literal('recovery-reconciled'), digest: digestSchema }).strict(),
  z
    .object({
      ...eventBase,
      kind: z.literal('failed'),
      error: z.object({ name: nonEmpty, code: z.string().optional() }).strict(),
    })
    .strict(),
]);

export type TransitionEvent = z.infer<typeof transitionEventSchema>;

/**
 * Receives each event, in order. The engine awaits it and never lets it change
 * an outcome: a sink that throws is ignored. Delivery is at most once per
 * attempt.
 */
export type TransitionEventSink = (event: TransitionEvent) => void | Promise<void>;
