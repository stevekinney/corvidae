import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool } from '../src/create-tool';
import { createToolbox } from '../src/create-toolbox';
import {
  createMCP,
  fromMcpEndpointTools,
  MCPInputRequiredUnsupportedError,
  type MCPServer,
} from '../src/integrations/mcp';
import type { Tool } from '../src/is-tool';
import { createStoreDouble, deferred, rpc } from './fixtures/mcp-task-harness';

/**
 * The raw-JSON-RPC consumer: `fromMcpEndpointTools` against a `createMCP`
 * endpoint, called through `mcp.fetch`.
 */

let endpoints: MCPServer[] = [];
afterEach(async () => {
  await Promise.all(endpoints.map((endpoint) => endpoint.close()));
  endpoints = [];
});

type Fixture = {
  mcp: MCPServer;
  delays: number[];
  requests: string[];
  tools: Map<string, Tool>;
  gate: ReturnType<typeof deferred<void>>;
  seen: { elicited: unknown[]; aborted: boolean };
  store: ReturnType<typeof createStoreDouble>;
  taskIds: string[];
};

async function fixture(
  options: { delay?: (milliseconds: number) => Promise<void> } = {},
): Promise<Fixture> {
  const gate = deferred<void>();
  const seen = { elicited: [] as unknown[], aborted: false };
  const slow = createTool({
    name: 'slow',
    description: 'waits for a gate',
    input: z.object({ title: z.string() }),
    metadata: { mcp: { taskBacked: true } },
    async execute({ title }, context) {
      context.progress({ message: 'working on it' });
      context.signal?.addEventListener('abort', () => {
        seen.aborted = true;
      });
      await Promise.race([
        gate.promise,
        new Promise<never>((_resolve, reject) =>
          context.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
      ]);
      return `slow ${title}`;
    },
  });
  const plain = createTool({
    name: 'plain',
    description: 'answers synchronously',
    input: z.object({ title: z.string() }),
    async execute({ title }) {
      return `plain ${title}`;
    },
  });
  const asks = createTool({
    name: 'asks',
    description: 'elicits inside an MCP task',
    input: z.object({}),
    metadata: { mcp: { taskBacked: true } },
    async execute(_input, context) {
      const answer = await context.elicit?.({
        mode: 'form',
        message: 'Proceed?',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      });
      return JSON.stringify(answer);
    },
  });
  const asksSynchronously = createTool({
    name: 'asks-synchronously',
    description: 'elicits without being task-backed',
    input: z.object({}),
    async execute(_input, context) {
      const answer = await context.elicit?.({ mode: 'form', message: 'Proceed?' });
      return JSON.stringify(answer);
    },
  });
  const store = createStoreDouble();
  const taskIds: string[] = [];
  const mcp = await createMCP(createToolbox([slow, plain, asks, asksSynchronously]), {
    taskStore: store,
    tasks: { pollIntervalMs: 7 },
  });
  endpoints.push(mcp);

  const delays: number[] = [];
  const requests: string[] = [];
  const endpointTools = await fromMcpEndpointTools({
    url: 'http://armorer.test/mcp',
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const body = JSON.parse(await request.clone().text()) as { method: string };
      requests.push(body.method);
      const response = await mcp.fetch(request);
      if (body.method === 'tools/call') {
        const payload = (await response.clone().json()) as { result?: { taskId?: string } };
        if (payload.result?.taskId) taskIds.push(payload.result.taskId);
      }
      return response;
    },
    delay:
      options.delay ??
      (async (milliseconds) => {
        delays.push(milliseconds);
        gate.resolve();
        await Bun.sleep(1);
      }),
  });
  const tools = new Map(endpointTools.map((tool) => [tool.name, tool]));
  return { mcp, delays, requests, tools, gate, seen, store, taskIds };
}

