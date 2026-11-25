import type { StepRecord } from '@lostgradient/operative';
import type { TaskRecord } from './task-registry';
import type { PendingToolApprovalReview, ReviewPolicy } from './bureau-types/reviews';
import type { ReviewedToolProvenance } from './task-origin';
import { isTaskOrigin } from './task-origin';

export type ReviewedProvenanceState = 'ordinary' | 'verified' | 'unresolved';

function markerOf(value: unknown): ReviewedToolProvenance | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const marker = value as Record<string, unknown>;
  if (
    typeof marker['agent'] !== 'string' ||
    !marker['agent'].startsWith('reviewed:') ||
    typeof marker['tool'] !== 'string' ||
    !marker['tool'] ||
    marker['step'] !== 0 ||
    marker['result'] !== 0 ||
    marker['callId'] !== 'reviewed-call'
  )
    return undefined;
  return marker as unknown as ReviewedToolProvenance;
}

/** Classify from durable provenance; every missing or malformed prerequisite fails closed. */
export async function reviewedProvenanceOf(
  review: PendingToolApprovalReview,
  dependencies: {
    readonly task: (runId: string) => Promise<TaskRecord | undefined>;
    readonly steps: (runId: string) => Promise<readonly StepRecord[]>;
    readonly session?: (
      sessionId: string,
    ) => Promise<{ metadata: Record<string, unknown> } | undefined>;
    readonly policy?: ReviewPolicy | undefined;
  },
): Promise<ReviewedProvenanceState> {
  try {
    const task = await dependencies.task(review.runId);
    const session =
      dependencies.session && review.sessionId
        ? await dependencies.session(review.sessionId)
        : undefined;
    const sessionMarkers = session?.metadata['reviewedApprovalProvenance'];
    if (
      sessionMarkers !== undefined &&
      (!sessionMarkers || typeof sessionMarkers !== 'object' || Array.isArray(sessionMarkers))
    )
      return 'unresolved';
    const sessionOrigin =
      sessionMarkers && Object.hasOwn(sessionMarkers, review.id)
        ? Object.entries(sessionMarkers).find(([key]) => key === review.id)?.[1]
        : undefined;
    const markedRun =
      sessionMarkers &&
      Object.keys(sessionMarkers).some((id) => id.startsWith(`approval:${review.runId}:`));
    if (!task) return session && !markedRun ? 'ordinary' : 'unresolved';
    if (typeof task.agentName !== 'string') {
      if (!session || markedRun) return 'unresolved';
      if (task.origin && Object.hasOwn(task.origin, 'reviewedTool')) return 'unresolved';
      return task.origin && !isTaskOrigin(task.origin) ? 'unresolved' : 'ordinary';
    }
    if (markedRun && sessionOrigin === undefined) return 'unresolved';
    if (
      sessionOrigin !== undefined &&
      JSON.stringify(sessionOrigin) !== JSON.stringify(task.origin)
    )
      return 'unresolved';
    if (!task.origin) return task.agentName.startsWith('reviewed:') ? 'unresolved' : 'ordinary';
    if (!isTaskOrigin(task.origin)) return 'unresolved';
    const origin = task.origin as unknown as Record<string, unknown>;
    if (!Object.hasOwn(origin, 'reviewedTool'))
      return task.agentName?.startsWith('reviewed:') ? 'unresolved' : 'ordinary';
    if (dependencies.session && (!session || sessionOrigin === undefined)) return 'unresolved';
    const marker = markerOf(origin['reviewedTool']);
    if (
      !marker ||
      task.agentName !== marker.agent ||
      review.approval.callId !== marker.callId ||
      review.runId !== task.taskId ||
      dependencies.policy?.verifyReviewed === undefined
    )
      return 'unresolved';
    const steps = await dependencies.steps(review.runId);
    const step = steps.find((entry) => entry.step === marker.step);
    const result = step?.results[marker.result];
    const call = step?.toolCalls[marker.result];
    if (
      !result ||
      result.outcome !== 'action_required' ||
      !result.pendingApproval ||
      !call ||
      call.id !== marker.callId ||
      call.toolId !== marker.tool ||
      result.pendingApproval.callId !== marker.callId
    )
      return 'unresolved';
    return dependencies.policy.verifyReviewed(review, result.pendingApproval, marker)
      ? 'verified'
      : 'unresolved';
  } catch {
    return 'unresolved';
  }
}
