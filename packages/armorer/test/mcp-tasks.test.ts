import { afterEach, describe, expect, it, jest } from 'bun:test';
import { z } from 'zod';

import { createTool } from '../src/create-tool';
import { createToolbox } from '../src/create-toolbox';
import {
  createMCP,
  MCP_PROTOCOL_VERSION,
  MCP_TASK_KEY_PREFIX,
  MCPTaskRecordVersionError,
  toMcpTools,
  type CreateMCPOptions,
  type MCPServer,
  type MCPTaskRecord,
} from '../src/integrations/mcp';
import type { Tool } from '../src/is-tool';
import { throwingRejectionOf } from '../src/testing/promise-outcome.test-support';
import { connectInProcessClient } from './fixtures/mcp-in-process-client';
import {
  createStoreDouble,
  deferred,
  rpc,
  TASKS_CAPABILITIES,
  TASKS_EXTENSION,
  type StoreDouble,
  type WireResponse,
} from './fixtures/mcp-task-harness';
import { awakeTurns, quietFor, waitUntil } from './fixtures/wait-until';

/**
 * The 2026-07-28 Tasks extension (`io.modelcontextprotocol/tasks`) served by
 * `createMCP`. Requests are posted as raw JSON-RPC, because the SDK 2.4.0
 * client rejects every `resultType` except `complete` and `input_required`.
 * Wire shapes come from the extension's 2026-07-28 JSON Schema.
 */

const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const METHOD_NOT_FOUND = -32601;

let endpoints: MCPServer[] = [];
afterEach(async () => {
  jest.useRealTimers();
  await Promise.all(endpoints.map((endpoint) => endpoint.close()));
  endpoints = [];
});

type Harness = {
  mcp: MCPServer;
  store: StoreDouble;
  started: () => number;
  release: (value?: string) => void;
  signals: AbortSignal[];
};

