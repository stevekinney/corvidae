import { declaredTaintThreshold } from '@lostgradient/operative';

/**
 * COR-2385 — the `agentTaintThreshold` field of a resolved catalog agent: present when the agent
 * declares a `taintThreshold` in its own guardrails, and omitted otherwise, because the resolution
 * types declare the key without `| undefined`.
 */
export function agentTaintThresholdField(agent: object): { agentTaintThreshold?: number } {
  const threshold = declaredTaintThreshold(agent);
  return threshold === undefined ? {} : { agentTaintThreshold: threshold };
}
