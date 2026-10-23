import { describe, expect, it, test } from 'bun:test';
import { z } from 'zod';

import { createApprovalPolicyHooks, withToolSummary } from './approval-policy';
import { createTool, createToolCall } from './create-tool';
import type { ToolPolicyContext } from './is-tool';
import { readToolShortDescription, renderToolSummary } from './tool-summary';

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

describe('the approval policy with a summary', () => {
  const tool = createTool({
    name: 'issue-refund',
    description: 'Refund an order.',
    input: z.object({ orderId: z.string(), cents: z.number().optional() }),
    metadata,
    execute: async () => ({ ok: true }),
  });
  const context = (parameters: { orderId: string; cents?: number }): ToolPolicyContext => ({
    toolName: tool.name,
    toolCall: createToolCall(tool.name, parameters),
    params: parameters,
    configuration: tool.configuration,
    metadata,
  });

  test('carries the summary as the approval message and keeps the reason', () => {
    const decision = withToolSummary(
      { allow: false, status: 'needs_approval', reason: 'Tool requires approval.' },
      context({ orderId: 'order-1001', cents: 4200 }),
    );
    expect(decision.action?.message).toBe('Refund order order-1001 for $42.00');
    expect(decision.reason).toBe('Tool requires approval.');
  });

  test('adds no message when the summary cannot be written, or the decision is not an approval', () => {
    const asked = { allow: false, status: 'needs_approval', reason: 'r' } as const;
    expect(withToolSummary(asked, context({ orderId: 'order-1001' }))).toBe(asked);
    const allowed = { allow: true, status: 'allow' } as const;
    expect(withToolSummary(allowed, context({ orderId: 'order-1001', cents: 4200 }))).toBe(allowed);
  });

  test('is what the on-mutation hook decides for a mutating call', async () => {
    const decision = await createApprovalPolicyHooks({ mode: 'on-mutation' }).beforeExecute?.(
      context({ orderId: 'order-1001', cents: 4200 }),
    );
    expect(typeof decision === 'object' && decision.action?.message).toBe(
      'Refund order order-1001 for $42.00',
    );
  });
});

describe('readToolShortDescription', () => {
  it('returns the trimmed line a tool declares', () => {
    expect(readToolShortDescription({ shortDescription: '  Look up an order.  ' })).toBe(
      'Look up an order.',
    );
  });

  it('returns undefined when the tool declares none, a blank one, or a value that is not text', () => {
    expect(readToolShortDescription(undefined)).toBeUndefined();
    expect(readToolShortDescription({ readOnly: true })).toBeUndefined();
    expect(readToolShortDescription({ shortDescription: '   ' })).toBeUndefined();
    // A tool whose metadata came from JSON may hold anything, whatever the type says.
    expect(readToolShortDescription({ shortDescription: 4 } as never)).toBeUndefined();
  });

  it('is read from a tool built with createTool', () => {
    const tool = createTool({
      name: 'lookup-order',
      description: 'A long, model-facing prompt about looking orders up.',
      input: z.object({ orderId: z.string() }),
      metadata: { shortDescription: 'Look up an order by its identifier.' },
      execute: async ({ orderId }) => ({ orderId }),
    });
    expect(readToolShortDescription(tool.metadata)).toBe('Look up an order by its identifier.');
  });
});
