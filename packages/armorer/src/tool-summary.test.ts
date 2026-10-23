import { describe, expect, it } from 'bun:test';

import { createToolCall } from './create-tool';
import type { ToolPolicyContext } from './is-tool';
import { createApprovalPolicyHooks } from './approval-policy';
import { renderToolSummary } from './tool-summary';

const metadata = { mutates: true, summary: 'Refund order {orderId} for {cents:usd-cents}' };

describe('renderToolSummary', () => {
  it('writes the call into the template, formatting cents as dollars', () => {
    expect(renderToolSummary(metadata, { orderId: 'order-1001', cents: 4200 })).toBe(
      'Refund order order-1001 for $42.00',
    );
  });

  it('reaches into nested arguments', () => {
    expect(renderToolSummary({ summary: 'Email {to.address}' }, { to: { address: 'a@b.c' } })).toBe(
      'Email a@b.c',
    );
  });

  it('returns undefined with no template, a blank one, or a placeholder it cannot fill', () => {
    expect(renderToolSummary(undefined, {})).toBeUndefined();
    expect(renderToolSummary({ summary: ' ' }, {})).toBeUndefined();
    expect(renderToolSummary(metadata, { orderId: 'order-1001' })).toBeUndefined();
    expect(renderToolSummary(metadata, { orderId: 'o', cents: 'many' })).toBeUndefined();
    expect(renderToolSummary({ summary: '{x:unknown-format}' }, { x: 1 })).toBeUndefined();
  });
});

describe('createApprovalPolicyHooks with a summary', () => {
  const context = (parameters: unknown): ToolPolicyContext =>
    ({
      toolName: 'issue-refund',
      toolCall: createToolCall('issue-refund', parameters as Record<string, unknown>),
      params: parameters,
      metadata,
    }) as ToolPolicyContext;

  it('carries the summary as the approval message and keeps the reason', async () => {
    const decision = await createApprovalPolicyHooks({ mode: 'on-mutation' }).beforeExecute?.(
      context({ orderId: 'order-1001', cents: 4200 }),
    );
    expect(decision?.status).toBe('needs_approval');
    expect(decision?.action?.message).toBe('Refund order order-1001 for $42.00');
    expect(decision?.reason).toContain('requires approval');
  });

  it('adds no message when the summary cannot be written', async () => {
    const decision = await createApprovalPolicyHooks({ mode: 'on-mutation' }).beforeExecute?.(
      context({ orderId: 'order-1001' }),
    );
    expect(decision?.action).toBeUndefined();
  });
});
