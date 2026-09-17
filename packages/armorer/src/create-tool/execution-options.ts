import type { ExecutionHandle } from '../execution-lifecycle';
import type { ApprovalAdmissionRollback, ApprovalResumeState } from '../internal/approval-resume';
import {
  approvalConsumeSymbol,
  approvalResumeSymbol,
  executionCallbackStartSymbol,
  policyAuthorizationOnlySymbol,
} from '../internal/approval-resume';
import type { MinimalAbortSignal, ToolExecuteOptions } from '../is-tool';

export type InternalToolExecuteOptions = ToolExecuteOptions & {
  [approvalConsumeSymbol]?: () => Promise<ApprovalAdmissionRollback>;
  [approvalResumeSymbol]?: ApprovalResumeState;
  [policyAuthorizationOnlySymbol]?: boolean;
  executionHandle?: ExecutionHandle;
  privilegedContextMirrorHandle?: ExecutionHandle;
  parentCompletionHandle?: ExecutionHandle;
  /**
   * Reports whether the tool's own callback is still in flight behind
   * `parentCompletionHandle`. The owner of that handle must not settle it while
   * this reports `true`: the callback may ignore cancellation and keep running
   * long after the raced execution promise has already rejected.
   */
  onParentCompletionPending?: (pending: boolean) => void;
  [executionCallbackStartSymbol]?: () => void;
};

export function resolveSuppliedOwnerId(options: ToolExecuteOptions): string | undefined {
  return options.ownerId ?? options.requestContext?.authority.ownerId;
}

export function isAbortSignalLike(signal: MinimalAbortSignal | undefined): signal is AbortSignal {
  return (
    signal !== undefined &&
    typeof signal === 'object' &&
    typeof signal.aborted === 'boolean' &&
    typeof signal.addEventListener === 'function'
  );
}