function reportTool(
  harness: {
    started: { count: number };
    gate: ReturnType<typeof deferred<string>>;
    signals: AbortSignal[];
  },
  metadata?: Tool['metadata'],
) {
  return createTool({
    name: 'render-report',
    description: 'a long-running tool that runs as an MCP task',
    input: z.object({ title: z.string() }),
    ...(metadata ? { metadata } : {}),
    async execute({ title }, context) {
      harness.started.count += 1;
      if (context.signal) harness.signals.push(context.signal);
      const suffix = await Promise.race([
        harness.gate.promise,
        new Promise<never>((_resolve, reject) => {
          context.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
      ]);
      return `report: ${title}${suffix}`;
    },
  });
}

async function startHarness(
  options: CreateMCPOptions & { metadata?: Tool['metadata']; toolbox?: Tool[] } = {},
  store: StoreDouble = createStoreDouble(),
): Promise<Harness> {
  const state = { started: { count: 0 }, gate: deferred<string>(), signals: [] as AbortSignal[] };
  const { metadata, toolbox, ...createOptions } = options;
  const tools = toolbox ?? [reportTool(state, metadata ?? { mcp: { taskBacked: true } })];
  const mcp = await createMCP(createToolbox(tools), {
    taskStore: store,
    ...createOptions,
  });
  endpoints.push(mcp);
  return {
    mcp,
    store,
    started: () => state.started.count,
    release: (value = '') => state.gate.resolve(value),
    signals: state.signals,
  };
}

function expectResult(response: WireResponse): Record<string, unknown> {
  expect(response.error).toBeUndefined();
  return response.result ?? {};
}

async function createMcpTask(harness: Harness, title = 'Q3'): Promise<string> {
  const response = await rpc(harness.mcp, 'tools/call', {
    name: 'render-report',
    arguments: { title },
  });
  const created = expectResult(response);
  expect(created['resultType']).toBe('task');
  return created['taskId'] as string;
}

async function getMcpTask(mcp: MCPServer, taskId: string, init: Parameters<typeof rpc>[4] = {}) {
  return rpc(mcp, 'tasks/get', { taskId }, TASKS_CAPABILITIES, init);
}

async function settled(mcp: MCPServer, taskId: string): Promise<Record<string, unknown>> {
  for await (const _turn of awakeTurns()) {
    const task = expectResult(await getMcpTask(mcp, taskId));
    if (task['status'] !== 'working' && task['status'] !== 'input_required') return task;
  }
  throw new Error(`MCP task ${taskId} never reached a terminal status`);
}

function storedRecord(store: StoreDouble, taskId: string): MCPTaskRecord | undefined {
  const raw = store.values.get(`${MCP_TASK_KEY_PREFIX}${taskId}`);
  return raw === undefined ? undefined : (JSON.parse(raw) as MCPTaskRecord);
}

describe('setup and advertisement', () => {
  it('rejects at construction, naming the tool, when a tool opts in without a store', async () => {
    const state = { started: { count: 0 }, gate: deferred<string>(), signals: [] as AbortSignal[] };
    const toolbox = createToolbox([reportTool(state, { mcp: { taskBacked: true } })]);

    const failure = await createMCP(toolbox).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error).message).toContain('"render-report"');
    expect((failure as Error).message).toContain('taskStore');
  });

  it('opts in through metadata.mcp and through the toolConfiguration() callback', async () => {
    const viaMetadata = await startHarness();
    const viaCallback = await startHarness({
      metadata: {},
      toolConfiguration: () => ({ taskBacked: true }),
    });

    for (const harness of [viaMetadata, viaCallback]) {
      const call = await rpc(harness.mcp, 'tools/call', {
        name: 'render-report',
        arguments: { title: 'Q3' },
      });
      expect(expectResult(call)).toMatchObject({ resultType: 'task', status: 'working' });
    }
  });

  it('toMcpTools runs an opted-in tool synchronously', async () => {
    const state = { started: { count: 0 }, gate: deferred<string>(), signals: [] as AbortSignal[] };
    state.gate.resolve('!');
    const [definition] = toMcpTools([reportTool(state, { mcp: { taskBacked: true } })]);

    const result = await definition!.handler({ title: 'Q3' });

    expect(result).toMatchObject({ content: [{ type: 'text', text: 'report: Q3!' }] });
  });

  it('lists the extension in 2026-07-28 server/discover only when a tool opts in', async () => {
    const optedIn = await startHarness({
      capabilities: { extensions: { 'com.example/other': { level: 1 } } },
    });
    const none = await startHarness({ metadata: {} });

    const withTool = expectResult(await rpc(optedIn.mcp, 'server/discover', {}));
    const without = expectResult(await rpc(none.mcp, 'server/discover', {}));

    expect(withTool['capabilities']).toMatchObject({
      extensions: { [TASKS_EXTENSION]: {}, 'com.example/other': { level: 1 } },
    });
    expect(JSON.stringify(without['capabilities'])).not.toContain(TASKS_EXTENSION);
  });

  it('never lists the extension on a 2025-11-25 initialize', async () => {
    const harness = await startHarness();
    const { client } = await connectInProcessClient(harness.mcp, 'legacy');
    try {
      expect(JSON.stringify(client.getServerCapabilities())).not.toContain(TASKS_EXTENSION);
    } finally {
      await client.close();
    }
  });
});

