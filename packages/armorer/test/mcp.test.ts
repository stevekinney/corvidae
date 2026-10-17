import { Client } from '@modelcontextprotocol/client';
import type { JSONRPCMessage } from '@modelcontextprotocol/server';
import { InMemoryTransport, ReadBuffer, serializeMessage } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { describe, expect, it } from 'bun:test';
import { PassThrough } from 'node:stream';
import { z } from 'zod';
import { expectPromiseToReject } from '../src/async-assertion-test-helpers';

import { createTool } from '../src/create-tool';
import { createToolbox } from '../src/create-toolbox';
import {
  createMCP,
  createMcpElicitationHandler,
  createMcpToolElicitationRequester,
  fromMcpTools,
  toMcpTools,
} from '../src/integrations/mcp';
import type {
  Tool,
  ToolElicitationRequest,
  ToolElicitationRequester,
  ToolMetadata,
} from '../src/is-tool';
import type { AnyToolbox } from '../src/toolbox-interface';

type ConnectedMcp = {
  client: Client;
  server: Awaited<ReturnType<typeof createMCP>>;
};

type McpRegistrarTarget = {
  registerResource: (
    name: string,
    uri: string,
    metadata: Record<string, unknown>,
    handler: () => unknown,
  ) => unknown;
  registerPrompt: (
    name: string,
    metadata: Record<string, unknown>,
    handler: () => unknown,
  ) => unknown;
};

function requiredValue<T>(value: T | undefined, description: string): T {
  if (value === undefined) {
    throw new Error(`Expected ${description} to be defined`);
  }
  return value;
}

/**
 * MCP tool-call results carry a content-block union (text, image, audio,
 * resource, resource_link) that only narrows to `{ text }` for the text
 * variant. Every handler under test here returns a single text block, so
 * this reads it back without repeating the narrowing at each call site.
 */
function textContent(content: unknown): string | undefined {
  const first = Array.isArray(content) ? content[0] : undefined;
  if (first && typeof first === 'object' && 'text' in first && typeof first.text === 'string') {
    return first.text;
  }
  return undefined;
}

class LoopbackTransport {
  private readonly readBuffer = new ReadBuffer();
  private readonly onData: (chunk: Buffer) => void;
  private readonly onError: (error: unknown) => void;
  private started = false;

  onmessage?: (message: unknown) => void;
  onclose?: () => void;
  onerror?: (error: unknown) => void;

  constructor(
    private readonly readable: PassThrough,
    private readonly writable: PassThrough,
  ) {
    this.onData = (chunk: Buffer) => {
      this.readBuffer.append(chunk);
      while (true) {
        try {
          const message = this.readBuffer.readMessage();
          if (message === null) break;
          this.onmessage?.(message);
        } catch (error) {
          this.onerror?.(error);
        }
      }
    };
    this.onError = (error: unknown) => {
      this.onerror?.(error);
    };
  }

  async start() {
    if (this.started) {
      throw new Error('LoopbackTransport already started');
    }
    this.started = true;
    this.readable.on('data', this.onData);
    this.readable.on('error', this.onError);
  }

  async close() {
    this.readable.off('data', this.onData);
    this.readable.off('error', this.onError);
    this.readBuffer.clear();
    this.onclose?.();
  }

  send(message: JSONRPCMessage) {
    return new Promise<void>((resolve) => {
      const json = serializeMessage(message);
      if (this.writable.write(json)) {
        resolve();
      } else {
        this.writable.once('drain', resolve);
      }
    });
  }
}

const connect = async (toolbox: Parameters<typeof createMCP>[0], options = {}) => {
  const server = await createMCP(toolbox, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'toolbox-test-client', version: '0.0.0' });
  await server.createServer().connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server } satisfies ConnectedMcp;
};

