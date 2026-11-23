/**
 * The demo plugin's two tools: `lookup-order`, which only reads, and `issue-refund`, which changes
 * something and so waits for an operator to approve each call.
 *
 * @module tools
 */

import type { PluginSetupContext } from '@lostgradient/interborough-plugin';
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';
import { REFUND_TOOL_REVISION, type createRefundLedger } from './refund-ledger.ts';
import { submitApprovedRefund, type createFakeProcessor } from './refund-processor.ts';

/** A pre-admitted refund, executed only after its signed tool call is approved. */
export function createAdmittedRefundTool(
  ledger: ReturnType<typeof createRefundLedger>,
  processor: ReturnType<typeof createFakeProcessor>,
  retryUntil: () => number,
  approvals?: PluginSetupContext['approvals'],
) {
  const hostPolicy = approvals?.(['issue-refund']);
  return createTool({
    name: 'issue-refund',
    version: REFUND_TOOL_REVISION,
    description: 'Execute an admitted refund after approval.',
    input: z.object({
      refundId: z.string(),
      orderId: z.string(),
      cents: z.number().int().positive(),
      currency: z.string().regex(/^[A-Z]{3}$/),
    }),
    metadata: {
      mutates: true,
      summary: 'Refund order {orderId} for {cents} minor units ({currency})',
    },
    policy: {
      async beforeAdmission(context) {
        const decision = await hostPolicy?.beforeExecute?.(context);
        if (
          decision === false ||
          (typeof decision === 'object' &&
            decision !== null &&
            (decision.status === 'deny' ||
              decision.status === 'needs_approval' ||
              decision.allow === false))
        )
          return decision;
        return { allow: false, status: 'needs_approval', reason: 'Each refund requires approval.' };
      },
    },
    execute: async ({ refundId, orderId, cents, currency }, context) => {
      const refund = await ledger.get(refundId);
      if (
        !refund ||
        refund.order !== orderId ||
        refund.amount !== cents ||
        refund.currency !== currency ||
        !refund.existingRunId ||
        refund.existingRunId !== context.requestContext?.runId ||
        refund.toolRevision !== REFUND_TOOL_REVISION
      )
        throw new Error('Refund arguments do not match the admitted intent');
      const result = await submitApprovedRefund(ledger, processor, refundId, retryUntil());
      if (!result) throw new Error('Refund disappeared');
      return {
        refundId: result.id,
        orderId: result.order,
        cents: result.amount,
        currency: result.currency,
        status: result.status,
      };
    },
  });
}

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

/**
 * The toolbox of the `tool-runner` agent: its own two tools, with approvals signed by
 * `approvalSecret`. A tool that reads runs and one that changes something waits for an operator,
 * the rule a file agent's tools follow with no `approvals`, and the chat's permission mode
 * applies as it does to a file agent. The hook governs the two tools only, because the Bureau adds
 * `requestHumanInput` and the like to a run.
 */
export function createToolRunnerToolbox(
  approvalSecret: string | undefined,
  approvals: PluginSetupContext['approvals'],
  issueRefund: ReturnType<typeof createAdmittedRefundTool>,
) {
  const lookupOrder = createLookupOrderTool();
  const hostPolicy = approvals([lookupOrder.name]);
  return createToolbox([lookupOrder, issueRefund], {
    ...(approvalSecret === undefined ? {} : { approvalSecret }),
    policy: {
      async beforeAdmission(context) {
        if (context.toolName === issueRefund.name) return { allow: true, status: 'allow' };
        const decision = await hostPolicy.beforeExecute?.(context);
        return decision;
      },
    },
  });
}
