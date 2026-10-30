/**
 * `bureau.tasks.inspect`: one task as the run inspector shows it (COR-910), a versioned,
 * plain-data snapshot of what `bureau.tasks.get` leaves out: the run's liveness, the children it owns,
 * and the progress evidence behind them.
 *
 * It reads the same task, under the same ownership rule, as `bureau.tasks.get`. It carries no
 * transcript, prompt, tool argument, result payload, or checkpoint: the answer is on the task's
 * event stream, and everything else stays with the operations that already guard it.
 *
 * @module tasks-inspect-operation
 */

import { defineOperation } from '@lostgradient/weft';
import { z } from 'zod';

import type { BureauTasks } from '../../types.ts';
import { mayAccessTask, type BureauTasksOperationHost } from './tasks-operations.ts';
import {
  resourceNotFound,
  taskViewSchema,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';

/** The version `bureau.tasks.inspect` stamps on its snapshot. */
export const TASK_INSPECTION_SCHEMA_VERSION = 'bureau.task-inspection.v1';

/** The fields of a run's liveness snapshot the inspector may see; the rest stays server side. */
export type InspectedLiveness = {
  readonly id: string;
  readonly status: string;
  readonly assessment: string;
  readonly reachability: string;
  readonly progress: string;
  readonly revision: number;
  readonly attempt: number;
  readonly startedAt: string;
  readonly lastTransitionAt: string;
  readonly ownership: string;
  readonly durability: string;
  readonly cancellable: boolean;
  readonly observedAt: number;
  readonly lastActivityAt?: number | undefined;
  readonly lastHeartbeatAt?: number | undefined;
  readonly lastProgressAt?: number | undefined;
  readonly missedPulseCount: number;
  readonly worstChildAssessment?: string | undefined;
  readonly declaredWait?:
    | {
        readonly reason: string;
        readonly startedAt: number;
        readonly owner?: string | undefined;
        readonly deadline?: number | undefined;
        readonly wakeCondition: string;
      }
    | undefined;
  readonly semanticProgress?:
    | {
        readonly phase?: string | undefined;
        readonly current?: number | undefined;
        readonly total?: number | undefined;
        readonly unit?: string | undefined;
        readonly message?: string | undefined;
      }
    | undefined;
  readonly evidence: readonly { readonly source: string; readonly at: number }[];
};

/**
 * What the inspection reads beyond the task registry: {@link BureauTasks.inspect}, which this
 * operation delegates to once the caller may read the task.
 */
export type BureauTasksInspectOperationHost = BureauTasksOperationHost & {
  readonly inspect: BureauTasks['inspect'];
};

const finite = z.number();
const livenessSchema = z.object({
  id: z.string(),
  status: z.string(),
  assessment: z.string(),
  reachability: z.string(),
  progress: z.string(),
  revision: z.number().int(),
  attempt: z.number().int(),
  startedAt: z.string(),
  lastTransitionAt: z.string(),
  ownership: z.string(),
  durability: z.string(),
  cancellable: z.boolean(),
  observedAt: finite,
  lastActivityAt: finite.optional(),
  lastHeartbeatAt: finite.optional(),
  lastProgressAt: finite.optional(),
  missedPulseCount: z.number().int(),
  worstChildAssessment: z.string().optional(),
  declaredWait: z
    .object({
      reason: z.string(),
      startedAt: finite,
      owner: z.string().optional(),
      deadline: finite.optional(),
      wakeCondition: z.string(),
    })
    .optional(),
  semanticProgress: z
    .object({
      phase: z.string().optional(),
      current: finite.optional(),
      total: finite.optional(),
      unit: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
  evidence: z.array(z.object({ source: z.string(), at: finite })),
});

const inspectInput = z.object({
  taskId: z.string().min(1).describe('The identifier of the task to inspect.'),
  step: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Only this step’s reply details in `steps`. Omitted, `steps` lists the newest 50 steps of the run.',
    ),
});

const planReasonSchema = z.object({
  /** Why the model was chosen. */
  code: z.enum(['cost', 'latency', 'capability', 'policy', 'pinned', 'fallback']),
  /** One line that says it in words. */
  detail: z.string(),
  /** The models the plan passed over, each with the code that passed it over. */
  rejected: z.array(
    z.object({
      provider: z.string(),
      model: z.string(),
      code: z.enum(['capability', 'policy', 'fallback']),
    }),
  ),
});

const effectiveContextSchema = z.object({
  /** Absent for a run that seals no epochs. */
  epochId: z.string().optional(),
  supersedes: z.string().optional(),
  baselineDigest: z.string(),
  sources: z.array(
    z.object({
      sourceId: z.string(),
      trust: z.string(),
      disposition: z.enum(['included', 'excluded', 'absent-by-composition']),
      reason: z.string().optional(),
      revision: z.union([z.number(), z.string()]).optional(),
      digest: z.string().optional(),
    }),
  ),
  /** The conversation’s messages as an id, a role and a digest of the content; never the content. */
  messages: z.array(z.object({ id: z.string(), role: z.string(), digest: z.string() })),
  messageCount: z.number().int(),
  /** Whether older messages were left out to keep the record within 256 KiB. */
  truncated: z.boolean(),
});

const stepSchema = z.object({
  step: z.number().int(),
  messageId: z.string().nullable(),
  contextEpochId: z.string().nullable(),
  /** `null` for a step recorded without a model plan or steering override. */
  planReason: planReasonSchema.nullable(),
  /** Whether the step kept an effective context; read it by passing `step`. */
  hasEffectiveContext: z.boolean(),
  /** `null` unless the call names one `step` that kept an effective context. */
  effectiveContext: effectiveContextSchema.nullable(),
});
const inspectOutput = z.object({
  schemaVersion: z.literal(TASK_INSPECTION_SCHEMA_VERSION),
  taskId: z.string(),
  /** Whether the caller may cancel the task: `bureau.tasks.cancel` would not refuse it. */
  canCancel: z.boolean(),
  task: taskViewSchema,
  /** `null` when this process holds no live run for the task, as after a restart. */
  liveness: livenessSchema.nullable(),
  children: z.array(
    z.object({
      runId: z.string(),
      agentName: z.string(),
      status: z.string(),
      parentCancellation: z.string(),
      revision: z.number().int(),
      assessment: z.string().nullable(),
    }),
  ),
  /** The reply details of the run’s steps, oldest first: why each ran on its model and what it saw. */
  steps: z.array(stepSchema),
});

export const tasksInspectOperation = defineOperation<
  typeof inspectInput,
  typeof inspectOutput,
  BureauTasksInspectOperationHost
>({
  name: 'bureau.tasks.inspect',
  mcpExposable: true,
  summary: 'Inspect one task',
  description:
    'Returns a versioned snapshot of one of the caller’s own tasks for the run inspector: the task, its liveness (status, assessment, reachability, progress, the declared wait and its reason, semantic progress, and the evidence entries by source and time), and the children it owns with each one’s assessment. `liveness` is `null` when this process holds no live run for the task. Transport heartbeat evidence is reported as its own source and is never semantic progress. `steps` carries each step’s reply details: `planReason` (why it ran on its model: a code, one line, and the models passed over) and `effectiveContext` (what the model saw, as source digests and message ids, never message content; capped at 256 KiB, newest messages kept, `truncated` when older ones were left out), each `null` for a step recorded without one. `effectiveContext` is returned only when `step` names one step, because a record runs to 256 KiB and this snapshot is polled; the list form carries `hasEffectiveContext` in its place. A run that seals no context epochs records an `effectiveContext` with no `epochId`. The snapshot carries no transcript, prompt, tool argument, result, or checkpoint: read the answer and any gap on `bureau.tasks.events`, and cancel with `bureau.tasks.cancel`. A caller holding `bureau.tasks:read` inspects any owner’s; another owner’s task answers as a missing one does.',
  destructive: false,
  tags: ['Tasks'],
  inputSchema: inspectInput,
  outputSchema: inspectOutput,
  producibleFaults: ['InvalidParams', 'NotFound'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    if (!(await mayAccessTask(host, principal, input.taskId, 'bureau.tasks:read'))) {
      throw resourceNotFound('task', input.taskId);
    }
    const inspection = await host.inspect(
      input.taskId,
      input.step === undefined ? undefined : { step: input.step },
    );
    if (inspection === undefined) throw resourceNotFound('task', input.taskId);
    const { task } = inspection;
    return {
      schemaVersion: TASK_INSPECTION_SCHEMA_VERSION,
      taskId: input.taskId,
      canCancel: await mayAccessTask(host, principal, input.taskId, 'bureau.tasks:write'),
      task: { ...task, openWaits: [...task.openWaits] },
      liveness: projectLiveness(inspection.liveness),
      children: inspection.children.map((child) => ({
        runId: child.childRunId,
        agentName: child.childAgentName,
        status: child.status,
        parentCancellation: child.parentCancellation,
        revision: child.revision,
        assessment: child.liveness?.assessment ?? null,
      })),
      steps: inspection.steps.map((entry) => ({
        step: entry.step,
        messageId: entry.messageId,
        contextEpochId: entry.contextEpochId,
        planReason: entry.planReason && {
          code: entry.planReason.code,
          detail: entry.planReason.detail,
          rejected: entry.planReason.rejected.map((rejection) => ({
            provider: rejection.provider,
            model: rejection.model,
            code: rejection.code,
          })),
        },
        hasEffectiveContext: entry.hasEffectiveContext,
        effectiveContext: entry.effectiveContext && {
          ...entry.effectiveContext,
          sources: entry.effectiveContext.sources.map((source) => ({ ...source })),
          messages: entry.effectiveContext.messages.map((message) => ({ ...message })),
        },
      })),
    };
  },
});

/** Copy exactly the inspector's fields: a snapshot grows fields over time, and none leaks by default. */
function projectLiveness(
  source: InspectedLiveness | undefined,
): z.infer<typeof livenessSchema> | null {
  if (source === undefined) return null;
  const wait = source.declaredWait;
  const progress = source.semanticProgress;
  return {
    id: source.id,
    status: source.status,
    assessment: source.assessment,
    reachability: source.reachability,
    progress: source.progress,
    revision: source.revision,
    attempt: source.attempt,
    startedAt: source.startedAt,
    lastTransitionAt: source.lastTransitionAt,
    ownership: source.ownership,
    durability: source.durability,
    cancellable: source.cancellable,
    observedAt: source.observedAt,
    ...(source.lastActivityAt === undefined ? {} : { lastActivityAt: source.lastActivityAt }),
    ...(source.lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: source.lastHeartbeatAt }),
    ...(source.lastProgressAt === undefined ? {} : { lastProgressAt: source.lastProgressAt }),
    missedPulseCount: source.missedPulseCount,
    ...(source.worstChildAssessment === undefined
      ? {}
      : { worstChildAssessment: source.worstChildAssessment }),
    ...(wait === undefined
      ? {}
      : {
          declaredWait: {
            reason: wait.reason,
            startedAt: wait.startedAt,
            ...(wait.owner === undefined ? {} : { owner: wait.owner }),
            ...(wait.deadline === undefined ? {} : { deadline: wait.deadline }),
            wakeCondition: wait.wakeCondition,
          },
        }),
    ...(progress === undefined
      ? {}
      : {
          semanticProgress: {
            ...(progress.phase === undefined ? {} : { phase: progress.phase }),
            ...(progress.current === undefined ? {} : { current: progress.current }),
            ...(progress.total === undefined ? {} : { total: progress.total }),
            ...(progress.unit === undefined ? {} : { unit: progress.unit }),
            ...(progress.message === undefined ? {} : { message: progress.message }),
          },
        }),
    evidence: source.evidence.map((entry) => ({ source: entry.source, at: entry.at })),
  };
}
