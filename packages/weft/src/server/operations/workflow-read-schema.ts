import { z } from 'zod';

const workflowStatus = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'timed-out',
  'suspended',
]);
const failureCategory = z.enum(['application', 'timeout', 'cancellation', 'resource', 'system']);
const failedStep = z.object({ index: z.number(), label: z.string() }).passthrough();
const versionTuple = z
  .object({
    workflowVersion: z.string(),
    agentVersion: z.string().optional(),
    toolVersions: z.array(z.string()).optional(),
  })
  .passthrough();
const workerBinding = z
  .object({
    workflowId: z.string(),
    workflowType: z.string(),
    deploymentName: z.string(),
    buildId: z.string(),
    artifactDigest: z.string(),
    manifestDigest: z.string(),
    routingGeneration: z.number(),
    workflowRevision: z.string(),
    workflowContractHash: z.string(),
    activityContracts: z.record(z.string(), z.string()),
    activityName: z.string(),
    activityContractHash: z.string(),
    boundAt: z.number(),
    checkpointId: z.string(),
  })
  .passthrough();
const compatibility = z
  .object({
    deploymentName: z.string(),
    buildId: z.string(),
    artifactDigest: z.string(),
    manifestDigest: z.string(),
    workflowRevision: z.string(),
    activityContractHash: z.string(),
  })
  .passthrough();

/** The state returned by the workflow detail read. User input and results stay opaque. */
export const workflowStateSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    status: workflowStatus,
    tags: z.array(z.string()).optional(),
    input: z.unknown(),
    result: z.unknown().optional(),
    error: z.string().optional(),
    errorStack: z.string().optional(),
    failureCategory: failureCategory.nullable().optional(),
    errorCode: z.string().optional(),
    upstreamFailure: z
      .object({ source: z.enum(['github', 'other']), status: z.number().int().min(400).max(599) })
      .strict()
      .optional(),
    failedStep: failedStep.optional(),
    terminationReason: z
      .enum(['history-circuit-breaker', 'prepared-workflow-abandoned'])
      .optional(),
    versionTuple,
    revision: z.string().optional(),
    workflowExecutionToken: z.string().optional(),
    executionStateOwnerId: z.string().optional(),
    parentWorkflowId: z.string().optional(),
    parentWorkflowExecutionToken: z.string().optional(),
    createdAt: z.number(),
    startedAt: z.number().optional(),
    updatedAt: z.number(),
    terminalCleanupToken: z.string().optional(),
    terminalCommittedBy: z.string().optional(),
    executionDeadline: z.number().optional(),
    waitingForSignals: z.array(z.string()).readonly().optional(),
    forkedFrom: z
      .object({
        workflowId: z.string(),
        step: z.number(),
        workflowExecutionToken: z.string().optional(),
      })
      .passthrough()
      .optional(),
    restartedFrom: z
      .object({
        workflowId: z.string(),
        workflowExecutionToken: z.string().optional(),
        replacedAt: z.number(),
      })
      .passthrough()
      .optional(),
    workerBinding: z
      .object({ current: workerBinding, history: z.array(workerBinding) })
      .passthrough()
      .optional(),
    workerVersioningPolicy: z
      .union([
        z
          .object({
            mode: z.literal('pinned').optional(),
            maxBindingHistory: z.number().optional(),
          })
          .passthrough(),
        z
          .object({
            mode: z.literal('auto-upgrade'),
            compatibility,
            maxBindingHistory: z.number().optional(),
          })
          .passthrough(),
      ])
      .optional(),
  })
  .passthrough();

/** The paged workflow list returns summaries, not the user's input or result. */
export const workflowSummarySchema = z
  .object({
    id: z.string(),
    type: z.string(),
    status: workflowStatus,
    tags: z.array(z.string()).optional(),
    version: z.string(),
    revision: z.string().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    executionDeadline: z.number().optional(),
    failureCategory: failureCategory.optional(),
    failedStep: failedStep.optional(),
    retrying: z.object({ activity: z.string(), attempt: z.number() }).passthrough().optional(),
  })
  .passthrough();
