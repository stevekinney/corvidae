import { principalFromApiKey } from '@lostgradient/backchannel';
import {
  createBureau,
  createBureauCatalogSnapshot,
  createBureauHandler,
  createMemoryAssetStorage,
} from '@lostgradient/bureau';
import { createDefaultRuntimeServices, HookRegistry } from '@lostgradient/lifecycle';
import {
  createAgent,
  hasDefinitionResolver,
  OPERATIVE_RESOLVE_RUN_OPTIONS,
} from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import {
  advanceTimersByTime,
  restoreRealTimers,
  useFakeTimers,
  waitForCondition,
} from '@lostgradient/testing/fake-timers';
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { WorkflowClaimUnavailableError } from '@lostgradient/weft';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  createProcessLocalApprovalStateStore,
  createToolbox,
  verifyToolboxPendingApproval,
} from 'armorer';
import { describe, expect, it } from 'bun:test';
import { createRefundLedger } from './refund-ledger.ts';
import { refundOperations, reviewedRefundContribution } from './refund-operations.ts';
import { createFakeProcessor } from './refund-processor.ts';
import { durableApprovalStore } from './refund.test-support.ts';
import { createAdmittedRefundTool } from './tools.ts';

describe('refund operations', () => {
  it('retries a live workflow claim without another request or host restart', async () => {
    const storage = new MemoryStorage();
    const ledger = createRefundLedger(storage);
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
      commandId: 'retry-lease',
      order: 'order',
      amount: 1000,
      toolRevision: '1.1.0',
      owner: 'alice',
    });
    const approvalStateStore = createProcessLocalApprovalStateStore();
    const tool = createAdmittedRefundTool(ledger, createFakeProcessor(storage), () => 100);
    const toolbox = createToolbox([tool], { approvalSecret: 'fixture-secret', approvalStateStore });
    const requestContext = () => ({
      authority: {
        principalId: 'alice',
        tenantId: 'merchant',
        ownerId: 'alice',
        capabilities: [],
        authorizationRevision: 'v1',
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
    const bureau = await createBureau({
      storage,
      durable: true,
      agents: contribution.agents,
      reviewPolicy: contribution.reviewPolicy,
      requestAuthorityValidator: () => true,
      assets: { storage: createMemoryAssetStorage() },
    });
    let attempts = 0;
    const tasks = new Proxy(bureau.tasks, {
      get(target, property, receiver) {
        if (property === 'reserveStartClaim')
          return async (runId: string) => {
            attempts += 1;
            if (attempts === 1) throw new WorkflowClaimUnavailableError(runId, 'other');
            return target.reserveStartClaim(runId);
          };
        return Reflect.get(target, property, receiver);
      },
    });
    useFakeTimers();
    const worker = await contribution.attachWorker(
      {
        tasks,
        reviews: bureau.reviews,
        internals: bureau.internals,
        events: bureau,
        requestContext: async () => requestContext(),
      },
      () => {},
    );
    try {
      await advanceTimersByTime(0);
      await worker.idle();
      expect(attempts).toBe(1);
      await advanceTimersByTime(5_000);
      await advanceTimersByTime(0);
      await worker.idle();
      expect(attempts).toBe(2);
      const stored = await ledger.get(refund.id);
      expect(stored?.reviewId).toBeDefined();
    } finally {
      await worker.dispose();
      restoreRealTimers();
      await bureau.dispose();
    }
  });
  it('does not advance a refund fence while its prepared workflow lease is live', async () => {
    const storage = new MemoryStorage();
    const ledger = createRefundLedger(storage);
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
      commandId: 'lease-race',
      order: 'order',
      amount: 1000,
      toolRevision: '1.1.0',
      owner: 'alice',
    });
    const hookReached = Promise.withResolvers<void>();
    const releaseHook = Promise.withResolvers<void>();
    const hooks = new HookRegistry<import('@lostgradient/operative').OperativeHookMap>();
    hooks.on('onRunStart', async () => {
      hookReached.resolve();
      await releaseHook.promise;
    });
    const approvalStateStore = createProcessLocalApprovalStateStore();
    const tool = createAdmittedRefundTool(ledger, createFakeProcessor(storage), () => 100);
    const toolbox = createToolbox([tool], { approvalSecret: 'fixture-secret', approvalStateStore });
    const requestContext = () => ({
      authority: {
        principalId: 'alice',
        tenantId: 'merchant',
        ownerId: 'alice',
        capabilities: [],
        authorizationRevision: 'v1',
      },
    });
    const access = {
      request: async () => ({ merchant: 'merchant', owner: 'alice' }),
      read: async () => true,
      isRequester: async () => false,
      decide: async () => true,
    };
    const firstContribution = reviewedRefundContribution({
      ledger,
      toolbox,
      toolId: tool.id,
      approvalStateStore,
      requestContext,
      access,
    });
    const secondContribution = reviewedRefundContribution({
      ledger,
      toolbox,
      toolId: tool.id,
      approvalStateStore,
      requestContext,
      access,
    });
    const agent = createAgent({
      hooks,
      generate: async () => ({ content: 'done', toolCalls: [] }),
    });
    const open = () =>
      createBureau({
        storage,
        durable: true,
        agents: { 'reviewed:demo-refund': agent },
        requestAuthorityValidator: () => true,
        assets: { storage: createMemoryAssetStorage() },
      });
    const first = await open();
    const second = await open();
    try {
      const host = (bureau: typeof first) => ({
        tasks: bureau.tasks,
        internals: bureau.internals,
        reviews: bureau.reviews,
        requestContext: async () => requestContext(),
      });
      const old = firstContribution.drain(refund.id, host(first));
      void old.catch(() => {});
      await hookReached.promise;
      const run = await ledger.getStart(refund.id);
      if (!run) throw new Error('Missing reserved run');
      const engine = first.durableEngine();
      if (!engine) throw new Error('Missing durable engine');
      await engine.runMaintenance();
      expect(await engine.claimHolder(run.runId)).toMatchObject({ heldByThisProcess: true });
      const successor = secondContribution.drain(refund.id, host(second));
      expect(await throwingRejectionOf(successor)).toThrow();
      expect(await ledger.getStart(refund.id)).toMatchObject({ fence: 1 });
    } finally {
      releaseHook.resolve();
      await first.dispose();
      await second.dispose();
    }
  });
  it('releases a denial from a second Bureau through the durable review outbox', async () => {
    const storage = new MemoryStorage();
    const ledger = createRefundLedger(storage);
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
      commandId: 'remote-denial',
      order: 'order',
      amount: 4200,
      toolRevision: '1.1.0',
      owner: 'api-key:alice',
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
    const approvalStateStore = durableApprovalStore(storage);
    const tool = createAdmittedRefundTool(
      ledger,
      createFakeProcessor(new MemoryStorage()),
      () => 100,
    );
    const toolbox = createToolbox([tool], { approvalSecret: 'fixture-secret', approvalStateStore });
    const contribution = reviewedRefundContribution({
      ledger,
      toolbox,
      toolId: tool.id,
      approvalStateStore,
      requestContext,
      access: {
        async request() {
          return { merchant: 'merchant', owner: 'api-key:alice' };
        },
        async read() {
          return true;
        },
        async isRequester() {
          return false;
        },
        async decide() {
          return true;
        },
      },
    });
    const open = () =>
      createBureau({
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
    const first = await open();
    const worker = await contribution.attachWorker(
      {
        tasks: first.tasks,
        internals: first.internals,
        reviews: first.reviews,
        events: first,
        async requestContext() {
          return requestContext();
        },
      },
      () => {},
    );
    try {
      await worker.idle();
      const admitted = await ledger.get(refund.id);
      const reviewId = admitted?.reviewId;
      if (!reviewId) throw new Error('Missing review');
      const second = await open();
      try {
        await waitForCondition(async () => !!(await second.reviews.get(reviewId)), {
          label: 'peer sees refund review',
        });
        await second.reviews.resolve({
          id: reviewId,
          decision: 'deny',
          round: 0,
          principal: 'api-key:reviewer',
          reviewer: principalFromApiKey({ subject: 'reviewer', scopes: [] }),
        });
        await waitForCondition(
          async () => {
            const balance = await ledger.balance('merchant', 'order');
            return balance?.reserved === 0;
          },
          { label: 'durable release of refund reservation' },
        );
        expect(await ledger.get(refund.id)).toMatchObject({ status: 'failed' });
      } finally {
        await second.dispose();
      }
    } finally {
      await worker.dispose();
      await first.dispose();
    }
  });
  it('restores the same signed review after rebuilding the host and approval store', async () => {
    const storage = new MemoryStorage();
    const ledger = createRefundLedger(storage);
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
      commandId: 'restart',
      order: 'order',
      amount: 4200,
      toolRevision: '1.1.0',
      owner: 'api-key:alice',
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
    const access = {
      async request() {
        return { merchant: 'merchant', owner: 'api-key:alice' };
      },
      async read() {
        return true;
      },
      async isRequester(
        principal: Parameters<import('./refund-operations.ts').RefundAccess['isRequester']>[0],
      ) {
        return principal.method === 'api-key' && principal.subject === 'alice';
      },
      async decide() {
        return true;
      },
    };
    const compose = () => {
      const approvalStateStore = durableApprovalStore(storage);
      const tool = createAdmittedRefundTool(ledger, createFakeProcessor(storage), () => 100);
      const toolbox = createToolbox([tool], {
        approvalSecret: 'fixture-secret',
        approvalStateStore,
      });
      return reviewedRefundContribution({
        ledger,
        toolbox,
        toolId: tool.id,
        approvalStateStore,
        requestContext,
        access,
      });
    };
    const open = (contribution: ReturnType<typeof compose>) =>
      createBureau({
        id: 'refund-restart',
        storage,
        durable: true,
        agents: contribution.agents,
        reviewPolicy: contribution.reviewPolicy,
        requestAuthorityValidator: () => true,
        assets: { storage: createMemoryAssetStorage() },
      });
    const firstContribution = compose();
    const first = await open(firstContribution);
    const worker = await firstContribution.attachWorker(
      {
        tasks: first.tasks,
        internals: first.internals,
        events: first,
        reviews: first.reviews,
        async requestContext() {
          return requestContext();
        },
      },
      () => {},
    );
    let reviewId: string;
    let token: string | undefined;
    try {
      await worker.idle();
      const stored = await ledger.get(refund.id);
      if (!stored?.reviewId) throw new Error('Missing review');
      reviewId = stored.reviewId;
      const review = await first.reviews.get(reviewId);
      if (!review || review.kind !== 'tool-approval') throw new Error('Missing approval');
      token = review.approval.approvalToken;
      expect(token).toBeDefined();
    } finally {
      await worker.dispose();
      await first.dispose();
    }
    const secondContribution = compose();
    const second = await open(secondContribution);
    try {
      await waitForCondition(() => second.reviews.list().some((review) => review.id === reviewId), {
        label: 'restored refund review',
      });
      const restored = await second.reviews.get(reviewId);
      expect(restored).toMatchObject({
        id: reviewId,
        kind: 'tool-approval',
        approval: { approvalToken: token },
      });
      expect(await ledger.find('merchant', 'restart').then((value) => value?.id)).toBe(refund.id);
      await second.reviews.resolve({
        id: reviewId,
        decision: 'approve',
        round: 0,
        principal: 'api-key:reviewer',
        reviewer: principalFromApiKey({ subject: 'reviewer', scopes: [] }),
      });
      expect(await ledger.get(refund.id).then((value) => value?.status)).toBe('provider-pending');
      expect(await createFakeProcessor(storage).submissions()).toBe(1);
    } finally {
      await second.dispose();
    }
  });
  it('starts the reserved reviewed task and links the real Bureau review', async () => {
    const storage = new MemoryStorage();
    const ledger = createRefundLedger(storage);
    await ledger.addCharge({
      merchant: 'merchant',
      order: 'order',
      amount: 10000,
      currency: 'USD',
      paymentReference: 'charge',
      providerAccount: 'account',
    });
    const processor = createFakeProcessor(new MemoryStorage());
    const tool = createAdmittedRefundTool(ledger, processor, () => 100);
    const approvalStateStore = durableApprovalStore(storage);
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
        async request() {
          return { merchant: 'merchant', owner: 'api-key:alice' };
        },
        async read() {
          return true;
        },
        async isRequester(principal) {
          return principal.method === 'api-key' && principal.subject === 'alice';
        },
        async decide() {
          return true;
        },
      },
    });
    let requesterAuthorized = true;
    let now = Date.now();
    const bureau = await createBureau({
      id: 'refund-fixture',
      storage,
      durable: true,
      runtime: {
        ...createDefaultRuntimeServices(),
        clock: { now: () => now, nowISO: () => new Date(now).toISOString() },
      },
      agents: contribution.agents,
      reviewPolicy: contribution.reviewPolicy,
      requestAuthorityValidator: () => requesterAuthorized,
      assets: { storage: createMemoryAssetStorage() },
    });
    const unreadyHandler = createBureauHandler(bureau, {
      operations: contribution.operations,
      authenticateRequest: async () => ({
        method: 'api-key',
        principal: principalFromApiKey({ subject: 'alice', scopes: [] }),
      }),
    });
    const unready = await unreadyHandler(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'demo.refunds.request',
          params: { commandId: 'not-ready', orderId: 'order', cents: 1000 },
        }),
      }),
    );
    expect(await unready.json()).toHaveProperty('error');
    expect(await ledger.find('merchant', 'not-ready')).toBeUndefined();
    const unsupported = await createBureau({
      storage: new MemoryStorage(),
      durable: true,
      durableOwnership: { ownership: 'none' },
      agents: contribution.agents,
    });
    try {
      expect(
        await throwingRejectionOf(
          contribution.attachWorker(
            {
              tasks: unsupported.tasks,
              internals: unsupported.internals,
              reviews: unsupported.reviews,
              events: unsupported,
              requestContext: async () => requestContext(),
            },
            () => {},
          ),
        ),
      ).toThrow('workflow-lease');
    } finally {
      await unsupported.dispose();
    }
    const workerGate = Promise.withResolvers<void>();
    const worker = await contribution.attachWorker(
      {
        tasks: bureau.tasks,
        internals: bureau.internals,
        events: bureau,
        reviews: bureau.reviews,
        async requestContext() {
          await workerGate.promise;
          return requestContext();
        },
      },
      () => {},
    );
    try {
      const handler = createBureauHandler(bureau, {
        operations: contribution.operations,
        reviewEffects: contribution.reviewEffects,
        mcp: {},
        authenticateRequest: async (request) => {
          const subject =
            request.headers.get('cookie') === 'session=reviewer' ? 'reviewer' : 'alice';
          return {
            method: 'api-key',
            principal: principalFromApiKey({
              subject,
              scopes: ['bureau.reviews:read', 'bureau.reviews:resolve'],
            }),
          };
        },
      });
      const rpc = async (method: string, params: unknown, cookie = 'session=alice') => {
        const response = await handler(
          new Request('http://localhost/jsonrpc', {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          }),
        );
        return (await response.json()) as { result?: Record<string, unknown>; error?: unknown };
      };
      const accepted = await rpc('demo.refunds.request', {
        commandId: 'command',
        orderId: 'order',
        cents: 4200,
      });
      const refundId = accepted.result?.['refundId'];
      if (typeof refundId !== 'string') throw new Error('Refund request was not admitted');
      expect(await ledger.getStart(refundId).then((value) => value?.status)).toBe('pending');
      expect(bureau.reviews.list()).toHaveLength(0);
      workerGate.resolve();
      await worker.idle();
      const recorded = await ledger.get(refundId);
      expect(recorded?.reviewId).toBe(`approval:${recorded?.existingRunId}:reviewed-call`);
      expect(await bureau.reviews.get(recorded!.reviewId!)).toMatchObject({
        kind: 'tool-approval',
        runId: recorded!.existingRunId,
      });
      const detail = await rpc(
        'bureau.reviews.get',
        { id: recorded!.reviewId },
        'session=reviewer',
      );
      expect(detail.result).toMatchObject({
        effect: { kind: 'refund', refundId, cents: 4200, currency: 'USD' },
      });
      expect(JSON.stringify(detail)).not.toContain('approvalToken');
      expect(
        await rpc('bureau.reviews.resolve', {
          id: recorded!.reviewId,
          decision: 'approve',
          round: 0,
        }).then((value) => value.error),
      ).toBeDefined();
      const client = new Client({ name: 'refund-fixture', version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
          fetch: (url, init) => {
            const request = new Request(url, init);
            request.headers.set('cookie', 'session=alice');
            return handler(request);
          },
        }),
      );
      try {
        const rejected = await client.callTool({
          name: 'bureau.reviews.resolve',
          arguments: { id: recorded!.reviewId, decision: 'approve', round: 0 },
        });
        expect(rejected.isError).toBe(true);
        const read = await client.callTool({ name: 'demo.refunds.get', arguments: { refundId } });
        expect(read.structuredContent).toMatchObject({
          refundId,
          reviewId: recorded!.reviewId,
          status: 'awaiting-approval',
        });
      } finally {
        await client.close();
      }
      expect(
        await rpc(
          'bureau.reviews.resolve',
          { id: recorded!.reviewId, decision: 'approve', round: 0, remember: true },
          'session=reviewer',
        ).then((value) => value.error),
      ).toBeDefined();
      expect(
        await rpc(
          'bureau.reviews.resolve',
          { id: recorded!.reviewId, decision: 'reject', round: 0 },
          'session=reviewer',
        ).then((value) => value.error),
      ).toBeDefined();
      expect(
        await rpc(
          'bureau.reviews.resolve',
          { id: recorded!.reviewId, decision: 'deny', round: 1 },
          'session=reviewer',
        ).then((value) => value.error),
      ).toBeDefined();
      expect(
        await rpc(
          'bureau.reviews.resolve',
          { id: recorded!.reviewId, decision: 'deny', round: 0 },
          'session=reviewer',
        ).then((value) => value.result),
      ).toMatchObject({ receipt: 'applied' });
      await worker.idle();
      expect(await ledger.balance('merchant', 'order')).toMatchObject({ reserved: 0 });
      const approvedRequest = await rpc('demo.refunds.request', {
        commandId: 'second',
        orderId: 'order',
        cents: 3200,
      });
      const approvedId = approvedRequest.result?.['refundId'];
      if (typeof approvedId !== 'string') throw new Error('Second refund was not admitted');
      await worker.idle();
      const approvedRecord = await ledger.get(approvedId);
      const approvedReviewId = approvedRecord?.reviewId;
      if (!approvedReviewId) throw new Error('Second review not found');
      requesterAuthorized = false;
      expect(
        await rpc(
          'bureau.reviews.resolve',
          { id: approvedReviewId, decision: 'approve', round: 0 },
          'session=reviewer',
        ).then((value) => value.error),
      ).toBeDefined();
      expect(await processor.submissions()).toBe(0);
      requesterAuthorized = true;
      const firstApproval = await rpc(
        'bureau.reviews.resolve',
        { id: approvedReviewId, decision: 'approve', round: 0 },
        'session=reviewer',
      );
      expect(firstApproval.result).toMatchObject({ receipt: 'superseded' });
      expect(await processor.submissions()).toBe(0);
      expect(
        await rpc(
          'bureau.reviews.resolve',
          { id: approvedReviewId, decision: 'approve', round: 0 },
          'session=reviewer',
        ).then((value) => value.error),
      ).toBeDefined();
      expect(
        await rpc(
          'bureau.reviews.resolve',
          { id: approvedReviewId, decision: 'approve', round: 1 },
          'session=reviewer',
        ).then((value) => value.result),
      ).toMatchObject({ receipt: 'applied' });
      expect(await processor.submissions()).toBe(1);
      const rejectedRequest = await rpc('demo.refunds.request', {
        commandId: 'third',
        orderId: 'order',
        cents: 1000,
      });
      const rejectedId = rejectedRequest.result?.['refundId'];
      if (typeof rejectedId !== 'string') throw new Error('Third refund was not admitted');
      await worker.idle();
      const rejectedReviewId = await ledger.get(rejectedId).then((value) => value?.reviewId);
      if (!rejectedReviewId) throw new Error('Third review not found');
      expect(
        await rpc(
          'bureau.reviews.resolve',
          { id: rejectedReviewId, decision: 'reject', reason: 'Wrong order', round: 0 },
          'session=reviewer',
        ).then((value) => value.result),
      ).toMatchObject({ receipt: 'applied', feedback: 'Wrong order' });
      await worker.idle();
      expect(await ledger.get(rejectedId)).toMatchObject({ status: 'failed' });
      expect(await processor.submissions()).toBe(1);
      now += 48 * 60 * 60 * 1000;
      const expiredReceipt = await bureau.tasks.receipt({
        principal: 'api-key:alice',
        commandId: approvedId,
        agentName: 'reviewed:demo-refund',
      });
      expect(expiredReceipt.status).toBe('expired');
      expect(
        await rpc('demo.refunds.request', {
          commandId: 'second',
          orderId: 'order',
          cents: 3200,
        }).then((value) => value.result),
      ).toMatchObject({ refundId: approvedId });
    } finally {
      workerGate.resolve();
      await worker.dispose();
      await bureau.dispose();
    }
  });
  it('contributes the demo operations with a signed reviewed agent and allowlisted effect', () => {
    const ledger = createRefundLedger(new MemoryStorage());
    const tool = createAdmittedRefundTool(
      ledger,
      createFakeProcessor(new MemoryStorage()),
      () => 100,
    );
    const approvalStateStore = createProcessLocalApprovalStateStore();
    const toolbox = createToolbox([tool], { approvalSecret: 'fixture-secret', approvalStateStore });
    const contribution = reviewedRefundContribution({
      ledger,
      toolbox,
      toolId: tool.id,
      approvalStateStore,
      requestContext: () => ({
        authority: {
          principalId: 'fixture',
          tenantId: 'fixture',
          ownerId: 'fixture',
          capabilities: [],
          authorizationRevision: '1',
        },
      }),
      access: {
        async request() {
          return undefined;
        },
        async read() {
          return false;
        },
        async isRequester() {
          return false;
        },
        async decide() {
          return false;
        },
      },
    });
    expect(contribution.operations.map((operation) => operation.name)).toEqual([
      'demo.refunds.request',
      'demo.refunds.get',
    ]);
    expect(Object.keys(contribution.agents)).toEqual(['reviewed:demo-refund']);
    expect(contribution.reviewEffects).toEqual([]);
  });
  it('signs the pinned refund instruction through the selected toolbox', async () => {
    const ledger = createRefundLedger(new MemoryStorage());
    await ledger.addCharge({
      merchant: 'merchant',
      order: 'order',
      amount: 10000,
      currency: 'USD',
      paymentReference: 'private-charge',
      providerAccount: 'private-account',
    });
    const refund = await ledger.admit({
      merchant: 'merchant',
      commandId: 'command',
      order: 'order',
      amount: 4200,
      toolRevision: '1.1.0',
      owner: 'alice',
    });
    const start = await ledger.claimStart(refund.id);
    const tool = createAdmittedRefundTool(
      ledger,
      createFakeProcessor(new MemoryStorage()),
      () => 100,
    );
    const approvalStateStore = createProcessLocalApprovalStateStore();
    const toolbox = createToolbox([tool], { approvalSecret: 'fixture-secret', approvalStateStore });
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
        async request() {
          return { merchant: 'merchant', owner: 'alice' };
        },
        async read() {
          return true;
        },
        async isRequester(principal) {
          return principal.method === 'api-key' && principal.subject === 'alice';
        },
        async decide() {
          return true;
        },
      },
    });
    const agent = contribution.agents['reviewed:demo-refund'];
    if (!agent || !hasDefinitionResolver(agent)) throw new Error('Missing reviewed agent');
    const resolved = await agent[OPERATIVE_RESOLVE_RUN_OPTIONS]('probe', {
      agentName: 'reviewed:demo-refund',
      runId: start.runId,
      principal: 'alice',
    });
    if (!resolved.toolbox) throw new Error('Missing reviewed toolbox');
    const result = await resolved.toolbox.execute(
      {
        id: 'reviewed-call',
        name: tool.id,
        arguments: { commandId: refund.id, orderId: 'order', cents: 4200, currency: 'USD' },
      },
      {
        requestContext: {
          ...requestContext(),
          runId: start.runId,
          agentId: 'reviewed:demo-refund',
          audience: 'tenant',
        },
      },
    );
    expect(result).toMatchObject({
      outcome: 'action_required',
      pendingApproval: {
        arguments: { refundId: refund.id, orderId: 'order', cents: 4200, currency: 'USD' },
      },
    });
    if (!result.pendingApproval) throw new Error('Missing signed approval');
    expect(verifyToolboxPendingApproval(toolbox, result.pendingApproval).arguments).toEqual({
      refundId: refund.id,
      orderId: 'order',
      cents: 4200,
      currency: 'USD',
    });
    const review = {
      kind: 'tool-approval' as const,
      id: `approval:${start.runId}:reviewed-call`,
      runId: start.runId,
      sessionId: start.sessionId,
      agentName: 'reviewed:demo-refund',
      approval: result.pendingApproval,
      requestedAt: 0,
      ageMilliseconds: 0,
      status: 'pending' as const,
      round: 0,
    };
    expect(
      await contribution.reviewPolicy.mayDecide(
        review,
        principalFromApiKey({ subject: 'alice', scopes: [] }),
      ),
    ).toBe(false);
    expect(
      await contribution.reviewPolicy.mayDecide(
        review,
        principalFromApiKey({ subject: 'reviewer', scopes: [] }),
      ),
    ).toBe(true);
    expect(await contribution.reviewPolicy.effect?.(review)).toEqual({
      kind: 'refund',
      refundId: refund.id,
      orderId: 'order',
      cents: 4200,
      currency: 'USD',
      status: 'admitted',
    });
    expect(await ledger.get(refund.id)).toMatchObject({ status: 'admitted' });
  });
  it('admits before review, reauthorizes replays, and hides other owners', async () => {
    const storage = new MemoryStorage();
    const ledger = createRefundLedger(storage);
    await ledger.addCharge({
      merchant: 'merchant',
      order: 'order',
      amount: 10000,
      currency: 'USD',
      paymentReference: 'secret-charge',
      providerAccount: 'secret-account',
    });
    const operations = refundOperations(ledger, {
      async request(principal) {
        return principal.method === 'api-key' && principal.subject === 'alice'
          ? { merchant: 'merchant', owner: 'alice' }
          : undefined;
      },
      async read(principal, refund) {
        return principal.method === 'api-key' && principal.subject === refund.owner;
      },
      async isRequester() {
        return false;
      },
      async decide() {
        return false;
      },
    });
    const bureau = await createBureau({
      agents: { default: createAgent({ generate: async () => ({ content: '', toolCalls: [] }) }) },
      assets: { storage: createMemoryAssetStorage() },
    });
    try {
      const snapshot = createBureauCatalogSnapshot(operations);
      expect(JSON.stringify(snapshot)).toContain('demo.refunds.request');
      const handler = createBureauHandler(bureau, {
        operations,
        authenticateRequest: async (request) => {
          const subject = request.headers.get('x-actor');
          return subject
            ? { method: 'api-key', principal: principalFromApiKey({ subject, scopes: [] }) }
            : new Response(null, { status: 401 });
        },
      });
      const rpc = async (actor: string, method: string, params: unknown) => {
        const response = await handler(
          new Request('http://localhost/jsonrpc', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-actor': actor },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          }),
        );
        return (await response.json()) as {
          result?:
            | { accepted: true; refundId: string }
            | {
                refundId: string;
                orderId: string;
                cents: number;
                currency: string;
                status: string;
              };
          error?: { message: string };
        };
      };
      const input = { commandId: 'command', orderId: 'order', cents: 4200 };
      const first = await rpc('alice', 'demo.refunds.request', input);
      expect(first.result).toEqual({ accepted: true, refundId: expect.any(String) });
      if (!first.result) throw new Error('Refund was not admitted');
      const id = first.result.refundId;
      expect(await ledger.getStart(id)).toMatchObject({ status: 'pending', refundId: id });
      expect(
        await rpc('alice', 'demo.refunds.request', input).then((value) => value.result),
      ).toEqual(first.result);
      expect(
        await rpc('alice', 'demo.refunds.request', { ...input, cents: 4100 }).then(
          (value) => value.error,
        ),
      ).toBeDefined();
      expect(
        await rpc('bob', 'demo.refunds.request', input).then((value) => value.error),
      ).toBeDefined();
      expect(
        await rpc('bob', 'demo.refunds.get', { refundId: id }).then((value) => value.error),
      ).toBeDefined();
      const read = await rpc('alice', 'demo.refunds.get', { refundId: id });
      expect(read.result).toEqual({
        refundId: id,
        orderId: 'order',
        cents: 4200,
        currency: 'USD',
        status: 'admitted',
      });
      expect(JSON.stringify(read)).not.toContain('secret');
    } finally {
      await bureau.dispose();
    }
  });
});
