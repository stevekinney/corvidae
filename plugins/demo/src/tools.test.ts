import { MemoryStorage } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { createTool, createToolbox, createToolCall, type SignedPendingToolApproval } from 'armorer/testing';
import { expect, it } from 'bun:test';
import { z } from 'zod';
import { createRefundLedger } from './refund-ledger.ts';
import { createFakeProcessor } from './refund-processor.ts';
import { toolRunnerGenerate } from './scripts.ts';
import { createAdmittedRefundTool, createToolRunnerToolbox } from './tools.ts';

it('executes only the admitted refund whose signed arguments match', async () => {
  const ledger = createRefundLedger(new MemoryStorage());
  const processor = createFakeProcessor(new MemoryStorage());
  await ledger.addCharge({
    merchant: 'merchant',
    order: 'order',
    amount: 10000,
    currency: 'USD',
    paymentReference: 'charge',
    providerAccount: 'account',
  });
  const refund = await ledger.admit({
    merchant: 'merchant',
    commandId: 'command',
    order: 'order',
    amount: 4000,
    toolRevision: '1.1.0',
    owner: 'alice',
    existingRunId: 'run',
  });
  const toolbox = createToolbox([createAdmittedRefundTool(ledger, processor, () => 100)], {
    approvalSecret: 'fixture-secret',
  });
  const requestContext = {
    authority: {
      principalId: 'alice',
      tenantId: 'tenant',
      ownerId: 'alice',
      capabilities: [],
      authorizationRevision: '1',
    },
    audience: 'operator' as const,
    agentId: 'agent',
    runId: 'run',
  };
  const approve = async (call: ReturnType<typeof createToolCall>) => {
    const pending = await toolbox.execute(call, { requestContext });
    if (!pending.pendingApproval?.approvalToken) throw new Error('Missing approval');
    return toolbox.resumeApproval(pending.pendingApproval as SignedPendingToolApproval, {
      requestContext,
    });
  };
  const invalid = await approve(
    createToolCall('issue-refund', {
      refundId: refund.id,
      orderId: 'order',
      cents: 3000,
      currency: 'USD',
    }),
  );
  expect(invalid.outcome).toBe('error');
  const missing = await approve(
    createToolCall('issue-refund', {
      refundId: 'missing',
      orderId: 'order',
      cents: 4000,
      currency: 'USD',
    }),
  );
  expect(missing.outcome).toBe('error');
  expect(await processor.submissions()).toBe(0);
  const result = await approve(
    createToolCall('issue-refund', {
      refundId: refund.id,
      orderId: 'order',
      cents: 4000,
      currency: 'USD',
    }),
  );
  expect(result.outcome).toBe('success');
  expect(await processor.submissions()).toBe(1);
  expect(JSON.stringify(result)).not.toContain(refund.providerKey);
  expect(JSON.stringify(result)).not.toContain(refund.paymentReference);
});

it('requires a review even when the host allows mutation', async () => {
  const ledger = createRefundLedger(new MemoryStorage());
  const processor = createFakeProcessor(new MemoryStorage());
  const tool = createAdmittedRefundTool(ledger, processor, () => 100);
  const toolbox = createToolRunnerToolbox(
    undefined,
    () => ({ beforeExecute: () => ({ allow: true, status: 'allow' }) }),
    tool,
  );
  const result = await toolbox.execute(
    createToolCall('issue-refund', {
      refundId: 'missing',
      orderId: 'order',
      cents: 4000,
      currency: 'USD',
    }),
  );
  expect(result.outcome).toBe('action_required');
  expect(await processor.submissions()).toBe(0);
});

it('requires review when the registered tool is used by another toolbox', async () => {
  const ledger = createRefundLedger(new MemoryStorage());
  const processor = createFakeProcessor(new MemoryStorage());
  const toolbox = createToolbox([createAdmittedRefundTool(ledger, processor, () => 100)]);
  const result = await toolbox.execute(
    createToolCall('issue-refund', {
      refundId: 'known',
      orderId: 'order',
      cents: 4000,
      currency: 'USD',
    }),
  );
  expect(result.outcome).toBe('action_required');
  expect(await processor.submissions()).toBe(0);
});

