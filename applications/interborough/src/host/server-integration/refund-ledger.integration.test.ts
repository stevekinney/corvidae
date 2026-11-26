import { principalFromApiKey } from '@lostgradient/backchannel';
import { createBureau, createMemoryAssetStorage } from '@lostgradient/bureau';
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { createCheckpointStore } from '@lostgradient/operative';
import {
  createAdmittedRefundTool,
  createFakeProcessor,
  createRefundLedger,
} from '@lostgradient/plugin-demo/refunds';
import { textValueStore } from '@lostgradient/storage';
import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { createToolbox } from 'armorer/testing';
import { expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewedRefundContribution } from '../refund-operations.ts';
import { durableApprovalStore } from './refund.test-support.ts';

for (const boundary of ['prepared', 'terminal-save', 'review'] as const) {
  const outcome = await (async () => {
    const directory = await mkdtemp(join(tmpdir(), 'refund-review-crash-'));
    const path = join(directory, 'refund.sqlite');
    const child = spawnWithHangGuard(
      [
        process.execPath,
        '-e',
        `
      import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
      import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
      import { createBureau, createMemoryAssetStorage } from '@lostgradient/bureau';
      import { createToolbox } from 'armorer/testing';
      import { durableApprovalStore } from './src/host/server-integration/refund.test-support.ts';
      import { createRefundLedger, createFakeProcessor, createAdmittedRefundTool } from '@lostgradient/plugin-demo/refunds';
      import { reviewedRefundContribution } from './src/host/refund-operations.ts';
      const storage = new BunSQLiteStorage(process.argv[1]);
      const ledger = createRefundLedger(storage);
      await ledger.addCharge({ merchant: 'merchant', order: 'order', amount: 10000, currency: 'USD', paymentReference: 'charge', providerAccount: 'account' });
      const refund = await ledger.admit({ merchant: 'merchant', commandId: 'crash-review', order: 'order', amount: 4200, toolRevision: '1.1.0', owner: 'alice' });
      const original = await ledger.claimStart(refund.id);
      const wrapped = new Proxy(storage, { get(target, property) {
        if (property === 'conditionalBatch') return async (conditions, operations) => {
          if (process.argv[2] === 'terminal-save' && operations.some((operation) => operation.type === 'put' && operation.key.startsWith('agent-session-v2:body:') && JSON.parse(new TextDecoder().decode(operation.value)).metadata?.lastRunStatus === 'completed')) { console.log(JSON.stringify({ refundId: refund.id, original })); await Bun.stdin.text(); }
          const result = await target.conditionalBatch(conditions, operations);
          if (process.argv[2] === 'prepared' && result && operations.some((operation) => operation.type === 'put' && operation.key === 'wf:' + original.runId)) { console.log(JSON.stringify({ refundId: refund.id, original })); await Bun.stdin.text(); }
          return result;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }});
      const approvalStateStore = durableApprovalStore(storage);
      const tool = createAdmittedRefundTool(ledger, createFakeProcessor(storage), () => 100);
      const toolbox = createToolbox([tool], { approvalSecret: 'fixture-secret', approvalStateStore, approvalPolicy: { mode: 'always' } });
      const requestContext = () => ({ authority: { principalId: 'alice', tenantId: 'merchant', ownerId: 'alice', capabilities: [], authorizationRevision: 'v1' } });
      const observedLedger = new Proxy(ledger, { get(target, property, receiver) {
        if (property === 'completeStart' && process.argv[2] === 'review') return async (...args) => { const result = await target.completeStart(...args); console.log(JSON.stringify({ refundId: refund.id, original })); await Bun.stdin.text(); return result; };
        return Reflect.get(target, property, receiver);
      }});
      const contribution = reviewedRefundContribution({ ledger: observedLedger, toolbox, toolId: tool.id, approvalStateStore, requestContext, access: { request: async () => ({ merchant: 'merchant', owner: 'alice' }), read: async () => true, isRequester: async () => false, decide: async () => true } });
      const now = 1000000;
      const bureau = await createBureau({ id: 'refund-crash', storage: wrapped, durable: true, runtime: { ...createDefaultRuntimeServices(), clock: { now: () => now, nowISO: () => new Date(now).toISOString() } }, durableOwnership: { ownership: 'workflow-lease', workflowClaimTtlMs: 60000, workflowClaimRenewIntervalMs: 5000 }, agents: contribution.agents, reviewPolicy: contribution.reviewPolicy, requestAuthorityValidator: () => true, assets: { storage: createMemoryAssetStorage() } });
      await contribution.drain(refund.id, { tasks: bureau.tasks, internals: bureau.internals, reviews: bureau.reviews, requestContext: async () => requestContext() });
    `,
        path,
        boundary,
      ],
      { cwd: process.cwd(), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    );
    try {
      const output = await child.stdout.getReader().read();
      if (!output.value)
        throw new Error(
          `Child exited before preparation: ${await new Response(child.stderr).text()}`,
        );
      const saved = JSON.parse(new TextDecoder().decode(output.value)) as {
        refundId: string;
        original: { runId: string; sessionId: string };
      };
      child.kill('SIGKILL');
      await child.exited;
      const storage = new BunSQLiteStorage(path);
      let failAfterRepairCommit = boundary === 'terminal-save';
      const recoveryStorage = new Proxy(storage, {
        get(target, property, receiver) {
          if (property === 'conditionalBatch')
            return async (...args: Parameters<typeof storage.conditionalBatch>) => {
              const result = await target.conditionalBatch(...args);
              if (
                failAfterRepairCommit &&
                result &&
                args[1].some(
                  (operation) =>
                    operation.type === 'put' &&
                    operation.key.startsWith('agent-session-v2:body:') &&
                    JSON.parse(new TextDecoder().decode(operation.value)).metadata
                      ?.lastRunStatus === 'completed',
                )
              ) {
                failAfterRepairCommit = false;
                throw new Error('Lost acknowledgement after committed repair');
              }
              return result;
            };
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const ledger = createRefundLedger(storage);
      const approvalStateStore = durableApprovalStore(storage);
      const tool = createAdmittedRefundTool(ledger, createFakeProcessor(storage), () => 100);
      const toolbox = createToolbox([tool], {
        approvalSecret: 'fixture-secret',
        approvalStateStore,
        approvalPolicy: { mode: 'always' },
      });
      const requestContext = () => ({
        authority: {
          principalId: 'alice',
          tenantId: 'merchant',
          ownerId: 'alice',
          capabilities: [],
          authorizationRevision: 'v2',
        },
      });
      const contribution = reviewedRefundContribution({
        ledger,
        toolbox,
        toolId: tool.id,
        approvalStateStore,
        requestContext,
        access: {
          request: async () => ({ merchant: 'merchant', owner: 'alice' }),
          read: async () => true,
          isRequester: async () => false,
          decide: async () => true,
        },
      });
      const now = 1120000;
      const bureau = await createBureau({
        id: 'refund-crash',
        storage: recoveryStorage,
        durable: true,
        runtime: {
          ...createDefaultRuntimeServices(),
          clock: { now: () => now, nowISO: () => new Date(now).toISOString() },
        },
        durableOwnership: {
          ownership: 'workflow-lease',
          workflowClaimTtlMs: 60000,
          workflowClaimRenewIntervalMs: 5000,
        },
        agents: contribution.agents,
        reviewPolicy: contribution.reviewPolicy,
        requestAuthorityValidator: () => true,
        assets: { storage: createMemoryAssetStorage() },
      });
      try {
        expect(failAfterRepairCommit).toBe(false);
        const recovered = await contribution.drain(saved.refundId, {
          tasks: bureau.tasks,
          internals: bureau.internals,
          reviews: bureau.reviews,
          requestContext: async () => requestContext(),
        });
        if (!recovered) {
          const start = await ledger.getStart(saved.refundId);
          const workflow = await bureau.tasks.workflow(saved.original.runId);
          const review = await bureau.reviews.get(`approval:${saved.original.runId}:reviewed-call`);
          const session = await bureau.internals.sessionStore?.load(saved.original.sessionId);
          const approvals = session?.metadata['pendingApprovalOverrides'];
          const stored =
            typeof approvals === 'object' &&
            approvals !== null &&
            Object.hasOwn(approvals, `approval:${saved.original.runId}:reviewed-call`);
          const snapshot = await createCheckpointStore(
            textValueStore(storage, { disposeUnderlyingStorage: false }),
          ).loadConversation(saved.original.runId);
          throw new Error(
            `Recovery failed: start=${start?.status}, workflow=${workflow?.status}, review=${review?.status}, session=${JSON.stringify(session?.metadata['lastRunStatus'])}, approvalStored=${stored}, snapshotStored=${snapshot !== null}`,
          );
        }
        const refund = await ledger.get(saved.refundId);
        expect(refund).toMatchObject({
          existingRunId: saved.original.runId,
          reviewId: `approval:${saved.original.runId}:reviewed-call`,
        });
        const restoredReview = await bureau.reviews.get(refund!.reviewId!);
        expect(restoredReview).toMatchObject({
          kind: 'tool-approval',
          runId: saved.original.runId,
          sessionId: saved.original.sessionId,
        });
        if (!restoredReview || restoredReview.kind !== 'tool-approval')
          throw new Error('Missing signed review');
        const persistedSession = await bureau.internals.sessionStore?.load(
          saved.original.sessionId,
        );
        const persisted = persistedSession?.metadata['pendingApprovalOverrides'];
        if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted))
          throw new Error('Missing persisted approval');
        expect(restoredReview.approval).toEqual(Reflect.get(persisted, refund!.reviewId!));
        const reviewer = principalFromApiKey({ subject: 'reviewer', scopes: [] });
        const resolution = await bureau.reviews.resolve({
          id: refund!.reviewId!,
          decision: 'approve',
          round: 0,
          principal: 'reviewer',
          reviewer,
        });
        expect(resolution.superseded).toBe(true);
        if (resolution.superseded)
          await bureau.reviews.resolve({
            id: refund!.reviewId!,
            decision: 'approve',
            round: 1,
            principal: 'reviewer',
            reviewer,
          });
        expect(await createFakeProcessor(storage).submissions()).toBe(1);
      } finally {
        await bureau.dispose();
        storage[Symbol.dispose]();
      }
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
      await rm(directory, { recursive: true, force: true });
    }
  })().then(
    () => null,
    (error: unknown) => error,
  );
  it(`recovers the same signed refund review after process death at ${boundary}`, () => {
    expect(outcome).toBeNull();
  });
}
