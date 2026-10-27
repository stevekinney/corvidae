import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool } from '../src/create-tool';
import { createToolbox } from '../src/create-toolbox';
import {
  createMCP,
  MCP_PROTOCOL_VERSION,
  type CreateMCPOptions,
  type MCPServer,
} from '../src/integrations/mcp';
import { connectInProcessClient } from './fixtures/mcp-in-process-client';

/**
 * COR-1606 spike: the 2026-07-28 Tasks extension (`io.modelcontextprotocol/tasks`)
 * on SDK 2.4.0. The SDK has no task runtime, so the server owns the task
 * store and registers `tasks/get` itself. Wire shapes come from the
 * extension's 2026-07-28 JSON Schema.
 *
 * `tools/call` is posted as raw JSON-RPC: the SDK 2.4.0 client's
 * `decodeResult` rejects every `resultType` except `complete` and
 * `input_required` ("Unsupported result type 'task' for tools/call"), with or
 * without a caller-supplied result schema, so no SDK client can receive a
 * task handle.
 */

const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
const TASKS_CAPABILITIES = { extensions: { [TASKS_EXTENSION]: {} } };

const TaskStatusSchema = z.enum(['working', 'input_required', 'completed', 'failed', 'cancelled']);

const TaskFieldsSchema = z.looseObject({
  taskId: z.string(),
  status: TaskStatusSchema,
  statusMessage: z.string().optional(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
  ttlMs: z.number().int().nullable(),
  pollIntervalMs: z.number().int().optional(),
});

/** `tools/call` answered with a task handle (`CreateTaskResult`). */
const CreateTaskResultSchema = TaskFieldsSchema.extend({ resultType: z.literal('task') });

/** `tasks/get` result (`GetTaskResult`); `result` is present once `completed`. */
const GetTaskResultSchema = TaskFieldsSchema.extend({
  result: z.record(z.string(), z.unknown()).optional(),
});

const JsonRpcResponseSchema = z.looseObject({
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.looseObject({ code: z.number(), message: z.string() }).optional(),
});

let endpoints: MCPServer[] = [];
afterEach(async () => {
  await Promise.all(endpoints.map((endpoint) => endpoint.close()));
  endpoints = [];
});

function createSlowToolbox() {
  return createToolbox([
    createTool({
      name: 'render-report',
      description: 'a long-running tool that should run as a task',
      input: z.object({ title: z.string() }),
      async execute({ title }) {
        await Bun.sleep(5);
        return `report: ${title}`;
      },
    }),
  ]);
}

async function endpoint(options: CreateMCPOptions = {}): Promise<MCPServer> {
  const mcp = await createMCP(createSlowToolbox(), options);
  endpoints.push(mcp);
  return mcp;
}

let nextId = 0;

/** Posts one 2026-07-28 JSON-RPC request with the per-request envelope the SDK client sends. */
async function rpc(
  mcp: MCPServer,
  method: string,
  params: Record<string, unknown>,
  capabilities: Record<string, unknown> = TASKS_CAPABILITIES,
) {
  nextId += 1;
  const response = await mcp.fetch(
    new Request('http://armorer.test/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-method': method,
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
        // The HTTP entry routes on Mcp-Name: the tool name, or a task's id.
        ...(typeof params['name'] === 'string' ? { 'mcp-name': params['name'] } : {}),
        ...(typeof params['taskId'] === 'string' ? { 'mcp-name': params['taskId'] } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: nextId,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
            'io.modelcontextprotocol/clientInfo': { name: 'cor-1606-spike', version: '1.0.0' },
            'io.modelcontextprotocol/clientCapabilities': capabilities,
          },
        },
      }),
    }),
  );
  return JsonRpcResponseSchema.parse(await response.json());
}

async function pollUntilTerminal(mcp: MCPServer, taskId: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const { result, error } = await rpc(mcp, 'tasks/get', { taskId });
    if (error) throw new Error(`tasks/get failed: ${error.code} ${error.message}`);
    const task = GetTaskResultSchema.parse(result);
    if (task.status !== 'working' && task.status !== 'input_required') return task;
    await Bun.sleep(task.pollIntervalMs ?? 1);
  }
  throw new Error(`task ${taskId} never reached a terminal status`);
}