it('cannot execute a pre-cutover signed refund approval', async () => {
  const ledger = createRefundLedger(new MemoryStorage());
  const processor = createFakeProcessor(new MemoryStorage());
  await ledger.addCharge({
    merchant: 'merchant',
    order: 'order',
    amount: 10000,
    currency: 'USD',
    paymentReference: 'charge',
    providerAccount: 'account',
  });
  const intent = await ledger.admit({
    merchant: 'merchant',
    commandId: 'command',
    order: 'order',
    amount: 4000,
    toolRevision: '1.1.0',
    owner: 'alice',
    existingRunId: 'run',
  });
  const oldTool = createTool({
    name: 'issue-refund',
    version: '1.0.0',
    description: 'Old demo refund',
    input: z.object({ orderId: z.string(), cents: z.number() }),
    policy: {
      beforeAdmission: () => ({ allow: false, status: 'needs_approval', reason: 'Review refund' }),
    },
    execute: async () => ({}),
  });
  const requestContext = {
    authority: {
      principalId: 'alice',
      tenantId: 'tenant',
      ownerId: 'alice',
      capabilities: [],
      authorizationRevision: '1',
    },
    audience: 'operator' as const,
    agentId: 'agent',
    runId: 'run',
  };
  const oldBox = createToolbox([oldTool], { approvalSecret: 'fixture-secret' });
  const pending = await oldBox.execute(
    createToolCall('issue-refund', { orderId: 'order', cents: 4000 }),
    { requestContext },
  );
  if (!pending.pendingApproval?.approvalToken) throw new Error('Missing old approval');
  const newBox = createToolbox([createAdmittedRefundTool(ledger, processor, () => 100)], {
    approvalSecret: 'fixture-secret',
  });
  const rejection = await rejectionOf(
    newBox.resumeApproval(pending.pendingApproval as SignedPendingToolApproval, { requestContext }),
  );
  expect(rejection).toMatchObject({
    code: 'mismatch',
    message: 'Approval binding toolDefinitionRevision does not match.',
  });
  expect(await processor.submissions()).toBe(0);
  expect(await ledger.get(intent.id)).toMatchObject({ status: 'admitted' });
  expect(await ledger.balance('merchant', 'order')).toMatchObject({ reserved: 4000 });
});

it('replays a scripted turn without another intent or task start', async () => {
  const storage = new MemoryStorage();
  const ledger = createRefundLedger(storage);
  const generate = toolRunnerGenerate(ledger);
  const context = (id: string, runId: string) =>
    ({
      conversation: {
        getMessages: () => [
          { id, role: 'user' },
          { toolResult: { callId: 'seeded-lookup-order-1', outcome: 'success' } },
        ],
      },
      runId,
      step: 1,
    }) as never;
  const first = await generate(context('turn-one', 'run-one'));
  const replay = await generate(context('turn-one', 'run-two'));
  const second = await generate(context('turn-two', 'run-three'));
  expect(replay.toolCalls).toHaveLength(0);
  const originalCall = first.toolCalls[0];
  if (!originalCall) throw new Error('Missing original refund call');
  expect(replay.content).toContain((originalCall.arguments as { refundId: string }).refundId);
  expect(second.toolCalls[0]?.arguments).not.toEqual(first.toolCalls[0]?.arguments);
  const intents = [];
  for await (const [, value] of storage.scan('refund:'))
    intents.push(JSON.parse(new TextDecoder().decode(value)));
  expect(intents).toHaveLength(2);
  expect(intents.find((intent) => intent.existingRunId === 'run-one')).toBeDefined();
  const starts = [];
  for await (const entry of storage.scan('start:')) starts.push(entry);
  expect(starts).toHaveLength(0);
});