describe('creating and completing an MCP task', () => {
  it('does not answer tools/call until the create has committed', async () => {
    const store = createStoreDouble();
    const latch = deferred<void>();
    store.hold(1, latch.promise);
    const harness = await startHarness({}, store);

    let resolved = false;
    const pending = rpc(harness.mcp, 'tools/call', {
      name: 'render-report',
      arguments: { title: 'Q3' },
    }).then((response) => {
      resolved = true;
      return response;
    });
    // Nothing answers while the create is held, and load can only delay an answer further.
    await quietFor(20);
    expect(resolved).toBe(false);
    expect(harness.started()).toBe(0);

    latch.resolve();
    const created = expectResult(await pending);
    const lookup = await getMcpTask(harness.mcp, created['taskId'] as string);

    expect(lookup.error?.code).not.toBe(INVALID_PARAMS);
    expect(expectResult(lookup)['status']).toBe('working');
  });

  it('returns a working handle while the body runs once, then completes with the synchronous result', async () => {
    const harness = await startHarness();
    const taskId = await createMcpTask(harness);
    expect(harness.started()).toBe(1);
    expect(expectResult(await getMcpTask(harness.mcp, taskId))['status']).toBe('working');

    harness.release('!');
    const task = await settled(harness.mcp, taskId);

    const synchronous = expectResult(
      await rpc(
        harness.mcp,
        'tools/call',
        { name: 'render-report', arguments: { title: 'Q3' } },
        {},
      ),
    );
    const withoutMeta = (value: unknown) => {
      const { _meta: _ignored, ...rest } = value as Record<string, unknown>;
      return rest;
    };
    expect(task['status']).toBe('completed');
    expect(withoutMeta(task['result'])).toEqual(withoutMeta(synchronous));
    expect(harness.started()).toBe(2);
  });

  it('answers tools/call with -32603 and never starts the tool when the create fails', async () => {
    for (const fault of ['reject', 'false'] as const) {
      const store = createStoreDouble();
      store.fault(1, fault);
      const harness = await startHarness({}, store);

      const response = await rpc(harness.mcp, 'tools/call', {
        name: 'render-report',
        arguments: { title: 'Q3' },
      });

      expect(response.error?.code).toBe(INTERNAL_ERROR);
      expect(harness.started()).toBe(0);
      await harness.mcp.executionLifecycle.whenIdle();
    }
  });

  it('surfaces progress as statusMessage and still completes when a terminal write loses a race', async () => {
    const store = createStoreDouble();
    const state = { started: { count: 0 }, gate: deferred<string>(), signals: [] as AbortSignal[] };
    const progressing = createTool({
      name: 'render-report',
      description: 'reports progress',
      input: z.object({ title: z.string() }),
      metadata: { mcp: { taskBacked: true } },
      async execute({ title }, context) {
        context.progress({ message: 'halfway' });
        await state.gate.promise;
        return `done ${title}`;
      },
    });
    const harness = await startHarness({ toolbox: [progressing] }, store);
    const taskId = await createMcpTask(harness);
    await waitUntil(() => storedRecord(store, taskId)?.statusMessage === 'halfway');

    expect(expectResult(await getMcpTask(harness.mcp, taskId))['statusMessage']).toBe('halfway');

    // The first terminal write after the progress write loses its compare-and-set once.
    store.fault(store.batchCount + 1, 'false');
    state.gate.resolve('');
    const task = await settled(harness.mcp, taskId);
    expect(task['status']).toBe('completed');
  });

  it('applies back-to-back progress messages in call order', async () => {
    const store = createStoreDouble();
    const latch = deferred<void>();
    // Batch 1 is the create; batch 2 is the first progress write, held while the second is issued.
    store.hold(2, latch.promise);
    const gate = deferred<string>();
    const chatty = createTool({
      name: 'render-report',
      description: 'reports twice in a row',
      input: z.object({ title: z.string() }),
      metadata: { mcp: { taskBacked: true } },
      async execute(_input, context) {
        context.progress({ message: 'first' });
        context.progress({ message: 'second' });
        return gate.promise;
      },
    });
    const harness = await startHarness({ toolbox: [chatty] }, store);
    const taskId = await createMcpTask(harness);

    // Both progress messages are issued by now; the first write is the one held.
    await waitUntil(() => store.batchCount >= 2);
    latch.resolve();
    await waitUntil(() => storedRecord(store, taskId)?.statusMessage === 'second');
    // A write issued out of order would land after this point and replace 'second'.
    await quietFor(20);

    expect(storedRecord(store, taskId)?.statusMessage).toBe('second');
    gate.resolve('');
    await harness.mcp.shutdown();
  });

  it('answers synchronously without the extension, on 2025-11-25, and for a tool that did not opt in', async () => {
    const harness = await startHarness();
    harness.release('!');

    const undeclared = expectResult(
      await rpc(
        harness.mcp,
        'tools/call',
        { name: 'render-report', arguments: { title: 'Q3' } },
        {},
      ),
    );
    expect(undeclared).toMatchObject({ resultType: 'complete' });

    const { client } = await connectInProcessClient(harness.mcp, 'legacy');
    try {
      const legacy = await client.callTool({ name: 'render-report', arguments: { title: 'Q3' } });
      expect(legacy.content).toEqual([{ type: 'text', text: 'report: Q3!' }]);
      const probe = await client
        .request({ method: 'tasks/get', params: { taskId: 'x' } }, z.looseObject({}))
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect((probe as { code?: number }).code).toBe(METHOD_NOT_FOUND);
    } finally {
      await client.close();
    }

    const plain = await startHarness({ metadata: {} });
    plain.release('!');
    const declared = expectResult(
      await rpc(plain.mcp, 'tools/call', { name: 'render-report', arguments: { title: 'Q3' } }),
    );
    expect(declared['resultType']).toBe('complete');
  });

  it('ends a throwing tool completed with isError, identical to the synchronous path', async () => {
    const throwing = createTool({
      name: 'render-report',
      description: 'always throws',
      input: z.object({ title: z.string() }),
      metadata: { mcp: { taskBacked: true } },
      async execute() {
        throw new Error('the printer is on fire');
      },
    });
    const harness = await startHarness({ toolbox: [throwing] });

    const taskId = await createMcpTask(harness);
    const task = await settled(harness.mcp, taskId);
    const synchronous = expectResult(
      await rpc(
        harness.mcp,
        'tools/call',
        { name: 'render-report', arguments: { title: 'Q3' } },
        {},
      ),
    );

    expect(task['status']).toBe('completed');
    expect(task['result']).toMatchObject({ isError: true, resultType: 'complete' });
    expect((task['result'] as { content: unknown }).content).toEqual(synchronous['content']);
  });
});