describe('SDK 2.4.0 seams for the Tasks extension', () => {
  it('serves a hand-registered task handle and tasks/get round trip over 2026-07-28', async () => {
    const tasks = new Map<string, Record<string, unknown>>();
    const mcp = await endpoint({
      resources: (server, context) => {
        if (context.era !== 'modern') return;
        server.registerTool(
          'probe-task',
          { inputSchema: z.object({}) },
          // The SDK types tool callbacks as CallToolResult; a task handle is
          // the extension's alternative result family, so the cast is the seam.
          (() => {
            const now = new Date().toISOString();
            const taskId = `task-${tasks.size + 1}`;
            tasks.set(taskId, {
              taskId,
              status: 'completed',
              createdAt: now,
              lastUpdatedAt: now,
              ttlMs: 60_000,
              result: { content: [{ type: 'text', text: 'probe done' }], resultType: 'complete' },
            });
            return {
              resultType: 'task',
              taskId,
              status: 'working',
              createdAt: now,
              lastUpdatedAt: now,
              ttlMs: 60_000,
              pollIntervalMs: 1,
            };
          }) as never,
        );
        server.server.setRequestHandler(
          'tasks/get',
          { params: z.object({ taskId: z.string() }), result: GetTaskResultSchema },
          ({ taskId }) => {
            const task = tasks.get(taskId);
            if (!task) throw new Error(`unknown task ${taskId}`);
            return GetTaskResultSchema.parse(task);
          },
        );
      },
    });

    const call = await rpc(mcp, 'tools/call', { name: 'probe-task', arguments: {} });
    expect(call.error).toBeUndefined();
    const created = CreateTaskResultSchema.parse(call.result);
    // SDK 2.4.0 pads the flattened handle with `content: []`: its padding
    // guard looks for the 2025-era nested `task` key, not `taskId`. The
    // extension's `Result` allows additional properties, so this is valid.
    expect(call.result?.['content']).toEqual([]);

    const finished = await pollUntilTerminal(mcp, created.taskId);
    expect(finished.status).toBe('completed');
    expect(finished.result).toMatchObject({ content: [{ type: 'text', text: 'probe done' }] });
  });

  it('advertises the extension and routes tasks/update and tasks/cancel to custom handlers', async () => {
    const received: string[] = [];
    const mcp = await endpoint({
      capabilities: { extensions: { [TASKS_EXTENSION]: {} } },
      resources: (server, context) => {
        if (context.era !== 'modern') return;
        const acknowledge = z.looseObject({});
        server.server.setRequestHandler(
          'tasks/update',
          { params: z.looseObject({ taskId: z.string() }), result: acknowledge },
          ({ taskId }) => {
            received.push(`update:${taskId}`);
            return {};
          },
        );
        server.server.setRequestHandler(
          'tasks/cancel',
          { params: z.object({ taskId: z.string() }), result: acknowledge },
          ({ taskId }) => {
            received.push(`cancel:${taskId}`);
            return {};
          },
        );
      },
    });

    const discover = await rpc(mcp, 'server/discover', {});
    const update = await rpc(mcp, 'tasks/update', { taskId: 'task-1', inputResponses: {} });
    const cancel = await rpc(mcp, 'tasks/cancel', { taskId: 'task-1' });

    expect(discover.result?.['capabilities']).toMatchObject({
      extensions: { [TASKS_EXTENSION]: {} },
    });
    expect(update.error).toBeUndefined();
    expect(cancel.error).toBeUndefined();
    expect(received).toEqual(['update:task-1', 'cancel:task-1']);
  });

  it('rejects a task handle in the SDK client even with a caller-supplied result schema', async () => {
    const mcp = await endpoint({
      resources: (server, context) => {
        if (context.era !== 'modern') return;
        server.registerTool('probe-task', { inputSchema: z.object({}) }, (() => {
          const now = new Date().toISOString();
          return {
            resultType: 'task',
            taskId: 'task-1',
            status: 'working',
            createdAt: now,
            lastUpdatedAt: now,
            ttlMs: 60_000,
          };
        }) as never);
      },
    });
    const { client } = await connectInProcessClient(
      mcp,
      { pin: MCP_PROTOCOL_VERSION },
      { capabilities: TASKS_CAPABILITIES },
    );
    try {
      const outcome = client.request(
        { method: 'tools/call', params: { name: 'probe-task', arguments: {} } },
        CreateTaskResultSchema,
      );
      expect(outcome).rejects.toThrow("Unsupported result type 'task' for tools/call");
      await outcome.catch(() => undefined);
    } finally {
      await client.close();
    }
  });
});

describe('Armorer task-backed tools (COR-1606)', () => {
  it('advertises the Tasks extension in server/discover', async () => {
    const mcp = await endpoint();

    const { result } = await rpc(mcp, 'server/discover', {});

    expect(result?.['capabilities']).toMatchObject({ extensions: { [TASKS_EXTENSION]: {} } });
  });

  it('answers tools/call with a task handle when the client declares the extension', async () => {
    const mcp = await endpoint();

    const call = await rpc(mcp, 'tools/call', {
      name: 'render-report',
      arguments: { title: 'Q3' },
    });
    expect(call.error).toBeUndefined();
    const created = CreateTaskResultSchema.parse(call.result);
    const finished = await pollUntilTerminal(mcp, created.taskId);

    expect(finished.status).toBe('completed');
    expect(finished.result).toMatchObject({ content: [{ type: 'text', text: 'report: Q3' }] });
  });

  it('answers tools/call synchronously when the client does not declare the extension', async () => {
    const mcp = await endpoint();

    const call = await rpc(
      mcp,
      'tools/call',
      { name: 'render-report', arguments: { title: 'Q3' } },
      {},
    );

    expect(call.result).toMatchObject({
      resultType: 'complete',
      content: [{ type: 'text', text: 'report: Q3' }],
    });
  });
});
