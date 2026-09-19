import { materializeToolResult } from '@corvidae/tool-protocol';

import { stableStringifyJson } from '../core/serialization/json';
import { policyPauseTierSymbol } from '../internal/approval-resume';
import type { ToolPolicyDecision } from '../is-tool';
import type { SatisfiedPolicyPause, ToolAction, ToolApprovalAction } from '../types';
import { computeDigest, normalizeToolContent } from './content';

export type ToolActionContext = {
  arguments: unknown;
  callId: string;
  policyVersion?: string | undefined;
  toolDefinitionRevision: string;
  toolName: string;
};

export function createToolAction(
  type: 'approval' | 'input',
  decision: ToolPolicyDecision,
  reason: string,
  context: ToolActionContext,
): ToolAction {
  if (type === 'approval') return createApprovalAction(decision, reason, context);
  const action: ToolAction = { type, message: decision.action?.message ?? reason };
  if (decision.action?.schema !== undefined)
    action.schema = normalizeToolContent(decision.action.schema);
  return action;
}

export function policyPauseMatchesSatisfiedPause(
  decision: ToolPolicyDecision,
  satisfiedPause: SatisfiedPolicyPause,
  context: ToolActionContext,
): boolean {
  if (
    !policyPauseMatchesDescriptor(decision, satisfiedPause.action, satisfiedPause.reason, context)
  ) {
    return false;
  }
  return (
    satisfiedPause.tier !== undefined &&
    satisfiedPause.tier === (decision[policyPauseTierSymbol] ?? 'tool')
  );
}

function createApprovalAction(
  decision: ToolPolicyDecision,
  reason: string,
  context: ToolActionContext,
): ToolApprovalAction {
  const policyVersion = decision.action?.policyVersion ?? context.policyVersion ?? 'policy:1';
  const actionInput = {
    type: 'approval' as const,
    message: decision.action?.message ?? reason,
    risk: decision.action?.risk ?? 'high',
    operation: decision.action?.operation ?? {
      kind: 'other' as const,
      argsPreview: normalizeToolContent(context.arguments),
    },
    ...(decision.action?.sandbox !== undefined ? { sandbox: decision.action.sandbox } : {}),
    ...(decision.action?.env !== undefined ? { env: [...decision.action.env] } : {}),
    ...(decision.action?.snapshotId !== undefined
      ? { snapshotId: decision.action.snapshotId }
      : {}),
    ...(decision.action?.expiresAt !== undefined ? { expiresAt: decision.action.expiresAt } : {}),
    ...(decision.action?.editableArgs !== undefined
      ? { editableArgs: decision.action.editableArgs }
      : {}),
    policyVersion,
    idempotencyKey:
      decision.action?.idempotencyKey ?? createApprovalIdempotencyKey(decision, reason, context),
  };
  const materialized = materializeToolResult({
    callId: context.callId,
    outcome: 'action_required',
    content: reason,
    action: actionInput,
  });
  if (materialized.action?.type !== 'approval') {
    throw new Error('Approval action materialization did not produce an approval action.');
  }
  return materialized.action;
}

function createApprovalIdempotencyKey(
  decision: ToolPolicyDecision,
  reason: string,
  context: ToolActionContext,
): string {
  const payload = normalizeToolContent({
    toolName: context.toolName,
    toolDefinitionRevision: context.toolDefinitionRevision,
    pauseTier: decision[policyPauseTierSymbol] ?? 'tool',
    callId: context.callId,
    arguments: context.arguments,
    reason,
    policyVersion: decision.action?.policyVersion ?? context.policyVersion ?? 'policy:1',
    risk: decision.action?.risk ?? 'high',
    operation: decision.action?.operation ?? { kind: 'other', argsPreview: context.arguments },
    sandbox: decision.action?.sandbox,
    env: decision.action?.env,
    snapshotId: decision.action?.snapshotId,
    expiresAt: decision.action?.expiresAt,
    editableArgs: decision.action?.editableArgs,
  });
  return `approval:${computeDigest(payload, 'sha256')}`;
}

function policyPauseMatchesDescriptor(
  decision: ToolPolicyDecision,
  action: ToolAction,
  reason: string | undefined,
  context: ToolActionContext,
): boolean {
  const type = decision.status === 'needs_input' ? 'input' : 'approval';
  const decisionReason = decision.reason ?? `Tool execution requires ${type}`;
  const decisionAction = createToolAction(type, decision, decisionReason, context);
  return (
    reason === decisionReason &&
    stableStringifyJson(normalizeToolContent(action)) ===
      stableStringifyJson(normalizeToolContent(decisionAction))
  );
}
