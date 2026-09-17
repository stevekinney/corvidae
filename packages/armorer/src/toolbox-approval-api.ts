import type { RuntimeServices } from '@repo/lifecycle';
import type {
  ApprovalStateStore,
  GrantStateStore,
  ReusableApprovalGrant,
} from './approval-binding';
import type { ToolError } from './core/errors';
import type { Tool } from './is-tool';
import {
  issueGrant,
  listGrants,
  restoreApproval,
  revokeApproval,
  revokeGrant,
} from './toolbox-approval';
import type { GrantListFilter, ReusableApprovalGrantInput } from './toolbox-approval-contracts';
import { resumeApproval as resumeApprovalOwner } from './toolbox-approval-resume';
import {
  createInterruptedResumeApprovalValidationResult,
  validateResumedApprovalArguments,
} from './toolbox-approval-validation';
import type { ToolboxExecuteOptions } from './toolbox-contracts';
import type { Toolbox } from './toolbox-interface';
import type { SignedPendingToolApproval, ToolCallInput, ToolExecutionResult } from './types';

type ToolboxExecuteReceiver = {
  execute: (call: ToolCallInput, options?: ToolboxExecuteOptions) => Promise<ToolExecutionResult>;
};

export type ToolboxApprovalApi = Omit<
  Pick<
    Toolbox,
    | 'resumeApproval'
    | 'restoreApproval'
    | 'revokeApproval'
    | 'issueGrant'
    | 'revokeGrant'
    | 'listGrants'
  >,
  'resumeApproval'
> & {
  resumeApproval(
    this: ToolboxExecuteReceiver,
    approval: SignedPendingToolApproval,
    options?: ToolboxExecuteOptions & { arguments?: unknown },
  ): Promise<ToolExecutionResult>;
};

type ToolboxApprovalContext = {
  approvalSecret: string | undefined;
  approvalStateStore: ApprovalStateStore | undefined;
  grantStateStore: GrantStateStore | undefined;
  approvalNow: () => number;
  approvalNonce: () => string;
  toolboxRevision: string;
  policyRevision: string;
  approvalRevision: string;
  runtime: RuntimeServices;
  getTool: (name: string) => Tool | undefined;
  execute: (call: ToolCallInput, options?: ToolboxExecuteOptions) => Promise<ToolExecutionResult>;
  createToolError: (
    category: ToolError['category'],
    message: string,
    code: string,
    retryable: boolean,
  ) => ToolError;
};

export function createToolboxApprovalApi(context: ToolboxApprovalContext): ToolboxApprovalApi {
  async function resumeApproval(
    receiver: ToolboxExecuteReceiver | undefined,
    approval: SignedPendingToolApproval,
    resumeOptions?: ToolboxExecuteOptions & { arguments?: unknown },
  ): Promise<ToolExecutionResult> {
    return resumeApprovalOwner(approval, resumeOptions, {
      approvalSecret: context.approvalSecret,
      approvalStateStore: context.approvalStateStore,
      approvalNow: context.approvalNow,
      toolboxRevision: context.toolboxRevision,
      policyRevision: context.policyRevision,
      approvalRevision: context.approvalRevision,
      runtime: context.runtime,
      getTool: context.getTool,
      execute: (call, executeOptions) =>
        receiver && typeof receiver.execute === 'function'
          ? receiver.execute(call, executeOptions)
          : context.execute(call, executeOptions),
      validateArguments: (pendingApproval, validation, validationOptions, validationRuntime) =>
        validateResumedApprovalArguments(
          pendingApproval,
          validation,
          validationOptions,
          validationRuntime,
          createInterruptedResumeApprovalValidationResult,
        ),
      interruptedResult: createInterruptedResumeApprovalValidationResult,
      createToolError: context.createToolError,
    });
  }

  return {
    resumeApproval(approval, options) {
      return resumeApproval(this, approval, options);
    },
    restoreApproval: (approval) =>
      restoreApproval(approval, {
        approvalStateStore: context.approvalStateStore,
        approvalSecret: context.approvalSecret,
        approvalNow: context.approvalNow,
        toolboxRevision: context.toolboxRevision,
        policyRevision: context.policyRevision,
        approvalRevision: context.approvalRevision,
        getTool: context.getTool,
      }),
    revokeApproval: (approval) =>
      revokeApproval(approval, {
        approvalStateStore: context.approvalStateStore,
        approvalSecret: context.approvalSecret,
        approvalNow: context.approvalNow,
        toolboxRevision: context.toolboxRevision,
        policyRevision: context.policyRevision,
        approvalRevision: context.approvalRevision,
        getTool: context.getTool,
      }),
    issueGrant: (input: ReusableApprovalGrantInput): Promise<ReusableApprovalGrant> =>
      issueGrant(input, {
        approvalSecret: context.approvalSecret,
        grantStateStore: context.grantStateStore,
        approvalNonce: context.approvalNonce,
        approvalNow: context.approvalNow,
        policyRevision: context.policyRevision,
      }),
    revokeGrant: (id: string) => revokeGrant(id, context.grantStateStore),
    listGrants: (filter?: GrantListFilter) => listGrants(filter, context.grantStateStore),
  };
}
