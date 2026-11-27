import { principalFromApiKey } from '@lostgradient/backchannel';
import { createBureau, createMemoryAssetStorage } from '@lostgradient/bureau';
import {
  createAdmittedRefundTool,
  createFakeProcessor,
  createRefundLedger,
} from '@lostgradient/plugin-demo/refunds';
import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
import { createToolbox } from 'armorer';
import { reviewedRefundContribution } from '../refund-operations.ts';
import { durableApprovalStore } from './refund.test-support.ts';

const [database, providerDatabase, role, identifier] = process.argv.slice(2);
if (!database || !providerDatabase || !role) throw new Error('Missing arguments');
const storage = new BunSQLiteStorage(database);
const commands = role === 'owner' ? undefined : Bun.stdin.stream().getReader();
const waitForCommand = async () => {
  if (!commands) throw new Error('Missing barrier release');
  const command = await commands.read();
  if (command.done) throw new Error('Missing barrier release');
};
const conditionalBatch = storage.conditionalBatch.bind(storage);
let claimHeld = false;
if (commands) {
  storage.conditionalBatch = async (conditions, operations, deadline) => {
    const claim =
      !claimHeld &&
      operations.some(
        (operation) => operation.type === 'put' && operation.key.startsWith('review-decision:'),
      );
    if (claim) {
      claimHeld = true;
      console.log(JSON.stringify({ pid: process.pid, claim: 'arrived' }));
      await waitForCommand();
    }
    const result = await conditionalBatch(conditions, operations, deadline);
    if (claim && result) {
      console.log(JSON.stringify({ pid: process.pid, claim: 'committed' }));
      await waitForCommand();
    }
    return result;
  };
}
const providerStorage = new BunSQLiteStorage(providerDatabase);
const ledger = createRefundLedger(storage);
const processor = createFakeProcessor(providerStorage);
const approvalStateStore = durableApprovalStore(storage);
const tool = createAdmittedRefundTool(ledger, processor, () => 100);
const toolbox = createToolbox([tool], {
  approvalSecret: 'fixture-secret',
  approvalStateStore,
  ...(role === 'regater' ? { approvalPolicy: { mode: 'always' as const } } : {}),
});
const requestContext = () => ({
  authority: {
    principalId: 'alice',
    tenantId: 'merchant',
    ownerId: 'alice',
    capabilities: [],
    authorizationRevision: '1',
  },
});
const contribution = reviewedRefundContribution({
  ledger,
  toolbox,
  toolId: tool.id,
  approvalStateStore,
  requestContext,
  access: {
    request: async () => ({ merchant: 'merchant', owner: 'api-key:alice' }),
    read: async () => true,
    isRequester: async () => false,
    decide: async () => true,
  },
});
const bureau = await createBureau({
  id: 'refund-peers',
  storage,
  durable: true,
  durableOwnership: { ownership: 'workflow-lease' },
  agents: contribution.agents,
  reviewPolicy: contribution.reviewPolicy,
  requestAuthorityValidator: () => true,
  plugins: [
    {
      descriptor: contribution.releasePlugin,
      source: 'package',
      location: '@lostgradient/plugin-demo',
    },
  ],
  pluginConfiguration: { reviewed: { enabled: true } },
  assets: { storage: createMemoryAssetStorage() },
});
let worker: Awaited<ReturnType<typeof contribution.attachWorker>> | undefined;
try {
  if (role === 'owner') {
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
      commandId: 'control',
      order: 'order',
      amount: 4200,
      toolRevision: '1.1.0',
      owner: 'api-key:alice',
    });
    worker = await contribution.attachWorker(
      {
        tasks: bureau.tasks,
        internals: bureau.internals,
        reviews: bureau.reviews,
        events: bureau,
        async requestContext() {
          return requestContext();
        },
      },
      (error) => {
        throw error;
      },
    );
    await worker.idle();
    const admitted = await ledger.get(refund.id);
    if (!admitted?.reviewId) throw new Error('No review');
    console.log(
      JSON.stringify({ pid: process.pid, refundId: refund.id, reviewId: admitted.reviewId }),
    );
    await Bun.stdin.text();
    await worker.idle();
    const decisions = [];
    for await (const [key] of storage.scan('review-decision:')) decisions.push(key);
    const tasks = [];
    for await (const [key] of storage.scan('bureau-task:v1:')) tasks.push(key);
    const starts = [];
    for await (const [key] of storage.scan('start:')) starts.push(key);
    const request = {
      merchant: 'merchant',
      commandId: 'control',
      order: 'order',
      amount: 4200,
      toolRevision: '1.1.0',
      owner: 'api-key:alice',
    };
    const replay = await ledger.admit(request);
    let changedAmountConflict = false;
    try {
      await ledger.admit({ ...request, amount: 4100 });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'Conflict') throw error;
      changedAmountConflict = true;
    }
    console.log(
      JSON.stringify({
        refund: await ledger.get(refund.id),
        provider: await processor.refunds(),
        decisions,
        tasks,
        starts,
        replayId: replay.id,
        changedAmountConflict,
      }),
    );
  } else {
    if (!identifier) throw new Error('No review identifier');
    console.log(JSON.stringify({ pid: process.pid, ready: true }));
    await waitForCommand();
    const actor = `reviewer-${process.pid}`;
    try {
      const result = await bureau.reviews.resolve({
        id: identifier,
        decision: role === 'denier' ? 'deny' : 'approve',
        round: 0,
        principal: `api-key:${actor}`,
        reviewer: principalFromApiKey({ subject: actor, scopes: [] }),
      });
      console.log(JSON.stringify({ pid: process.pid, result }));
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'CONFLICT') throw error;
      const review = await bureau.reviews.get(identifier);
      console.log(
        JSON.stringify({
          pid: process.pid,
          conflict: true,
          review: review && {
            round: review.kind === 'tool-approval' ? review.round : undefined,
            status: review.status,
          },
        }),
      );
    }
  }
} finally {
  await worker?.dispose();
  await bureau.dispose();
  providerStorage[Symbol.dispose]();
  storage[Symbol.dispose]();
}