describe('cancellation, expiry and shutdown', () => {
  it('cancels a working MCP task, aborting context.signal', async () => {
    const harness = await startHarness();
    const taskId = await createMcpTask(harness);

    const cancel = await rpc(harness.mcp, 'tasks/cancel', { taskId });
    await harness.mcp.executionLifecycle.whenIdle();
    await harness.mcp.shutdown();

    expect(cancel.error).toBeUndefined();
    expect(harness.signals[0]?.aborted).toBe(true);
    expect(expectResult(await getMcpTask(harness.mcp, taskId))['status']).toBe('cancelled');
  });

  it('fails a working MCP task with -32603 on shutdown, never completed', async () => {
    const harness = await startHarness();
    const taskId = await createMcpTask(harness);

    await harness.mcp.shutdown();
    await harness.mcp.executionLifecycle.whenIdle();

    expect(harness.signals[0]?.aborted).toBe(true);
    expect(storedRecord(harness.store, taskId)).toMatchObject({
      status: 'failed',
      error: { code: INTERNAL_ERROR },
    });
  });

  it('expires a working MCP task after ttlMs: aborts, forgets the id, and drops the key', async () => {
    jest.useFakeTimers();
    const harness = await startHarness({ tasks: { ttlMs: 5_000 } });
    const taskId = await createMcpTask(harness);

    jest.advanceTimersByTime(5_001);
    jest.useRealTimers();
    await waitUntil(
      async () => (await getMcpTask(harness.mcp, taskId)).error?.code === INVALID_PARAMS,
    );

    expect(harness.signals[0]?.aborted).toBe(true);
    await harness.mcp.executionLifecycle.whenIdle();
    await harness.mcp.shutdown();
    expect(harness.store.values.has(`${MCP_TASK_KEY_PREFIX}${taskId}`)).toBe(false);
  });
});