describe('createMCP', () => {
  it('aborts and awaits an in-flight plain call, then rejects admission after shutdown', async () => {
    const started = createDeferred<void>();
    const aborted = createDeferred<void>();
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(
      createTool({
        name: 'shutdown-plain',
        description: 'plain call held open for shutdown',
        input: z.object({}),
        async execute(_params, context) {
          started.resolve();
          return new Promise((_resolve, reject) => {
            context.signal?.addEventListener('abort', () => {
              aborted.resolve();
              reject(context.signal?.reason ?? new Error('aborted'));
            });
          });
        },
      }),
    );
    const { client, server } = await connect(toolbox);
    try {
      const call = client.callTool({ name: 'shutdown-plain', arguments: {} });
      await started.promise;
      const reportPromise = server.shutdown();
      await aborted.promise;
      const report = await reportPromise;
      expect(report.admissionClosed).toBe(true);
      expect(report.terminal + report.unknownEffects).toBe(report.snapshots.length);
      expect(report.snapshots.every((snapshot) => snapshot.state !== 'active')).toBe(true);
      expect(() => server.shutdown()).not.toThrow();
      expect(await call).toMatchObject({ isError: true });

      const afterShutdown = await client.callTool({ name: 'shutdown-plain', arguments: {} });
      expect(afterShutdown.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('retains the plain-call error result in lifecycle inspection', async () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(
      createTool({
        name: 'plain-error-outcome',
        description: 'plain tool with a deterministic failure',
        input: z.object({}),
        async execute() {
          throw new Error('plain execution failed');
        },
      }),
    );
    const { client, server } = await connect(toolbox);
    try {
      const result = await client.callTool({ name: 'plain-error-outcome', arguments: {} });
      expect(result).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: 'plain execution failed' }],
      });
      const report = await server.shutdown();
      expect(report.snapshots).toHaveLength(1);
      expect(report.snapshots[0]?.result).toEqual(result);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('accepts a structural AbortSignal from another realm', async () => {
    const tool = createTool({
      name: 'cross-realm-signal',
      description: 'accepts signal-like cancellation',
      input: z.object({}),
      async execute() {
        return { reached: true };
      },
    });
    const signal = {
      aborted: true,
      reason: new Error('foreign cancellation'),
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal;
    const result = await tool.executeWith({ params: {}, signal });
    expect(result.outcome).toBe('error');
    expect(result.error?.category).toBe('cancelled');
    expect(result.error?.message).toBe('foreign cancellation');
  });

  it('converts toolbox tools into MCP tool definitions', async () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(
      createTool({
        name: 'sum-local',
        description: 'adds two numbers',
        input: z.object({ a: z.number(), b: z.number() }),
        metadata: { readOnly: true },
        async execute({ a, b }) {
          return { total: a + b };
        },
      }),
    );

    const [mcpTool = requiredValue<never>(undefined, 'MCP tool')] = toMcpTools(toolbox);

    expect(mcpTool).toBeDefined();
    expect(mcpTool?.name).toBe('sum-local');
    expect(mcpTool?.annotations?.readOnlyHint).toBe(true);
    expect(mcpTool?.description).toBe('adds two numbers');

    const result = await mcpTool.handler({ a: 2, b: 3 });
    expect(result.structuredContent).toEqual({ total: 5 });
    expect(textContent(result.content)).toContain('"total": 5');
  });

  it('formats canonical and legacy execution payloads when exporting MCP handlers', async () => {
    type CanonicalExecuteResult =
      | { callId: string; outcome: 'success'; content: { ok: boolean } }
      | {
          callId: string;
          outcome: 'error';
          content: { message: string };
          errorMessage?: string;
        };

    const tool = {
      name: 'canonical-result',
      description: 'formats canonical results',
      input: z.object({}),
      metadata: {},
      executeWith: async (): Promise<CanonicalExecuteResult> => ({
        callId: 'canonical-call',
        outcome: 'success' as const,
        content: { ok: true },
      }),
    };

    const [mcpTool = requiredValue<never>(undefined, 'MCP tool')] = toMcpTools(tool as any);
    const canonicalResult = await mcpTool.handler({});
    expect(canonicalResult.structuredContent).toEqual({ ok: true });
    expect(textContent(canonicalResult.content)).toContain('"ok": true');

    tool.executeWith = async () => ({
      callId: 'typed-error-call',
      outcome: 'error' as const,
      content: { message: 'content fallback for typed error' },
      error: {
        code: 'FAILED',
        category: 'unavailable',
        retryable: false,
        message: 'typed error message',
      },
    });

    const typedErrorResult = await mcpTool.handler({});
    expect(typedErrorResult.isError).toBe(true);
    expect(textContent(typedErrorResult.content)).toBe('typed error message');

    tool.executeWith = async () => ({
      callId: 'content-fallback-call',
      outcome: 'error' as const,
      content: { message: 'content fallback' },
    });

    const contentFallbackResult = await mcpTool.handler({});
    expect(contentFallbackResult.isError).toBe(true);
    expect(textContent(contentFallbackResult.content)).toContain('content fallback');
  });

  it('converts MCP tools with handlers into executable toolbox tools', async () => {
    const [tool = requiredValue<never>(undefined, 'tool')] = fromMcpTools([
      {
        name: 'remote-sum',
        description: 'sum from remote mcp',
        inputSchema: z.object({ a: z.number(), b: z.number() }),
        handler: async (args) => {
          const input = args as { a: number; b: number };
          return {
            content: [{ type: 'text', text: JSON.stringify({ total: input.a + input.b }) }],
            structuredContent: { total: input.a + input.b },
          };
        },
      },
    ]);

    const result = await tool.execute({ a: 4, b: 6 });
    expect(result).toEqual({ total: 10 });
  });

  it('uses callTool for MCP tools without handlers', async () => {
    const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
    const [tool = requiredValue<never>(undefined, 'tool')] = fromMcpTools(
      [
        {
          name: 'remote-echo',
          description: 'echoes back text',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        },
      ],
      {
        async callTool(request) {
          calls.push(request);
          return {
            content: [{ type: 'text', text: JSON.stringify({ echoed: request.arguments }) }],
            structuredContent: { echoed: request.arguments },
          };
        },
      },
    );

    const result = await tool.execute({ text: 'hello' });
    expect(calls).toEqual([{ name: 'remote-echo', arguments: { text: 'hello' } }]);
    expect(result).toEqual({ echoed: { text: 'hello' } });
  });

  it('throws when MCP tools cannot be executed', async () => {
    const [tool = requiredValue<never>(undefined, 'tool')] = fromMcpTools([
      {
        name: 'needs-caller',
        description: 'requires remote invoker',
        inputSchema: { type: 'object' },
      },
    ]);

    await expectPromiseToReject(tool.execute({}), (error) =>
      expect(() => {
        throw error;
      }).toThrow('requires callTool()'),
    );
  });

  it('registers toolbox tools and exposes them via listTools', async () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(
      createTool({
        name: 'sum',
        description: 'adds two numbers',
        input: z.object({ a: z.number(), b: z.number() }),
        metadata: { owner: 'toolbox' },
        async execute({ a, b }) {
          return a + b;
        },
      }),
    );

    const { client, server } = await connect(toolbox, {
      toolConfiguration: (tool: Tool) => ({
        title: `${tool.name}-title`,
        meta: { ...tool.metadata, source: 'mcp' },
      }),
    });

    try {
      const tools = await client.listTools();
      const tool = tools.tools.find((entry) => entry.name === 'sum');
      expect(tool).toBeDefined();
      expect(tool?.title).toBe('sum-title');
      expect(tool?.description).toBe('adds two numbers');
      expect(tool?.inputSchema.type).toBe('object');
      expect(tool?._meta).toEqual({ owner: 'toolbox', source: 'mcp' });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('registers only available toolbox tools and rechecks availability on calls', async () => {
    let available = true;
    let executed = false;
    const toolbox: AnyToolbox = createToolbox([
      createTool({
        name: 'available-tool',
        description: 'available',
        input: z.object({}),
        availability: () => available,
        async execute() {
          executed = true;
          return { ok: true };
        },
      }),
      createTool({
        name: 'unavailable-tool',
        description: 'unavailable',
        input: z.object({}),
        availability: () => false,
        async execute() {
          return { hidden: true };
        },
      }),
    ]);

    const { client, server } = await connect(toolbox);

    try {
      const tools = await client.listTools();
      available = false;
      const result = await client.callTool({ name: 'available-tool', arguments: {} });

      expect(tools.tools.map((tool) => tool.name)).toEqual(['available-tool']);
      expect(executed).toBe(false);
      expect(result.isError).toBe(true);
      expect(textContent(result.content)).toContain('Tool unavailable: available-tool');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('applies MCP metadata configuration when provided', async () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(
      createTool({
        name: 'meta-tool',
        description: 'reads metadata',
        input: z.object({}),
        metadata: {
          mcp: {
            title: 'meta-title',
            schema: {
              type: 'object',
              properties: { ok: { type: 'boolean' } },
              required: ['ok'],
              additionalProperties: false,
            },
            meta: { source: 'metadata' },
          },
        },
        async execute() {
          return { ok: true };
        },
      }),
    );

    const { client, server } = await connect(toolbox);

    try {
      const tools = await client.listTools();
      const tool = tools.tools.find((entry) => entry.name === 'meta-tool');
      expect(tool?.title).toBe('meta-title');
      expect(tool?._meta).toEqual({ source: 'metadata' });
      expect(tool?.inputSchema?.type).toBe('object');
      expect(tool?.inputSchema?.properties).toHaveProperty('ok');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('uses tool metadata as _meta when not overridden', async () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(
      createTool({
        name: 'meta-default',
        description: 'uses metadata by default',
        input: z.object({}),
        metadata: { owner: 'toolbox', scope: 'test' },
        async execute() {
          return { ok: true };
        },
      }),
    );

    const { client, server } = await connect(toolbox);

    try {
      const tools = await client.listTools();
      const tool = tools.tools.find((entry) => entry.name === 'meta-default');
      expect(tool?._meta).toEqual({ owner: 'toolbox', scope: 'test' });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('adds readOnlyHint annotation for read-only tools', async () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(
      createTool({
        name: 'read-only-tool',
        description: 'read-only',
        input: z.object({}),
        metadata: { readOnly: true },
        async execute() {
          return { ok: true };
        },
      }),
    );

    const { client, server } = await connect(toolbox);

    try {
      const tools = await client.listTools();
      const tool = tools.tools.find((entry) => entry.name === 'read-only-tool');
      expect(tool?.annotations?.readOnlyHint).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('ignores non-object metadata for _meta', async () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(
      createTool({
        name: 'meta-invalid',
        description: 'metadata is an array',
        input: z.object({}),
        metadata: [] as unknown as ToolMetadata,
        async execute() {
          return { ok: true };
        },
      }),
    );

    const { client, server } = await connect(toolbox);

    try {
      const tools = await client.listTools();
      const tool = tools.tools.find((entry) => entry.name === 'meta-invalid');
      expect(tool?._meta).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('prefers toolConfiguration over metadata mcp settings', async () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(
      createTool({
        name: 'override-configuration',
        description: 'should be overridden',
        input: z.object({}),
        metadata: {
          mcp: {
            title: 'meta-title',
            description: 'meta-description',
            schema: {
              type: 'object',
              properties: { fromMeta: { type: 'boolean' } },
              required: ['fromMeta'],
              additionalProperties: false,
            },
            meta: { source: 'metadata' },
          },
        },
        async execute() {
          return { ok: true };
        },
      }),
    );

    const { client, server } = await connect(toolbox, {
      toolConfiguration: () => ({
        title: 'override-title',
        description: 'override-description',
        schema: z.object({ fromConfiguration: z.string() }),
        meta: { source: 'configuration' },
      }),
    });

    try {
      const tools = await client.listTools();
      const tool = tools.tools.find((entry) => entry.name === 'override-configuration');
      expect(tool?.title).toBe('override-title');
      expect(tool?.description).toBe('override-description');
      expect(tool?._meta).toEqual({ source: 'configuration' });
      expect(tool?.inputSchema?.type).toBe('object');
      expect(tool?.inputSchema?.properties).toHaveProperty('fromConfiguration');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('executes tools and returns structured content when output is an object', async () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(
      createTool({
        name: 'status',
        description: 'returns a status object',
        input: z.object({}),
        async execute() {
          return { ok: true };
        },
      }),
    );

    const { client, server } = await connect(toolbox);

    try {
      const result = await client.callTool({ name: 'status', arguments: {} });
      expect(result.structuredContent).toEqual({ ok: true });
      expect(
        requiredValue(result.content as Array<{ type?: string }> | undefined, 'result content')[0]
          ?.type,
      ).toBe('text');
      expect(textContent(result.content)).toContain('"ok": true');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('handles parallel tool calls', async () => {
    let toolbox: AnyToolbox = createToolbox();
    let calls = 0;
    toolbox = toolbox.extend(
      createTool({
        name: 'echo',
        description: 'echoes the id after a delay',
        input: z.object({ id: z.number() }),
        async execute({ id }) {
          calls += 1;
          await Promise.resolve();
          return { id };
        },
      }),
    );

    const { client, server } = await connect(toolbox);

    try {
      const [first, second] = await Promise.all([
        client.callTool({ name: 'echo', arguments: { id: 1 } }),
        client.callTool({ name: 'echo', arguments: { id: 2 } }),
      ]);
      expect(first.structuredContent).toEqual({ id: 1 });
      expect(second.structuredContent).toEqual({ id: 2 });
      expect(calls).toBe(2);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('refreshes tool definitions when a server is recreated after re-registering', async () => {
    let toolbox: AnyToolbox = createToolbox();

    toolbox = toolbox.extend(
      createTool({
        name: 'swap',
        description: 'first description',
        input: z.object({}),
        async execute() {
          return 'first';
        },
      }),
    );

    const first = await connect(toolbox);
    try {
      const tools = await first.client.listTools();
      expect(tools.tools.find((entry) => entry.name === 'swap')?.description).toBe(
        'first description',
      );
    } finally {
      await first.client.close();
      await first.server.close();
    }

    toolbox = toolbox.extend(
      createTool({
        name: 'swap',
        description: 'second description',
        input: z.object({}),
        async execute() {
          return 'second';
        },
      }),
    );

    const second = await connect(toolbox);
    try {
      const tools = await second.client.listTools();
      expect(tools.tools.find((entry) => entry.name === 'swap')?.description).toBe(
        'second description',
      );
    } finally {
      await second.client.close();
      await second.server.close();
    }
  });

  it('supports stdio transports via a loopback pair', async () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(
      createTool({
        name: 'ping',
        description: 'ping tool',
        input: z.object({}),
        async execute() {
          return { ok: true };
        },
      }),
    );

    const server = await createMCP(toolbox);
    const client = new Client({ name: 'toolbox-test-client', version: '0.0.0' });

    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const serverTransport = new StdioServerTransport(clientToServer, serverToClient);
    const clientTransport = new LoopbackTransport(serverToClient, clientToServer);

    await server.createServer().connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const tools = await client.listTools();
      expect(tools.tools.some((entry) => entry.name === 'ping')).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('registers resources and prompts through registrars', async () => {
    const toolbox: AnyToolbox = createToolbox();

    const { client, server } = await connect(toolbox, {
      resources: (mcp: McpRegistrarTarget) => {
        mcp.registerResource('readme', 'toolbox://readme', { title: 'README' }, async () => ({
          contents: [{ uri: 'toolbox://readme', text: 'hello' }],
        }));
      },
      prompts: (mcp: McpRegistrarTarget) => {
        mcp.registerPrompt('hello', { description: 'say hello' }, async () => ({
          messages: [
            {
              role: 'assistant',
              content: { type: 'text', text: 'hello' },
            },
          ],
        }));
      },
    });

    try {
      const resources = await client.listResources();
      expect(resources.resources.some((entry) => entry.name === 'readme')).toBe(true);

      const prompts = await client.listPrompts();
      expect(prompts.prompts.some((entry) => entry.name === 'hello')).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('marks failures as errors with a text payload', async () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(
      createTool({
        name: 'explode',
        description: 'throws',
        input: z.object({}),
        async execute() {
          throw new Error('boom');
        },
      }),
    );

    const { client, server } = await connect(toolbox);

    try {
      const result = await client.callTool({ name: 'explode', arguments: {} });
      expect(result.isError).toBe(true);
      expect(
        requiredValue(result.content as Array<{ type?: string }> | undefined, 'result content')[0]
          ?.type,
      ).toBe('text');
      expect(textContent(result.content)).toContain('boom');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects the MCP call when the client aborts', async () => {
    let toolbox: AnyToolbox = createToolbox();

    toolbox = toolbox.extend(
      createTool({
        name: 'wait',
        description: 'waits for abort',
        input: z.object({}),
        async execute() {
          return new Promise<{ ok: boolean }>(() => {});
        },
      }),
    );

    const { client, server } = await connect(toolbox);

    try {
      const controller = new AbortController();
      const call = client.callTool(
        { name: 'wait', arguments: {} },
        {
          signal: controller.signal,
        },
      );
      await Promise.resolve();
      controller.abort('stop');
      await expectPromiseToReject(call, (error) => expect(error).toBeDefined());
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('does not override explicit readOnlyHint annotations', async () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(
      createTool({
        name: 'readonly-override',
        description: 'read-only with explicit annotation',
        input: z.object({}),
        metadata: { readOnly: true },
        async execute() {
          return { ok: true };
        },
      }),
    );

    const { client, server } = await connect(toolbox, {
      toolConfiguration: () => ({
        annotations: { readOnlyHint: false },
      }),
    });

    try {
      const tools = await client.listTools();
      const tool = tools.tools.find((entry) => entry.name === 'readonly-override');
      expect(tool?.annotations?.readOnlyHint).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('applies registrars provided as arrays', async () => {
    const toolbox: AnyToolbox = createToolbox();

    const { client, server } = await connect(toolbox, {
      resources: [
        (mcp: McpRegistrarTarget) => {
          mcp.registerResource(
            'array-resource',
            'toolbox://array-resource',
            { title: 'Array Resource' },
            async () => ({
              contents: [{ uri: 'toolbox://array-resource', text: 'hi' }],
            }),
          );
        },
      ],
      prompts: [
        (mcp: McpRegistrarTarget) => {
          mcp.registerPrompt('array-prompt', { description: 'array prompt' }, async () => ({
            messages: [
              {
                role: 'assistant',
                content: { type: 'text', text: 'array hello' },
              },
            ],
          }));
        },
      ],
    });

    try {
      const resources = await client.listResources();
      expect(resources.resources.some((entry) => entry.name === 'array-resource')).toBe(true);

      const prompts = await client.listPrompts();
      expect(prompts.prompts.some((entry) => entry.name === 'array-prompt')).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('converts JSON schema variants and raw shapes for MCP tools', async () => {
    let toolbox: AnyToolbox = createToolbox();

    const baseTool = (name: string) =>
      (toolbox = toolbox.extend(
        createTool({
          name,
          description: 'schema conversion',
          input: z.object({ fromTool: z.boolean() }),
          async execute() {
            return { ok: true };
          },
        }),
      ));

    baseTool('any-of');
    baseTool('one-of');
    baseTool('all-of');
    baseTool('raw-shape');
    baseTool('invalid-schema');

    const { client, server } = await connect(toolbox, {
      toolConfiguration: (tool: Tool) => {
        switch (tool.name) {
          case 'any-of':
            return {
              schema: {
                anyOf: [
                  { enum: ['alpha', 'beta'] },
                  { enum: ['ok', { bad: true }] },
                  { const: 42 },
                  {
                    type: 'array',
                    items: [{ type: 'string' }, { type: 'number' }],
                  },
                  {
                    type: 'array',
                    items: { type: 'boolean' },
                  },
                  {
                    type: 'object',
                    properties: { foo: { type: 'string' } },
                    required: ['foo'],
                    additionalProperties: false,
                  },
                  {
                    type: 'object',
                    additionalProperties: { type: 'string' },
                  },
                ],
                nullable: true,
              },
            };
          case 'one-of':
            return {
              schema: {
                oneOf: [{ type: ['string', 'number'] }, { type: 'integer' }, { type: 'null' }],
              },
            };
          case 'all-of':
            return {
              schema: {
                allOf: [
                  {
                    type: 'object',
                    properties: { foo: { type: 'string' } },
                    required: ['foo'],
                    additionalProperties: false,
                  },
                  {
                    additionalProperties: { type: 'number' },
                  },
                ],
              },
            };
          case 'raw-shape':
            return {
              schema: { raw: z.string(), count: z.number() },
            };
          case 'invalid-schema':
            return {
              schema: 123 as unknown as object,
            };
          default:
            return {};
        }
      },
    });

    try {
      const tools = await client.listTools();
      const anyOf = tools.tools.find((entry) => entry.name === 'any-of');
      const oneOf = tools.tools.find((entry) => entry.name === 'one-of');
      const allOf = tools.tools.find((entry) => entry.name === 'all-of');
      const rawShape = tools.tools.find((entry) => entry.name === 'raw-shape');
      const invalidSchema = tools.tools.find((entry) => entry.name === 'invalid-schema');

      expect(anyOf?.inputSchema).toBeDefined();
      expect(oneOf?.inputSchema).toBeDefined();
      expect(allOf?.inputSchema).toBeDefined();
      expect(rawShape?.inputSchema?.properties).toHaveProperty('raw');
      expect(invalidSchema?.inputSchema?.properties).toHaveProperty('fromTool');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('uses formatResult when provided', async () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(
      createTool({
        name: 'custom-format',
        description: 'format',
        input: z.object({}),
        async execute() {
          return { ok: true };
        },
      }),
    );

    const { client, server } = await connect(toolbox, {
      formatResult: () => ({
        content: [{ type: 'text', text: 'formatted' }],
      }),
    });

    try {
      const result = await client.callTool({ name: 'custom-format', arguments: {} });
      expect(textContent(result.content)).toBe('formatted');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns empty content for undefined results', async () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(
      createTool({
        name: 'empty-result',
        description: 'returns nothing',
        input: z.object({}),
        async execute() {
          return undefined;
        },
      }),
    );

    const { client, server } = await connect(toolbox);

    try {
      const result = await client.callTool({ name: 'empty-result', arguments: {} });
      expect(result.content).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('stringifies unserializable results', async () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(
      createTool({
        name: 'bigint-result',
        description: 'returns bigint',
        input: z.object({}),
        async execute() {
          return 1n;
        },
      }),
    );

    const { client, server } = await connect(toolbox);

    try {
      const result = await client.callTool({ name: 'bigint-result', arguments: {} });
      expect(textContent(result.content)).toBe('[unserializable]');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('marks tools as errors when executeWith throws', async () => {
    const tool = {
      name: 'throwing-exec',
      description: 'throws in executeWith',
      input: z.object({}),
      metadata: undefined,
      tags: [],
      executeWith: async () => {
        throw new Error('explode');
      },
    };
    const toolbox = {
      tools: () => [tool],
      addEventListener: () => {},
      register: () => toolbox,
      getTool: () => undefined,
      execute: async () => ({ outcome: 'success', toolCallId: 'unused' }),
      toJSON: () => [],
    } as unknown as ReturnType<typeof createToolbox>;

    const { client, server } = await connect(toolbox);

    try {
      const result = await client.callTool({ name: 'throwing-exec', arguments: {} });
      expect(result.isError).toBe(true);
      expect(textContent(result.content)).toContain('explode');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects invalid inputs when normalizing tools for MCP conversion', () => {
    expect(() => toMcpTools([{} as unknown as Tool])).toThrow('Invalid tool input');
    expect(() =>
      toMcpTools({
        name: 'not-a-tool',
        description: 'missing executeWith',
        input: z.object({}),
      } as unknown as Tool),
    ).toThrow('Invalid input');
    expect(() => toMcpTools(42 as unknown as Tool)).toThrow('Invalid input');
  });

  it('maps readOnly annotations and MCP labels into tool metadata', async () => {
    const [tool = requiredValue<never>(undefined, 'tool')] = fromMcpTools([
      {
        name: 'annotated',
        title: 'Annotated title',
        description: 'annotated description',
        annotations: { readOnlyHint: true },
        inputSchema: z.object({}),
        handler: async () => ({
          content: [{ type: 'text', text: '{"ok":true}' }],
          structuredContent: { ok: true },
        }),
      },
    ]);

    expect(tool.metadata).toEqual({
      readOnly: true,
      mcp: {
        title: 'Annotated title',
        description: 'annotated description',
      },
    });
    expect(await tool.execute({})).toEqual({ ok: true });
  });

  it('parses MCP content blocks and error payloads across edge cases', async () => {
    const [errorTool = requiredValue<never>(undefined, 'error tool')] = fromMcpTools([
      {
        name: 'error-tool',
        description: 'returns MCP errors',
        inputSchema: z.object({}),
        handler: async () => ({
          isError: true,
          content: [
            { type: 'text', text: 'first line' },
            { type: 'text', text: 'second line' },
          ],
        }),
      },
    ]);
    await expectPromiseToReject(errorTool.execute({}), (error) =>
      expect(() => {
        throw error;
      }).toThrow('first line\nsecond line'),
    );

    const mixedContent = [
      { type: 'text', text: '{"ok":true}' },
      { type: 'image', mimeType: 'image/png', data: 'x' },
    ] as const;
    const [mixedTool = requiredValue<never>(undefined, 'mixed tool')] = fromMcpTools([
      {
        name: 'mixed-content',
        description: 'returns non-text content too',
        inputSchema: z.object({}),
        handler: async () => ({ content: [...mixedContent] }),
      },
    ]);
    expect(await mixedTool.execute({})).toEqual([...mixedContent]);

    const [singleTextTool = requiredValue<never>(undefined, 'single text tool')] = fromMcpTools([
      {
        name: 'single-text',
        description: 'returns plain text',
        inputSchema: z.object({}),
        handler: async () => ({ content: [{ type: 'text', text: 'not-json' }] }),
      },
    ]);
    expect(await singleTextTool.execute({})).toBe('not-json');

    const [multiTextTool = requiredValue<never>(undefined, 'multi text tool')] = fromMcpTools([
      {
        name: 'multi-text',
        description: 'returns multiple text blocks',
        inputSchema: z.object({}),
        handler: async () => ({
          content: [
            { type: 'text', text: '{"ok":true}' },
            { type: 'text', text: 'plain' },
          ],
        }),
      },
    ]);
    expect(await multiTextTool.execute({})).toEqual([{ ok: true }, 'plain']);
  });

  it('re-registers duplicate tool names and keeps the latest definition', async () => {
    const first = createTool({
      name: 'duplicate-name',
      description: 'first',
      input: z.object({}),
      async execute() {
        return 'first';
      },
    });
    const second = createTool({
      name: 'duplicate-name',
      description: 'second',
      input: z.object({}),
      async execute() {
        return 'second';
      },
    });
    const toolbox = {
      tools: () => [first, second],
    } as unknown as ReturnType<typeof createToolbox>;

    const { client, server } = await connect(toolbox);
    try {
      const tools = await client.listTools();
      const tool = tools.tools.find((entry) => entry.name === 'duplicate-name');
      expect(tool?.description).toBe('second');

      const call = await client.callTool({ name: 'duplicate-name', arguments: {} });
      expect(textContent(call.content)).toContain('second');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('merges readOnly metadata into existing MCP annotations', () => {
    const tool = createTool({
      name: 'annotation-merge',
      description: 'merges annotations',
      input: z.object({}),
      metadata: {
        readOnly: true,
        mcp: {
          annotations: {
            destructiveHint: false,
          },
        },
      },
      async execute() {
        return { ok: true };
      },
    });

    const [mcpTool = requiredValue<never>(undefined, 'MCP tool')] = toMcpTools([tool]);
    expect(mcpTool?.annotations).toEqual({
      destructiveHint: false,
      readOnlyHint: true,
    });
  });

  it('falls back for unknown schema types and handles empty enums', () => {
    const baseTool = createTool({
      name: 'schema-edges',
      description: 'schema edge cases',
      input: z.object({ fromTool: z.boolean() }),
      async execute() {
        return { ok: true };
      },
    });

    const [unknownType] = toMcpTools([baseTool], {
      toolConfiguration: () => ({
        schema: { type: 'mystery' },
      }),
    });
    expect(unknownType?.inputSchema).toBe(baseTool.input);

    const [emptyEnum] = toMcpTools([baseTool], {
      toolConfiguration: () => ({
        schema: { enum: [] },
      }),
    });
    expect(emptyEnum!.inputSchema.safeParse('value').success).toBe(false);
  });

  it('stringifies primitive successful results for MCP tool responses', async () => {
    const tool = createTool({
      name: 'numeric-result',
      description: 'returns a number',
      input: z.object({}),
      async execute() {
        return 42;
      },
    });

    const [mcpTool = requiredValue<never>(undefined, 'MCP tool')] = toMcpTools([tool]);
    const result = await mcpTool.handler({});
    expect(textContent(result.content)).toBe('42');
    expect(result.structuredContent).toBeUndefined();
  });

  it('supports single tool-like inputs in toMcpTools()', async () => {
    let receivedExecuteOptions: Record<string, unknown> | undefined;
    let signalAfterRequestAbort: { aborted: boolean; reason: unknown } | undefined;
    const controller = new AbortController();
    const toolLike = {
      name: 'single-tool-like',
      description: 'single tool-like input',
      input: z.object({}),
      tags: [],
      async executeWith(options: Record<string, unknown>) {
        receivedExecuteOptions = options;
        // Cancelling the MCP request while the call is in flight must abort the execution's signal.
        controller.abort(new Error('request cancelled'));
        const signal = options['signal'] as AbortSignal;
        signalAfterRequestAbort = { aborted: signal.aborted, reason: signal.reason };
        return {
          outcome: 'success',
          toolCallId: 'single-tool-like-call',
          result: { ok: true },
          content: { ok: true },
          toolName: 'single-tool-like',
        };
      },
    } as unknown as Tool;

    const [mcpTool = requiredValue<never>(undefined, 'MCP tool')] = toMcpTools(toolLike);
    expect(mcpTool?.name).toBe('single-tool-like');
    expect(
      await mcpTool.handler({}, {
        mcpReq: {
          id: 'single-tool-like-request',
          signal: controller.signal,
          elicitInput: async () => ({ action: 'accept', content: {} }),
        },
      } as never),
    ).toMatchObject({
      structuredContent: { ok: true },
    });
    expect(receivedExecuteOptions).toMatchObject({
      callId: 'single-tool-like-request',
      elicit: expect.any(Function),
      executionContext: { mcp: { era: 'legacy', requestId: 'single-tool-like-request' } },
    });
    expect(signalAfterRequestAbort?.aborted).toBe(true);
    expect(signalAfterRequestAbort?.reason).toEqual(new Error('request cancelled'));
  });

  it('returns undefined when MCP content blocks are empty', async () => {
    const [tool = requiredValue<never>(undefined, 'tool')] = fromMcpTools([
      {
        name: 'empty-content',
        description: 'empty content payload',
        inputSchema: z.object({}),
        handler: async () => ({ content: [] }),
      },
    ]);

    expect(await tool.execute({})).toBeUndefined();
  });

  it('derives readOnly annotations from metadata.mcp when missing', () => {
    const tool = createTool({
      name: 'metadata-readonly',
      description: 'metadata readOnly hint',
      input: z.object({}),
      metadata: {
        readOnly: true,
        mcp: {
          title: 'metadata title',
        },
      },
      async execute() {
        return { ok: true };
      },
    });

    const [mcpTool = requiredValue<never>(undefined, 'MCP tool')] = toMcpTools([tool]);
    expect(mcpTool?.title).toBe('metadata title');
    expect(mcpTool?.annotations?.readOnlyHint).toBe(true);
  });
});

describe('MCP elicitation', () => {
  const createApprovalToolbox = () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(
      createTool({
        name: 'approve-purchase',
        description: 'requests human approval before completing a purchase',
        input: z.object({ amount: z.number() }),
        async execute({ amount }, context) {
          if (!context.elicit) {
            throw new Error('elicitation unavailable in this context');
          }
          const response = await context.elicit({
            message: `Approve purchase of $${amount}?`,
            mode: 'form',
            schema: {
              type: 'object',
              properties: { approved: { type: 'boolean' } },
              required: ['approved'],
            },
          });
          if (response.action !== 'accept' || response.content?.['approved'] !== true) {
            return { completed: false };
          }
          return { completed: true };
        },
      }),
    );
    return toolbox;
  };

  const connectWithElicitation = async (
    toolbox: ReturnType<typeof createToolbox>,
    respond: ToolElicitationRequester,
  ) => {
    const server = await createMCP(toolbox);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: 'elicitation-client', version: '0.0.0' },
      { capabilities: { elicitation: {} } },
    );
    client.setRequestHandler('elicitation/create', createMcpElicitationHandler(respond));
    await server.createServer().connect(serverTransport);
    await client.connect(clientTransport);
    return { client, server };
  };

  it('lets an MCP server tool request elicitation from the connecting client (server direction)', async () => {
    const requests: ToolElicitationRequest[] = [];
    const { client, server } = await connectWithElicitation(
      createApprovalToolbox(),
      async (request) => {
        requests.push(request);
        return { action: 'accept', content: { approved: true } };
      },
    );

    try {
      const result = await client.callTool({
        name: 'approve-purchase',
        arguments: { amount: 42 },
      });

      expect(requests).toHaveLength(1);
      expect(requests[0]).toEqual({
        message: 'Approve purchase of $42?',
        mode: 'form',
        schema: {
          type: 'object',
          properties: { approved: { type: 'boolean' } },
          required: ['approved'],
        },
      });
      expect(result.structuredContent).toEqual({ completed: true });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('propagates a declined elicitation back to the tool result (server direction)', async () => {
    const { client, server } = await connectWithElicitation(createApprovalToolbox(), async () => ({
      action: 'decline',
    }));

    try {
      const result = await client.callTool({
        name: 'approve-purchase',
        arguments: { amount: 42 },
      });
      expect(result.structuredContent).toEqual({ completed: false });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects an accepted elicitation whose content does not match the requested schema (server direction)', async () => {
    const { client, server } = await connectWithElicitation(createApprovalToolbox(), async () => ({
      action: 'accept',
      // `approved` is a string, but the tool's schema requires a boolean.
      content: { approved: 'yes' },
    }));

    try {
      const result = await client.callTool({
        name: 'approve-purchase',
        arguments: { amount: 42 },
      });
      expect(result.isError).toBe(true);
      expect(textContent(result.content)).toContain(
        'Elicitation response content does not match requested schema',
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('surfaces a server elicitation request through fromMcpTools (client direction)', async () => {
    const requests: ToolElicitationRequest[] = [];
    const { client, server } = await connectWithElicitation(
      createApprovalToolbox(),
      async (request) => {
        requests.push(request);
        return { action: 'accept', content: { approved: true } };
      },
    );

    try {
      const listed = await client.listTools();
      const [tool = requiredValue<never>(undefined, 'tool')] = fromMcpTools(listed.tools, {
        callTool: (request) => client.callTool(request),
      });

      const result = await tool.execute({ amount: 10 });

      expect(requests).toHaveLength(1);
      expect(requests[0]?.message).toBe('Approve purchase of $10?');
      expect(result).toEqual({ completed: true });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('leaves context.elicit undefined for a client that did not declare the elicitation capability', async () => {
    const toolbox = createApprovalToolbox();
    const server = await createMCP(toolbox);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    // No `capabilities: { elicitation: {} }` — this client cannot answer elicitation requests.
    const client = new Client({ name: 'no-elicitation-client', version: '0.0.0' });
    await server.createServer().connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: 'approve-purchase',
        arguments: { amount: 42 },
      });

      expect(result.isError).toBe(true);
      expect(textContent(result.content)).toBe('elicitation unavailable in this context');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('propagates the tool call abort signal into the underlying elicitation request', async () => {
    const controller = new AbortController();
    const elicitInputCalls: Array<{ params: unknown; options: unknown }> = [];
    const fakeExtra = {
      mcpReq: {
        signal: controller.signal,
        elicitInput: async (params: unknown, options: unknown) => {
          elicitInputCalls.push({ params, options });
          return { action: 'accept', content: {} };
        },
      },
    } as unknown as Parameters<typeof createMcpToolElicitationRequester>[0];

    const requester = createMcpToolElicitationRequester(fakeExtra);
    await requester({ message: 'Approve?', mode: 'form', schema: { type: 'object' } });

    expect(elicitInputCalls).toHaveLength(1);
    expect(elicitInputCalls[0]?.options).toEqual({ signal: controller.signal });
  });

  it('translates URL elicitation requests and decline/cancel responses', async () => {
    const requests: unknown[] = [];
    const responses = [{ action: 'decline' as const }, { action: 'cancel' as const }];
    const fakeExtra = {
      mcpReq: {
        signal: new AbortController().signal,
        elicitInput: async (params: unknown) => {
          requests.push(params);
          return responses.shift();
        },
      },
    } as unknown as Parameters<typeof createMcpToolElicitationRequester>[0];
    const requester = createMcpToolElicitationRequester(fakeExtra);

    await expectPromiseToReject(
      requester({ message: 'Open approval page', mode: 'url' } as ToolElicitationRequest),
      (error) =>
        expect(() => {
          throw error;
        }).toThrow('requires a `url`'),
    );
    expect(
      await requester({
        message: 'Open approval page',
        mode: 'url',
        url: 'https://app.example.com/approve',
      }),
    ).toEqual({ action: 'decline' });
    expect(await requester({ message: 'Cancel?', mode: 'form' })).toEqual({
      action: 'cancel',
    });
    expect(requests[0]).toMatchObject({
      mode: 'url',
      message: 'Open approval page',
      url: 'https://app.example.com/approve',
    });

    let translatedRequest: ToolElicitationRequest | undefined;
    const handler = createMcpElicitationHandler(async (request) => {
      translatedRequest = request;
      return { action: 'cancel' };
    });
    await handler(
      {
        method: 'elicitation/create',
        params: {
          mode: 'url',
          message: 'Review request',
          url: 'https://app.example.com/review',
          elicitationId: 'elicit-1',
        },
      },
      {} as never,
    );
    expect(translatedRequest).toEqual({
      mode: 'url',
      message: 'Review request',
      url: 'https://app.example.com/review',
    });
  });
});

function createDeferred<T>() {
  let deferredResolve!: (value: T) => void;
  let deferredReject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    deferredResolve = resolve;
    deferredReject = reject;
  });
  return { promise, resolve: deferredResolve, reject: deferredReject };
}
