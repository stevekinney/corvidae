import { stableStringifyJson } from '../core/serialization/json';
import { policyPauseTierSymbol } from '../internal/approval-resume';
import type { ToolPolicyDecision } from '../is-tool';
import type { SatisfiedPolicyPause, ToolAction } from '../types';
import { normalizeToolContent } from './content';

export function createToolAction(
  type: 'approval' | 'input',
  decision: ToolPolicyDecision,
  reason: string,
): ToolAction {
  const action: ToolAction = { type, message: decision.action?.message ?? reason };
  if (decision.action?.schema !== undefined)
    action.schema = normalizeToolContent(decision.action.schema);
  return action;
}

export function policyPauseMatchesSatisfiedPause(
  decision: ToolPolicyDecision,
  satisfiedPause: SatisfiedPolicyPause,
): boolean {
  if (!policyPauseMatchesDescriptor(decision, satisfiedPause.action, satisfiedPause.reason)) {
    return false;
  }
  return (
    satisfiedPause.tier !== undefined &&
    satisfiedPause.tier === (decision[policyPauseTierSymbol] ?? 'tool')
  );
}

function policyPauseMatchesDescriptor(
  decision: ToolPolicyDecision,
  action: ToolAction,
  reason: string | undefined,
): boolean {
  const type = decision.status === 'needs_input' ? 'input' : 'approval';
  const decisionReason = decision.reason ?? `Tool execution requires ${type}`;
  const decisionAction = createToolAction(type, decision, decisionReason);
  return (
    reason === decisionReason &&
    stableStringifyJson(normalizeToolContent(action)) ===
      stableStringifyJson(normalizeToolContent(decisionAction))
  );
}