describe('input and authorization', () => {
  function approvalTool(counter: { runs: number }) {
    return createTool({
      name: 'render-report',
      description: 'asks before it renders',
      input: z.object({ title: z.string() }),
      metadata: { mcp: { taskBacked: true } },
      async execute({ title }, context) {
        counter.runs += 1;
        const answer = await context.elicit?.({
          mode: 'form',
          message: `Render ${title}?`,
          schema: {
            type: 'object',
            properties: { approved: { type: 'boolean' } },
            required: ['approved'],
          },
        });
        return answer?.action === 'accept' ? `approved ${title}` : 'declined';
      },
    });
  }

  it('moves to input_required on elicit and resumes the same execution on tasks/update', async () => {
    const counter = { runs: 0 };
    const harness = await startHarness({ toolbox: [approvalTool(counter)] });
    const capabilities = { ...TASKS_CAPABILITIES, elicitation: {} };
    const created = expectResult(
      await rpc(
        harness.mcp,
        'tools/call',
        { name: 'render-report', arguments: { title: 'Q3' } },
        capabilities,
      ),
    );
    const taskId = created['taskId'] as string;

    let task = expectResult(await getMcpTask(harness.mcp, taskId));
    await waitUntil(async () => {
      task = expectResult(await getMcpTask(harness.mcp, taskId));
      return task['status'] !== 'working';
    });
    expect(task['status']).toBe('input_required');
    const requests = task['inputRequests'] as Record<string, { method: string }>;
    const key = Object.keys(requests)[0]!;
    expect(requests[key]?.method).toBe('elicitation/create');

    await rpc(harness.mcp, 'tasks/update', { taskId, inputResponses: {} });
    expect(expectResult(await getMcpTask(harness.mcp, taskId))['status']).toBe('input_required');

    const update = await rpc(harness.mcp, 'tasks/update', {
      taskId,
      inputResponses: { [key]: { action: 'accept', content: { approved: true } } },
    });
    expect(update.error).toBeUndefined();
    const finished = await settled(harness.mcp, taskId);

    expect(finished['status']).toBe('completed');
    expect(finished['result']).toMatchObject({
      content: [{ type: 'text', text: 'approved Q3' }],
    });
    expect(counter.runs).toBe(1);
  });

  it('fails an MCP task whose input_required write was rejected, and aborts the waiting tool', async () => {
    const store = createStoreDouble();
    const reported: unknown[] = [];
    const counter = { runs: 0 };
    const harness = await startHarness(
      {
        toolbox: [approvalTool(counter)],
        resources: (server) => {
          Object.assign(server.server, { onerror: (error: unknown) => reported.push(error) });
        },
      },
      store,
    );
    // Batch 1 is the create; batch 2 is the input_required write.
    store.fault(2, 'reject');
    const created = expectResult(
      await rpc(
        harness.mcp,
        'tools/call',
        { name: 'render-report', arguments: { title: 'Q3' } },
        { ...TASKS_CAPABILITIES, elicitation: {} },
      ),
    );
    const taskId = created['taskId'] as string;
    await waitUntil(() => reported.length > 0);
    await harness.mcp.executionLifecycle.whenIdle();

    const task = expectResult(await getMcpTask(harness.mcp, taskId));

    expect(reported).toHaveLength(1);
    expect(task).toMatchObject({ status: 'failed', error: { code: INTERNAL_ERROR } });
    expect(counter.runs).toBe(1);
  });

  it('fences tasks/update to the outstanding round: a stale first answer never answers the second question', async () => {
    const answers: unknown[] = [];
    const twoQuestions = createTool({
      name: 'render-report',
      description: 'asks twice',
      input: z.object({ title: z.string() }),
      metadata: { mcp: { taskBacked: true } },
      async execute(_input, context) {
        for (const message of ['First?', 'Second?']) {
          answers.push(
            await context.elicit?.({
              mode: 'form',
              message,
              schema: {
                type: 'object',
                properties: { approved: { type: 'boolean' } },
                required: ['approved'],
              },
            }),
          );
        }
        return 'both answered';
      },
    });
    const harness = await startHarness({ toolbox: [twoQuestions] });
    const capabilities = { ...TASKS_CAPABILITIES, elicitation: {} };
    const created = expectResult(
      await rpc(
        harness.mcp,
        'tools/call',
        { name: 'render-report', arguments: { title: 'Q3' } },
        capabilities,
      ),
    );
    const taskId = created['taskId'] as string;
    const outstanding = async (previous?: string): Promise<string> => {
      for await (const _turn of awakeTurns()) {
        const task = expectResult(await getMcpTask(harness.mcp, taskId));
        const key = Object.keys((task['inputRequests'] as object | undefined) ?? {})[0];
        if (task['status'] === 'input_required' && key !== undefined && key !== previous) {
          return key;
        }
      }
      throw new Error('no outstanding input request');
    };
    const answer = { action: 'accept', content: { approved: true } };

    const firstKey = await outstanding();
    await rpc(harness.mcp, 'tasks/update', { taskId, inputResponses: { [firstKey]: answer } });
    const secondKey = await outstanding(firstKey);
    expect(secondKey).not.toBe(firstKey);

    // Re-sending the first round's answer must not answer the second question.
    await rpc(harness.mcp, 'tasks/update', { taskId, inputResponses: { [firstKey]: answer } });
    expect(expectResult(await getMcpTask(harness.mcp, taskId))['status']).toBe('input_required');
    expect(answers).toHaveLength(1);

    await rpc(harness.mcp, 'tasks/update', { taskId, inputResponses: { [secondKey]: answer } });
    const finished = await settled(harness.mcp, taskId);
    expect(finished['status']).toBe('completed');
    expect(answers).toHaveLength(2);
  });

  it('answers unknown, expired, and other-client ids with the same -32602 message', async () => {
    const harness = await startHarness();
    const owner = { token: 'a', clientId: 'client-a', scopes: [] };
    const intruder = { token: 'b', clientId: 'client-b', scopes: [] };
    const created = expectResult(
      await rpc(
        harness.mcp,
        'tools/call',
        { name: 'render-report', arguments: { title: 'Q3' } },
        TASKS_CAPABILITIES,
        { authInfo: owner },
      ),
    );
    const taskId = created['taskId'] as string;
    const messages = new Set<string>();

    for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel']) {
      const params = method === 'tasks/update' ? { inputResponses: {} } : {};
      for (const [id, authInfo] of [
        ['no-such-id', owner],
        [taskId, intruder],
      ] as const) {
        const response = await rpc(
          harness.mcp,
          method,
          { taskId: id, ...params },
          TASKS_CAPABILITIES,
          {
            authInfo,
          },
        );
        expect(response.error?.code).toBe(INVALID_PARAMS);
        messages.add(response.error?.message ?? '');
      }
    }
    await harness.store.delete(`${MCP_TASK_KEY_PREFIX}${taskId}`);
    for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel']) {
      const response = await rpc(
        harness.mcp,
        method,
        { taskId, ...(method === 'tasks/update' ? { inputResponses: {} } : {}) },
        TASKS_CAPABILITIES,
        { authInfo: owner },
      );
      expect(response.error?.code).toBe(INVALID_PARAMS);
      messages.add(response.error?.message ?? '');
    }

    expect(messages.size).toBe(1);
    expect(storedRecord(harness.store, taskId)).toBeUndefined();
  });
});