function toolNamed(fixtureValue: Fixture, name: string): Tool {
  const tool = fixtureValue.tools.get(name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
}

/** Polls without ever releasing the tool's gate. */
const patient = { delay: async () => Bun.sleep(1) };

describe('fromMcpEndpointTools', () => {
  it('hides polling: execute resolves to the final result and delay receives pollIntervalMs', async () => {
    const harness = await fixture();

    const result = await toolNamed(harness, 'slow').execute({ title: 'Q3' });

    expect(JSON.stringify(result)).toContain('slow Q3');
    expect(harness.delays.length).toBeGreaterThan(0);
    expect(new Set(harness.delays)).toEqual(new Set([7]));
    expect(harness.requests).toContain('tasks/get');
  });

  it('passes a complete answer through and rejects a synchronous input_required answer', async () => {
    const harness = await fixture();

    const plain = await toolNamed(harness, 'plain').execute({ title: 'x' });
    const asked = await toolNamed(harness, 'asks-synchronously')
      .execute({}, undefined)
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(JSON.stringify(plain)).toContain('plain x');
    expect(harness.requests).not.toContain('tasks/get');
    expect(asked).toBeUndefined();
    // Without a context.elicit the client declares no elicitation, so the tool takes its no-elicit path.
    const withElicit = await toolNamed(harness, 'asks-synchronously')
      .execute({}, { elicit: async () => ({ action: 'accept', content: {} }) } as never)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    // `Tool.execute` rethrows a failed call as a plain Error carrying the message.
    expect((withElicit as Error).message).toContain('fromMcpClientTools');
    expect(new MCPInputRequiredUnsupportedError('x')).toBeInstanceOf(Error);
  });

  it('sends tasks/cancel when the call is aborted', async () => {
    const waiting = deferred<void>();
    const harness = await fixture({ delay: () => waiting.promise });
    const controller = new AbortController();

    const outcome = toolNamed(harness, 'slow')
      .execute({ title: 'Q3' }, { signal: controller.signal })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await Bun.sleep(20);
    controller.abort(new Error('caller gave up'));
    await outcome;
    await harness.mcp.executionLifecycle.whenIdle();

    expect(harness.requests).toContain('tasks/cancel');
    expect(harness.seen.aborted).toBe(true);
  });

  it('answers an input_required MCP task through the calling tool context.elicit', async () => {
    const harness = await fixture();
    const questions: string[] = [];

    const result = await toolNamed(harness, 'asks').execute(
      {},
      {
        elicit: async (request: { message: string }) => {
          questions.push(request.message);
          return { action: 'accept' as const, content: { ok: true } };
        },
      },
    );

    expect(questions).toEqual(['Proceed?']);
    expect(JSON.stringify(result)).toContain('accept');
    expect(JSON.stringify(result)).toContain('ok');
  });

  it('rejects, naming the status or code, for a remote cancelled, failed, or -32602 MCP task', async () => {
    const rejection = async (harness: Fixture, act: (taskId: string) => Promise<unknown>) => {
      const started = toolNamed(harness, 'slow')
        .execute({ title: 'Q3' })
        .then(
          () => undefined,
          (error: unknown) => error as Error,
        );
      for (let attempt = 0; attempt < 100 && harness.taskIds.length === 0; attempt += 1) {
        await Bun.sleep(1);
      }
      await act(harness.taskIds[0]!);
      return started;
    };

    const cancelHarness = await fixture(patient);
    const cancelled = await rejection(cancelHarness, (taskId) =>
      rpc(cancelHarness.mcp, 'tasks/cancel', { taskId }),
    );
    expect(cancelled?.message).toContain('cancelled');

    const failedHarness = await fixture(patient);
    const failed = await rejection(failedHarness, () => failedHarness.mcp.shutdown());
    expect(failed?.message).toContain('failed');
    expect(failed?.message).toContain('-32603');

    const expiredHarness = await fixture(patient);
    const expired = await rejection(expiredHarness, (taskId) =>
      expiredHarness.store.delete(`mcp-task:${taskId}`),
    );
    expect(expired?.message).toContain('-32602');
  });
});
