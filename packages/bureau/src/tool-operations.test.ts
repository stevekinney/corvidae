import { describe, expect, it } from 'bun:test';
import {
  approvalOnlyPolicy,
  createProcessLocalApprovalStateStore,
  createTool,
  createToolbox,
  validateApprovalBinding,
  type ApprovalStateStore,
  type ApprovalBindingPayload,
} from 'armorer';
import { z } from 'zod';
import { reviewedToolOperations, type ReviewedToolSelection } from './tool-operations.ts';
import { createBureauCatalogSnapshot } from './http/bureau-catalog-snapshot.ts';
import { createBureau } from './create-bureau.ts';
import { createMemoryAssetStorage } from './assets/storage';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import { principalFromApiKey, type Principal } from '@lostgradient/backchannel';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { createBureauHandler } from './http/create-bureau-handler.ts';
import { callJsonRpc } from '@lostgradient/backchannel/client';
import { createOperationClientSources } from '@lostgradient/backchannel/generator';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { waitForCondition } from './test';
import type { Storage } from '@lostgradient/storage';
import { hasDefinitionResolver, OPERATIVE_RESOLVE_RUN_OPTIONS } from '@lostgradient/operative';
import { TASK_RECORD_KEY_PREFIX } from './task-registry';

/** A fixture store whose atomic transitions persist across independently constructed toolboxes. */
function durableApprovalStore(storage: Storage): ApprovalStateStore {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const key = (binding: Pick<ApprovalBindingPayload, 'nonce' | 'replayScope'>) =>
    `fixture-approval:${encodeURIComponent(binding.replayScope)}:${encodeURIComponent(binding.nonce)}`;
  const read = async (binding: Pick<ApprovalBindingPayload, 'nonce' | 'replayScope'>) => {
    const bytes = await storage.get(key(binding));
    return bytes === null
      ? undefined
      : {
          bytes,
          value: JSON.parse(decoder.decode(bytes)) as {
            state: string;
            binding: ApprovalBindingPayload;
          },
        };
  };
  const transition = async (
    binding: Pick<ApprovalBindingPayload, 'nonce' | 'replayScope'>,
    from: readonly string[],
    to: string,
  ) => {
    const entry = await read(binding);
    if (!entry || !from.includes(entry.value.state)) throw new Error('Approval state conflict');
    const updated = encoder.encode(JSON.stringify({ ...entry.value, state: to }));
    if (
      !(await storage.conditionalBatch!(
        [{ key: key(binding), expectedValue: entry.bytes }],
        [{ type: 'put', key: key(binding), value: updated }],
      ))
    )
      throw new Error('Approval state conflict');
  };
  const store: ApprovalStateStore = {
    async issue(binding) {
      validateApprovalBinding(binding);
      const value = encoder.encode(JSON.stringify({ state: 'issued', binding }));
      if (
        !(await storage.conditionalBatch!(
          [{ key: key(binding), expectedValue: null }],
          [{ type: 'put', key: key(binding), value }],
        ))
      )
        throw new Error('Approval already issued');
    },
    async reserve(binding, context, now) {
      validateApprovalBinding(binding, context, now);
      const entry = await read(binding);
      if (
        !entry ||
        JSON.stringify(
          Object.entries(entry.value.binding).toSorted(([a], [b]) => a.localeCompare(b)),
        ) !== JSON.stringify(Object.entries(binding).toSorted(([a], [b]) => a.localeCompare(b)))
      )
        throw new Error('Approval binding mismatch');
      await transition(binding, ['issued'], 'reserved');
    },
    async commit(binding) {
      await transition(binding, ['reserved'], 'consumed');
    },
    async release(binding) {
      const entry = await read(binding);
      if (entry && ['reserved', 'consumed'].includes(entry.value.state))
        await transition(binding, [entry.value.state], 'issued');
    },
    async consume(binding, context, now) {
      await store.reserve(binding, context, now);
      await store.commit(binding);
    },
    async revoke(binding) {
      await transition(binding, ['issued', 'reserved'], 'revoked');
    },
    async state(binding) {
      const entry = await read(binding);
      return entry && entry.value.state !== 'reserved'
        ? (entry.value.state as 'issued' | 'consumed' | 'revoked')
        : undefined;
    },
  };
  return store;
}