describe('durability', () => {
  it('returns a task completed on one instance from a second instance on the same store', async () => {
    const store = createStoreDouble();
    const first = await startHarness({}, store);
    const second = await startHarness({}, store);
    const taskId = await createMcpTask(first);
    first.release('!');
    await settled(first.mcp, taskId);

    const task = expectResult(await getMcpTask(second.mcp, taskId));

    expect(task['status']).toBe('completed');
    expect(task['result']).toMatchObject({ content: [{ type: 'text', text: 'report: Q3!' }] });
  });

  it('fails an orphaned working record from a second instance, and the first instance loses its settle', async () => {
    const store = createStoreDouble();
    const firstReported: unknown[] = [];
    const first = await startHarness(
      {
        resources: (server) => {
          Object.assign(server.server, {
            onerror: (error: unknown) => firstReported.push(error),
          });
        },
      },
      store,
    );
    const second = await startHarness({}, store);
    const taskId = await createMcpTask(first);

    const task = expectResult(await getMcpTask(second.mcp, taskId));
    expect(task).toMatchObject({ status: 'failed', error: { code: INTERNAL_ERROR } });
    // The first instance was never shut down: its tool settles after the recovery.
    first.release('!');
    await first.mcp.executionLifecycle.whenIdle();
    // The first instance must write nothing more; load can only delay a write, never bring it forward.
    await quietFor(20);

    expect(storedRecord(store, taskId)).toMatchObject({
      status: 'failed',
      error: { code: INTERNAL_ERROR },
    });
    expect(storedRecord(store, taskId)?.result).toBeUndefined();
    expect(firstReported).toEqual([]);
    expect(second.started()).toBe(0);
    await first.mcp.shutdown();
  });

  it('reads a record whose terminal write failed as failed with -32603, not working', async () => {
    const store = createStoreDouble();
    const reported: unknown[] = [];
    const harness = await startHarness(
      {
        resources: (server) => {
          Object.assign(server.server, { onerror: (error: unknown) => reported.push(error) });
        },
      },
      store,
    );
    const taskId = await createMcpTask(harness);
    // Batch 1 was the create; the completion write is batch 2 and is rejected once.
    store.fault(store.batchCount + 1, 'reject');
    harness.release('!');
    await waitUntil(() => reported.length > 0);
    await harness.mcp.executionLifecycle.whenIdle();

    const task = expectResult(await getMcpTask(harness.mcp, taskId));

    expect(reported).toHaveLength(1);
    expect(task).toMatchObject({ status: 'failed', error: { code: INTERNAL_ERROR } });
    const cancel = await rpc(harness.mcp, 'tasks/cancel', { taskId });
    expect(cancel.error).toBeUndefined();
    expect(storedRecord(store, taskId)?.status).toBe('failed');
  });

  it('acknowledges tasks/update and tasks/cancel on an orphan, then reads it as failed', async () => {
    for (const method of ['tasks/update', 'tasks/cancel']) {
      const store = createStoreDouble();
      const first = await startHarness({}, store);
      const second = await startHarness({}, store);
      const taskId = await createMcpTask(first);

      const response = await rpc(second.mcp, method, {
        taskId,
        ...(method === 'tasks/update' ? { inputResponses: {} } : {}),
      });

      expect(response.error).toBeUndefined();
      expect(storedRecord(store, taskId)?.status).toBe('failed');
      expect(expectResult(await getMcpTask(second.mcp, taskId))['status']).toBe('failed');
    }
  });

  it('answers -32603 from every tasks/* method for an unsupported record version', async () => {
    const store = createStoreDouble();
    const reported: unknown[] = [];
    const harness = await startHarness(
      {
        resources: (server) => {
          Object.assign(server.server, { onerror: (error: unknown) => reported.push(error) });
        },
      },
      store,
    );
    const taskId = await createMcpTask(harness);
    const key = `${MCP_TASK_KEY_PREFIX}${taskId}`;
    await store.set(key, JSON.stringify({ ...storedRecord(store, taskId), version: 2 }));

    for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel']) {
      const response = await rpc(harness.mcp, method, {
        taskId,
        ...(method === 'tasks/update' ? { inputResponses: {} } : {}),
      });
      expect(response.error?.code).toBe(INTERNAL_ERROR);
    }
    // Reported by the three tasks/* handlers, before the tool has settled.
    expect(reported).toHaveLength(3);
    for (const error of reported) expect(error).toBeInstanceOf(MCPTaskRecordVersionError);
    harness.release('!');
    await harness.mcp.shutdown();
  });

  it('treats a completed MCP task as unknown after ttlMs and deletes its record', async () => {
    const clock = { now: 1_000_000 };
    const harness = await startHarness({ tasks: { ttlMs: 5_000, now: () => clock.now } });
    const taskId = await createMcpTask(harness);
    harness.release('!');
    const finished = await settled(harness.mcp, taskId);
    expect(finished['status']).toBe('completed');
    expect(storedRecord(harness.store, taskId)).toBeDefined();

    clock.now += 5_001;
    const lookup = await getMcpTask(harness.mcp, taskId);

    expect(lookup.error?.code).toBe(INVALID_PARAMS);
    expect(storedRecord(harness.store, taskId)).toBeUndefined();
  });

  it('answers -32602, not failed, for an orphaned record past ttlMs', async () => {
    const clock = { now: 1_000_000 };
    const store = createStoreDouble();
    const first = await startHarness({ tasks: { ttlMs: 5_000, now: () => clock.now } }, store);
    const second = await startHarness({ tasks: { ttlMs: 5_000, now: () => clock.now } }, store);
    const taskId = await createMcpTask(first);

    clock.now += 5_001;
    const lookup = await getMcpTask(second.mcp, taskId);

    expect(lookup.error?.code).toBe(INVALID_PARAMS);
    expect(storedRecord(store, taskId)).toBeUndefined();
    await first.mcp.shutdown();
  });

  it('persists every documented record field', async () => {
    const harness = await startHarness();
    const taskId = await createMcpTask(harness);

    const record = storedRecord(harness.store, taskId)!;

    expect(Object.keys(record).toSorted()).toEqual(
      [
        'clientId',
        'createdAt',
        'lastUpdatedAt',
        'ownerId',
        'pollIntervalMs',
        'status',
        'taskId',
        'toolName',
        'ttlMs',
        'version',
      ].toSorted(),
    );
    expect(record.version).toBe(1);
  });
});

describe('SDK client limitation', () => {
  it('still rejects a task handle in the SDK 2.4.0 client (canary)', async () => {
    const harness = await startHarness();
    const { client } = await connectInProcessClient(
      harness.mcp,
      { pin: MCP_PROTOCOL_VERSION },
      { capabilities: TASKS_CAPABILITIES },
    );
    try {
      const outcome = client.callTool({ name: 'render-report', arguments: { title: 'Q3' } });
      expect(await throwingRejectionOf(outcome)).toThrow(
        "Unsupported result type 'task' for tools/call",
      );
    } finally {
      await client.close();
    }
  });
});
