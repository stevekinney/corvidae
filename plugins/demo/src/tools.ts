/**
 * The demo plugin's two tools: `lookup-order`, which only reads, and `issue-refund`, which changes
 * something and so waits for an operator to approve each call.
 *
 * @module tools
 */

import type { PluginSetupContext } from '@lostgradient/interborough-plugin';
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

/** The read-only tool: looks an order up by its identifier. */
export function createLookupOrderTool() {
  return createTool({
    name: 'lookup-order',
    version: '1.0.0',
    description: 'Look up an order by its identifier.',
    input: z.object({ orderId: z.string() }),
    metadata: { readOnly: true },
    execute: async ({ orderId }) => ({ orderId, status: 'delivered', totalCents: 4200 }),
  });
}

/** The mutating tool: refunds an order. An operator approves each refund before it runs. */
export function createIssueRefundTool() {
  return createTool({
    name: 'issue-refund',
    version: '1.0.0',
    description: 'Refund an order. An operator approves each refund before it runs.',
    input: z.object({ orderId: z.string(), cents: z.number() }),
    metadata: { mutates: true, summary: 'Refund order {orderId} for {cents:usd-cents}' },
    execute: async ({ orderId, cents }) => ({ orderId, refundedCents: cents }),
  });
}

/**
 * The toolbox of the `tool-runner` agent: its own two tools, with approvals signed by
 * `approvalSecret`. A tool that reads runs and one that changes something waits for an operator,
 * the rule a file agent's tools follow with no `toolApproval`, and the chat's permission mode
 * applies as it does to a file agent. The hook governs the two tools only, because the Bureau adds
 * `requestHumanInput` and the like to a run.
 */
export function createToolRunnerToolbox(
  approvalSecret: string | undefined,
  toolApprovalHooks: PluginSetupContext['toolApprovalHooks'],
) {
  const lookupOrder = createLookupOrderTool();
  const issueRefund = createIssueRefundTool();
  return createToolbox([lookupOrder, issueRefund], {
    ...(approvalSecret === undefined ? {} : { approvalSecret }),
    policy: toolApprovalHooks([lookupOrder.name, issueRefund.name]),
  });
}
