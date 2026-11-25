import { z } from 'zod';

/** The schedule summary returned by both schedule reads. */
export const scheduleSummarySchema = z
  .object({
    id: z.string(),
    workflowType: z.string(),
    description: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    cronExpression: z.string().optional(),
    intervalMs: z.number().optional(),
    status: z.enum(['active', 'paused', 'cancelled']),
    overlap: z.enum(['skip', 'queue', 'cancel-running', 'allow']),
    backfill: z.boolean(),
    jitterMs: z.number().optional(),
    timeZone: z.string(),
    revisionPolicy: z.enum(['active-at-fire', 'pinned']),
    pinnedRevision: z.string().optional(),
    revision: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
    lastFireAt: z.number().optional(),
    lastMissedFireAt: z.number().optional(),
    missedFireCount: z.number(),
    skippedCount: z.number(),
    lastSkippedAt: z.number().optional(),
    nextFireAt: z.number().nullable(),
    skippedOccurrences: z.array(z.number()).optional(),
    currentWorkflowId: z.string().optional(),
    queuedRuns: z.array(
      z
        .object({
          workflowId: z.string(),
          queuedAt: z.number(),
          occurrence: z.number().optional(),
          manual: z.literal(true).optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