describe('reviewedToolOperations', () => {
  it('parks and resumes the original signed inventory call under its native policy', async () => {
    const storageFixture = createSqliteStorageFixture();
    let storage = storageFixture.storage;
    let store = durableApprovalStore(storage);
    const calls: unknown[] = [];
    const tool = createTool({
      namespace: 'inventory',
      name: 'adjust',
      version: '1.0.0',
      description: 'Adjust stock',
      input: z.strictObject({ intentId: z.string(), itemId: z.string() }),
      metadata: { mutates: true },
      policy: approvalOnlyPolicy((context) => ({
        decision: 'approval',
        reason: `review ${(context.params as { intentId: string }).intentId}`,
      })),
      execute: async (args) => {
        calls.push(args);
        return { itemId: args.itemId, providerSecret: 'private:provider' };
      },
    });
    let toolbox = createToolbox([tool], {
      approvalSecret: 'fixture-secret',
      approvalStateStore: store,
      approvalPolicy: { mode: 'always' },
    });
    await toolbox.issueGrant({
      principalId: 'requester',
      tenantId: 'fixture',
      ownerId: 'fixture',
      agentId: 'reviewed:inventory-adjust',
      toolName: tool.id,
      scope: 'principal',
      expiresAt: Number.MAX_SAFE_INTEGER,
      maxUses: 5,
      delegationBehavior: 'does-not-propagate',
    });
    const intentRuns = new Set<string>();
    const intentKey = (runId: string) => `fixture-intent:${runId}`;
    const readIntent = async (runId: string) => {
      const bytes = await storage.get(intentKey(runId));
      if (!bytes) throw new Error('Missing intent');
      return JSON.parse(new TextDecoder().decode(bytes)) as { intentId: string; itemId: string };
    };
    let preparations = 0;
    let releasePreparation!: () => void;
    let reportPreparation!: (runId: string) => void;
    const preparationGate = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const preparationReached = new Promise<string>((resolve) => {
      reportPreparation = resolve;
    });
    const selection: ReviewedToolSelection = {
      tool: tool.id,
      agent: 'inventory-adjust',
      request: 'inventory.adjust.request',
      get: 'inventory.adjust.get',
      intentId: 'intentId',
      outputSchema: z.strictObject({ itemId: z.string() }),
      effectSchema: z.strictObject({ kind: z.literal('inventory'), itemId: z.string() }),
      intents: {
        prepare: async ({ runId, arguments: args }) => {
          preparations++;
          const intent = { intentId: `private:${runId}`, itemId: String(args['itemId']) };
          const bytes = new TextEncoder().encode(JSON.stringify(intent));
          if (
            !(await storage.conditionalBatch!(
              [{ key: intentKey(runId), expectedValue: null }],
              [{ type: 'put', key: intentKey(runId), value: bytes }],
            ))
          )
            return readIntent(runId);
          intentRuns.add(runId);
          reportPreparation(runId);
          await preparationGate;
          return intent;
        },
        readRun: async ({ runId }) => {
          const intent = await readIntent(runId);
          return { itemId: intent.itemId };
        },
        read: async () => ({ itemId: 'one' }),
        effect: async (review) => {
          const intent = await readIntent(review.runId);
          return { kind: 'inventory', itemId: intent.itemId };
        },
      },
      access: {
        requestScopes: ['inventory:write'],
        readScopes: ['inventory:read'],
        mayRead: () => true,
        mayDecide: (_review, principal) =>
          principal.method === 'api-key' && principal.subject === 'reviewer',
      },
      mcpExposable: true,
    };
    const options = () => ({
      approvalStateStore: store,
      requestContext: (principal: Principal) => ({
        authority: {
          principalId: principal.method === 'api-key' ? (principal.subject ?? '') : '',
          tenantId: 'fixture',
          ownerId: 'fixture',
          capabilities: [],
          authorizationRevision: '1',
        },
      }),
    });
    let contribution = reviewedToolOperations(toolbox, [selection], options());
    const diagnostics: string[] = [];
    const open = (enabled: boolean) =>
      createBureau({
        id: 'inventory-test',
        agents: enabled ? contribution.agents : {},
        ...(enabled ? { reviewPolicy: contribution.reviewPolicy } : {}),
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
        requestAuthorityValidator: () => true,
        storage,
        durable: true,
        assets: { storage: createMemoryAssetStorage() },
      });
    let bureau = await open(true);
    try {
      const makeHandler = (instance: typeof bureau) =>
        createBureauHandler(instance, {
          operations: contribution.operations,
          reviewEffects: contribution.reviewEffects,
          agUi: {},
          mcp: {},
          authenticateRequest: async (request) => ({
            method: 'api-key',
            principal: principalFromApiKey({
              subject: request.headers.get('x-actor') ?? 'requester',
              scopes: [
                'inventory:write',
                'inventory:read',
                'bureau.reviews:read',
                'bureau.reviews:resolve',
              ],
            }),
          }),
        });
      let handler = makeHandler(bureau);
      const rpc = async (method: string, params: unknown, actor = 'requester') => {
        const response = await handler(
          new Request('http://localhost/jsonrpc', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-actor': actor },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          }),
        );
        return (await response.json()) as { result?: Record<string, unknown>; error?: unknown };
      };
      const requests = Promise.all([
        rpc(selection.request, { commandId: 'one', itemId: 'one' }),
        rpc(selection.request, { commandId: 'one', itemId: 'one' }),
      ]);
      const liveRunId = await preparationReached;
      try {
        const liveEvents = await handler(
          new Request(
            `http://localhost/v1/subscriptions/operative.runs.events?runId=${encodeURIComponent(liveRunId)}`,
            { headers: { accept: 'text/event-stream' } },
          ),
        );
        expect(liveEvents.status).toBe(404);
        const liveStream = await handler(
          new Request(`http://localhost/ag-ui/runs/${liveRunId}`, {
            headers: { accept: 'text/event-stream' },
          }),
        );
        const liveText = await liveStream.text();
        expect(liveText).toContain('RUN_NOT_FOUND');
        expect(liveText).not.toContain('private:');
      } finally {
        releasePreparation();
      }
      const [requested, concurrent] = await requests;
      expect([...intentRuns]).toHaveLength(1);
      expect(requested).toMatchObject({ result: { itemId: 'one' } });
      expect(concurrent).toMatchObject({ result: { itemId: 'one' } });
      const replay = await rpc(selection.request, { commandId: 'one', itemId: 'one' });
      expect(replay.result).toEqual({
        itemId: 'one',
      });
      const mismatchedReplay = await rpc(selection.request, { commandId: 'one', itemId: 'other' });
      expect(mismatchedReplay.error).toBeDefined();
      expect(preparations).toBe(1);
      const agent = contribution.agents['reviewed:inventory-adjust']!;
      if (!hasDefinitionResolver(agent)) throw new Error('Missing reviewed agent resolver');
      const resolved = await agent[OPERATIVE_RESOLVE_RUN_OPTIONS]('probe', {
        agentName: 'reviewed:inventory-adjust',
        runId: 'scalar-probe',
        principal: 'api-key:requester',
      });
      if (!resolved.toolbox) throw new Error('Missing reviewed toolbox');
      const observed: unknown[] = [];
      const unsubscribe = resolved.toolbox.addEventListener('validate-success', (event) => {
        observed.push(event);
      });
      const subscription = resolved.toolbox
        .toObservable()
        .subscribe((event) => observed.push(event));
      const scalar = await resolved.toolbox.execute(
        { id: 'scalar', name: tool.id, arguments: { commandId: 'scalar', itemId: 'one' } },
        {
          requestContext: {
            ...options().requestContext(principalFromApiKey({ subject: 'requester', scopes: [] })),
            runId: 'scalar-probe',
            agentId: 'reviewed:inventory-adjust',
            audience: 'tenant',
          },
        },
      );
      expect(scalar).toMatchObject({
        outcome: 'action_required',
        pendingApproval: { arguments: { intentId: 'private:scalar-probe', itemId: 'one' } },
      });
      expect(observed).toEqual([]);
      unsubscribe();
      subscription.unsubscribe();
      expect(
        await rejectionOf(
          bureau.tasks.start('reviewed:inventory-adjust', '{}', { principal: 'api-key:requester' }),
        ),
      ).toBeInstanceOf(Error);
      const [review] = bureau.reviews.list();
      expect(review?.kind).toBe('tool-approval');
      if (!review || review.kind !== 'tool-approval') throw new Error('Missing approval');
      expect(review.approval.approvalToken).toBeDefined();
      const taskRecord = await bureau.internals.taskRegistry.record(review.runId);
      expect(taskRecord?.origin).toMatchObject({
        reviewedTool: { tool: tool.id },
      });
      expect(await bureau.internals.reviewedRunState(review.runId)).toBe('verified');
      expect(review.approval.approvalBinding).toMatchObject({
        principalId: 'requester',
        tenantId: 'fixture',
        ownerId: 'fixture',
        agentId: 'reviewed:inventory-adjust',
      });
      const signedArguments = structuredClone(review.approval.arguments);
      const detail = await rpc('bureau.reviews.get', { id: review.id });
      expect(detail.result).toMatchObject({
        approval: { arguments: { itemId: 'one' } },
        effect: { kind: 'inventory', itemId: 'one' },
      });
      expect(JSON.stringify(detail)).not.toContain('private:');
      const parkedSession = await bureau.internals.sessionStore?.load(review.sessionId);
      expect(parkedSession?.metadata['reviewedApprovalProvenance']).toMatchObject({
        [review.id]: { kind: 'api', reviewedTool: { tool: tool.id } },
      });
      for (const method of ['bureau.tasks.get', 'bureau.tasks.inspect']) {
        const taskView = await rpc(method, { taskId: review.runId });
        expect(taskView.result).toBeDefined();
        expect(JSON.stringify(taskView)).not.toContain('private:');
        expect(JSON.stringify(taskView)).not.toContain(review.approval.approvalToken!);
      }
      const jsonClient = await callJsonRpc({
        endpoint: 'http://localhost/jsonrpc',
        method: selection.get,
        id: 'get',
        params: { intentId: 'one' },
        fetch: (url, init) => handler(new Request(url, init)),
      });
      expect(jsonClient.ok).toBe(true);
      if (!jsonClient.ok) throw new Error('JSON-RPC read failed');
      const mcp = new Client({ name: 'inventory-fixture', version: '1.0.0' });
      await mcp.connect(
        new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
          fetch: (url, init) => handler(new Request(url, init)),
        }),
      );
      try {
        const listed = await mcp.listTools();
        const tools = listed.tools.filter((entry) => entry.name === selection.request);
        expect(tools).toHaveLength(1);
        expect(Object.keys(tools[0]!.inputSchema.properties ?? {}).toSorted()).toEqual([
          'commandId',
          'itemId',
        ]);
        const read = await mcp.callTool({ name: selection.get, arguments: { intentId: 'one' } });
        expect(jsonClient.result).toEqual({ itemId: 'one' });
        expect(read.structuredContent).toEqual(jsonClient.result);
      } finally {
        await mcp.close();
      }
      const stream = await handler(
        new Request(`http://localhost/ag-ui/runs/${review.runId}`, {
          headers: { accept: 'text/event-stream' },
        }),
      );
      const transcript = await stream.text();
      expect(stream.status).toBe(200);
      expect(transcript).toContain('itemId');
      expect(transcript).not.toContain('private:');
      expect(transcript).not.toContain(review.approval.approvalToken!);
      const messages = await handler(
        new Request(`http://localhost/ag-ui/threads/${review.sessionId}/messages`),
      );
      const messageText = await messages.text();
      expect(messages.status).toBe(200);
      expect(messageText).toContain('itemId');
      expect(messageText).not.toContain('private:');
      expect(messageText).not.toContain(review.approval.approvalToken!);
      const events = await handler(
        new Request(
          `http://localhost/v1/subscriptions/operative.runs.events?runId=${encodeURIComponent(review.runId)}`,
          { headers: { accept: 'text/event-stream' } },
        ),
      );
      expect(events.status).toBe(200);
      const reader = events.body!.getReader();
      const decoder = new TextDecoder();
      let eventText = '';
      while (!eventText.includes('event: step.completed')) {
        const item = await reader.read();
        if (item.done) break;
        eventText += decoder.decode(item.value, { stream: true });
      }
      await reader.cancel();
      expect(eventText).toContain('event: step.completed');
      expect(eventText).not.toContain('private:');
      expect(eventText).not.toContain(review.approval.approvalToken!);
      const taskEvents = await handler(
        new Request(
          `http://localhost/v1/subscriptions/bureau.tasks.events?taskId=${encodeURIComponent(review.runId)}`,
          { headers: { accept: 'text/event-stream' } },
        ),
      );
      expect(taskEvents.status).toBe(200);
      const taskReader = taskEvents.body!.getReader();
      let taskText = '';
      while (!taskText.includes('input-required')) {
        const item = await taskReader.read();
        if (item.done) break;
        taskText += decoder.decode(item.value, { stream: true });
      }
      await taskReader.cancel();
      expect(taskText).toContain('input-required');
      expect(taskText).not.toContain('private:');
      expect(taskText).not.toContain(review.approval.approvalToken!);
      const kv = bureau.internals.kv;
      if (!kv) throw new Error('Missing task storage');
      const recordKeys = await kv.list(TASK_RECORD_KEY_PREFIX);
      const recordKey = recordKeys.find((key) => key.endsWith(review.runId));
      if (!recordKey) throw new Error('Missing reviewed task record');
      const savedRecord = await kv.get(recordKey);
      if (!savedRecord) throw new Error('Missing reviewed task record content');
      await kv.delete(recordKey);
      expect(await bureau.internals.reviewedProvenance(review)).toBe('unresolved');
      expect(
        (await handler(new Request(`http://localhost/ag-ui/threads/${review.sessionId}/messages`)))
          .status,
      ).toBe(404);
      const missingTaskReview = await rpc('bureau.reviews.get', { id: review.id });
      expect(missingTaskReview.error).toBeDefined();
      await bureau.dispose();
      storage = await storageFixture.reopen();
      store = durableApprovalStore(storage);
      toolbox = createToolbox([tool], {
        approvalSecret: 'fixture-secret',
        approvalStateStore: store,
        approvalPolicy: { mode: 'always' },
      });
      contribution = reviewedToolOperations(toolbox, [selection], options());
      bureau = await open(true);
      handler = makeHandler(bureau);
      expect(await bureau.internals.reviewedProvenance(review)).toBe('unresolved');
      const restartedReview = await rpc('bureau.reviews.get', { id: review.id });
      expect(restartedReview.error).toBeDefined();
      await bureau.internals.kv!.set(recordKey, savedRecord);
      await waitForCondition(
        () => bureau.reviews.list().some((item) => item.id === review.id),
        'review was not restored',
      );
      const restored = bureau.reviews.list().find((item) => item.id === review.id);
      expect(restored?.kind).toBe('tool-approval');
      if (!restored || restored.kind !== 'tool-approval')
        throw new Error('Missing restored review');
      expect(restored.approval.approvalToken).toBe(review.approval.approvalToken);
      expect(await bureau.internals.reviewedRunState(review.runId)).toBe('verified');
      const withoutContribution = await open(false);
      try {
        expect(await withoutContribution.internals.reviewedRunState(review.runId)).toBe(
          'unresolved',
        );
        expect(await withoutContribution.internals.reviewedProvenance(review)).toBe('unresolved');
        expect(
          await rejectionOf(
            withoutContribution.reviews.resolve({
              id: review.id,
              decision: 'approve',
              round: 0,
              principal: 'api-key:reviewer',
              reviewer: principalFromApiKey({ subject: 'reviewer', scopes: [] }),
            }),
          ),
        ).toBeInstanceOf(Error);
        expect(calls).toEqual([]);
        expect(diagnostics.some((message) => message.includes('missing-agent'))).toBe(true);
        const missingHandler = createBureauHandler(withoutContribution, {
          agUi: {},
          mcp: {},
          authenticateRequest: async () => ({
            method: 'api-key',
            principal: principalFromApiKey({
              subject: 'requester',
              scopes: ['bureau.reviews:read', 'bureau.reviews:resolve'],
            }),
          }),
        });
        const hidden = await missingHandler(
          new Request('http://localhost/jsonrpc', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'bureau.reviews.get',
              params: { id: review.id },
            }),
          }),
        );
        const hiddenText = await hidden.text();
        expect(hiddenText).toContain('NotFound');
        expect(hiddenText).not.toContain('private:');
        expect(hiddenText).not.toContain(review.approval.approvalToken!);
        const missingStream = await missingHandler(
          new Request(`http://localhost/ag-ui/runs/${review.runId}`, {
            headers: { accept: 'text/event-stream' },
          }),
        );
        const missingStreamText = await missingStream.text();
        expect(missingStreamText).toContain('RUN_NOT_FOUND');
        expect(missingStreamText).not.toContain('private:');
        expect(missingStreamText).not.toContain(review.approval.approvalToken!);
        const missingMessages = await missingHandler(
          new Request(`http://localhost/ag-ui/threads/${review.sessionId}/messages`),
        );
        expect(missingMessages.status).toBe(404);
        const missingRunEvents = await missingHandler(
          new Request(
            `http://localhost/v1/subscriptions/operative.runs.events?runId=${encodeURIComponent(review.runId)}`,
            { headers: { accept: 'text/event-stream' } },
          ),
        );
        expect(missingRunEvents.status).toBe(404);
        const missingTaskEvents = await missingHandler(
          new Request(
            `http://localhost/v1/subscriptions/bureau.tasks.events?taskId=${encodeURIComponent(review.runId)}`,
            { headers: { accept: 'text/event-stream' } },
          ),
        );
        expect(missingTaskEvents.status).toBe(404);
      } finally {
        await withoutContribution.dispose();
      }
      const replacement = createTool({
        namespace: 'inventory',
        name: 'adjust',
        version: '2.0.0',
        description: 'Adjust stock',
        input: z.strictObject({ intentId: z.string(), itemId: z.string() }),
        metadata: { mutates: true },
        policy: approvalOnlyPolicy(() => ({ decision: 'approval' })),
        execute: async () => ({ itemId: 'wrong' }),
      });
      const staleToolbox = createToolbox([replacement], {
        approvalSecret: 'fixture-secret',
        approvalStateStore: store,
      });
      const stale = reviewedToolOperations(staleToolbox, [{ ...selection, tool: replacement.id }], {
        approvalStateStore: store,
        requestContext: (principal) => ({
          authority: {
            principalId: principal.method === 'api-key' ? (principal.subject ?? '') : '',
            tenantId: 'fixture',
            ownerId: 'fixture',
            capabilities: [],
            authorizationRevision: '1',
          },
        }),
      });
      const staleBureau = await createBureau({
        id: 'inventory-test',
        agents: stale.agents,
        reviewPolicy: stale.reviewPolicy,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
        requestAuthorityValidator: () => true,
        storage,
        durable: true,
        assets: { storage: createMemoryAssetStorage() },
      });
      try {
        expect(await staleBureau.internals.reviewedRunState(review.runId)).toBe('unresolved');
      } finally {
        await staleBureau.dispose();
      }
      const requesterDecision = await rpc('bureau.reviews.resolve', {
        id: review.id,
        decision: 'approve',
        round: 0,
      });
      expect(requesterDecision.error).toBeDefined();
      expect(calls).toEqual([]);
      expect(bureau.reviews.list().find((item) => item.id === review.id)?.status).toBe('pending');
      const rememberedDecision = await rpc(
        'bureau.reviews.resolve',
        { id: review.id, decision: 'approve', round: 0, remember: true },
        'reviewer',
      );
      expect(rememberedDecision.error).toBeDefined();
      expect(bureau.reviews.list().find((item) => item.id === review.id)?.status).toBe('pending');
      expect(
        await rejectionOf(
          bureau.reviews.resolve({
            id: review.id,
            decision: 'approve',
            round: 0,
            principal: 'api-key:reviewer',
            reviewer: principalFromApiKey({ subject: 'reviewer', scopes: [] }),
            arguments: { intentId: 'forged', itemId: 'other' },
          }),
        ),
      ).toBeInstanceOf(Error);
      expect(bureau.reviews.list().find((item) => item.id === review.id)?.status).toBe('pending');
      expect(
        await rpc(
          'bureau.reviews.resolve',
          { id: review.id, decision: 'approve', round: 0 },
          'reviewer',
        ),
      ).toMatchObject({ result: { receipt: 'superseded' } });
      expect(calls).toEqual([]);
      const approved = await rpc(
        'bureau.reviews.resolve',
        { id: review.id, decision: 'approve', round: 1 },
        'reviewer',
      );
      expect(approved.result).toMatchObject({ receipt: 'applied' });
      expect(calls).toEqual([signedArguments]);
      const secondRequest = await rpc(selection.request, { commandId: 'two', itemId: 'two' });
      expect(secondRequest.result).toEqual({
        itemId: 'two',
      });
      const declined = bureau.reviews.list().find((item) => item.id !== review.id);
      if (!declined || declined.kind !== 'tool-approval')
        throw new Error('Missing declined review');
      const denied = await rpc(
        'bureau.reviews.resolve',
        { id: declined.id, decision: 'deny', round: 0 },
        'reviewer',
      );
      expect(denied.result).toMatchObject({ receipt: 'applied' });
      expect(calls).toEqual([signedArguments]);
      const completedResponse = await handler(
        new Request(`http://localhost/ag-ui/threads/${review.sessionId}/messages`),
      );
      const completedMessages = await completedResponse.text();
      expect(completedResponse.status).toBe(200);
      expect(completedMessages).toContain('itemId');
      expect(completedMessages).not.toContain('private:');
      expect(completedMessages).not.toContain(review.approval.approvalToken!);
    } finally {
      await bureau.dispose();
      await storageFixture.dispose();
    }
  });
  it('composes and generates only pinned tools and their declared public contracts', async () => {
    const store = createProcessLocalApprovalStateStore();
    const tool = createTool({
      namespace: 'inventory',
      name: 'adjust',
      version: '1.0.0',
      description: 'Adjust stock',
      input: z.strictObject({ intentId: z.string(), itemId: z.string() }),
      metadata: { mutates: true },
      policy: approvalOnlyPolicy(() => ({ decision: 'approval' })),
      execute: async () => ({}),
    });
    const toolbox = createToolbox([tool], {
      approvalSecret: 'fixture-secret',
      approvalStateStore: store,
    });
    const selection: ReviewedToolSelection = {
      tool: tool.id,
      agent: 'inventory-adjust',
      request: 'inventory.adjust.request',
      get: 'inventory.adjust.get',
      intentId: 'intentId',
      outputSchema: z.strictObject({ itemId: z.string() }),
      effectSchema: z.strictObject({ kind: z.literal('inventory'), itemId: z.string() }),
      intents: {
        prepare: async () => ({}),
        read: async () => ({}),
        readRun: async () => ({}),
        effect: async () => ({}),
      },
      access: {
        requestScopes: ['inventory:write'],
        readScopes: ['inventory:read'],
        mayRead: () => true,
        mayDecide: () => false,
      },
      mcpExposable: true,
    };
    const options = {
      approvalStateStore: store,
      requestContext: () => ({
        authority: {
          principalId: 'fixture',
          tenantId: 'fixture',
          ownerId: 'fixture',
          capabilities: [],
          authorizationRevision: '1',
        },
      }),
    };
    const contribution = reviewedToolOperations(toolbox, [selection], options);
    const snapshot = createBureauCatalogSnapshot(
      contribution.operations,
      contribution.reviewEffects,
    );
    const request = snapshot.operations.find((entry) => entry.name === selection.request);
    expect(request).toMatchObject({
      tags: [tool.id],
      access: { kind: 'scoped', scopes: ['inventory:write'] },
      inputSchema: {
        properties: { commandId: { type: 'string' }, itemId: { type: 'string' } },
        required: ['itemId', 'commandId'],
      },
      outputSchema: { properties: { itemId: { type: 'string' } }, required: ['itemId'] },
    });
    expect(snapshot.operations.find((entry) => entry.name === selection.get)).toMatchObject({
      access: { kind: 'scoped', scopes: ['inventory:read'] },
      inputSchema: { properties: { intentId: { type: 'string' } }, required: ['intentId'] },
      outputSchema: { properties: { itemId: { type: 'string' } }, required: ['itemId'] },
    });
    expect(JSON.stringify(request?.inputSchema)).not.toContain('intentId');
    expect(JSON.stringify(snapshot)).toContain('inventory');
    const generated = await createOperationClientSources(snapshot, {
      packageName: '@fixture/inventory',
      serverName: 'Inventory',
      factoryName: 'createInventory',
      outputDirectory: '.',
      format: async (source) => source,
    });
    expect([...generated.values()].join('\n')).toContain('inventory.adjust.request');
    expect([...generated.values()].join('\n')).toContain('inventory');
    expect(() => reviewedToolOperations(toolbox, [selection, selection], options)).toThrow();
    const unsupported = createTool({
      name: 'unsafe',
      version: '1',
      description: 'Unsafe',
      input: z.object({ intentId: z.string() }),
      policy: { beforeAdmission: () => ({ status: 'needs_input' }) },
      execute: async () => ({}),
    });
    expect(() =>
      reviewedToolOperations(
        createToolbox([unsupported], {
          approvalSecret: 'fixture-secret',
          approvalStateStore: store,
        }),
        [{ ...selection, tool: unsupported.id }],
        options,
      ),
    ).toThrow();
    expect(() =>
      reviewedToolOperations(toolbox, [{ ...selection, tool: 'inventory:adjust@2.0.0' }], options),
    ).toThrow();
  });
});
