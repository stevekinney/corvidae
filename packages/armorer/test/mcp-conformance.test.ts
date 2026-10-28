import {
  createContextKey,
  propagation,
  type Context,
  type TextMapPropagator,
} from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { createTool } from '../src/create-tool';
import { createToolbox } from '../src/create-toolbox';
import {
  createMCP,
  fromMcpClientTools,
  MCP_JSON_SCHEMA_DIALECT,
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION,
  type MCPRequestExecutionContext,
  type MCPServer,
} from '../src/index';
import { toCallToolResult } from '../src/integrations/mcp/content';
import { toolContent } from '../src/protocol';
import { connectInProcessClient, type NegotiationMode } from './fixtures/mcp-in-process-client';
import { createStoreDouble } from './fixtures/mcp-task-harness';

/**
 * Dual-era conformance: the official SDK client, pinned to 2026-07-28 or
 * speaking the 2025-11-25 `initialize` handshake, against one `createMCP`
 * endpoint served through the SDK's HTTP entry. Every behavior below is
 * asserted in both eras.
 */

const RICH_BLOCKS = [
  { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
  { type: 'text', text: 'between the image and the audio' },
  { type: 'audio', data: 'UklGRg==', mimeType: 'audio/wav' },
  { type: 'resource_link', uri: 'file:///report.md', name: 'report' },
  {
    type: 'resource',
    resource: { uri: 'file:///notes.txt', mimeType: 'text/plain', text: 'notes' },
  },
] as const;

const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

type Observed = { mcp?: MCPRequestExecutionContext; traceContext?: unknown; aborted?: boolean };

/**
 * Records the carrier the global propagator was asked to extract, so a test
 * can tell that the trace context the tool received came from the request's
 * `_meta` rather than an empty root context.
 */
const EXTRACTED_TRACEPARENT = createContextKey('armorer.test.extracted-traceparent');
const EXTRACTED_BAGGAGE = createContextKey('armorer.test.extracted-baggage');
const recordingPropagator: TextMapPropagator = {
  inject() {},
  extract(context, carrier, getter) {
    return context
      .setValue(EXTRACTED_TRACEPARENT, getter.get(carrier, 'traceparent'))
      .setValue(EXTRACTED_BAGGAGE, getter.get(carrier, 'baggage'));
  },
  fields: () => ['traceparent', 'tracestate', 'baggage'],
};

const holdStarted = { resolve: () => {} };

function createConformanceToolbox(observed: Observed[]) {
  const sum = createTool({
    name: 'sum',
    description: 'adds two numbers',
    input: z.object({ a: z.number(), b: z.number() }),
    async execute({ a, b }, context) {
      observed.push({
        mcp: context.executionContext?.['mcp'] as MCPRequestExecutionContext,
        traceContext: context.traceContext,
      });
      return { total: a + b };
    },
  });
  const media = createTool({
    name: 'media',
    description: 'returns every MCP content block kind',
    input: z.object({}),
    async execute() {
      return RICH_BLOCKS;
    },
  });
  const hold = createTool({
    name: 'hold',
    description: 'waits until cancelled',
    input: z.object({}),
    async execute(_params, context) {
      const record: Observed = { aborted: false };
      observed.push(record);
      holdStarted.resolve();
      return new Promise((_resolve, reject) => {
        context.signal?.addEventListener('abort', () => {
          record.aborted = true;
          reject(new Error('cancelled'));
        });
      });
    },
  });
  const ledger = createTool({
    name: 'ledger',
    description: 'opts into MCP tasks',
    input: z.object({ account: z.string() }),
    metadata: { mcp: { taskBacked: true } },
    async execute({ account }) {
      return { account, balance: 42 };
    },
  });
  return createToolbox([sum, media, hold, ledger]);
}

const eras: Array<{ era: 'modern' | 'legacy'; mode: NegotiationMode; version: string }> = [
  { era: 'modern', mode: { pin: MCP_PROTOCOL_VERSION }, version: MCP_PROTOCOL_VERSION },
  { era: 'legacy', mode: 'legacy', version: MCP_LEGACY_PROTOCOL_VERSION },
];

let endpoints: MCPServer[] = [];
afterEach(async () => {
  await Promise.all(endpoints.map((endpoint) => endpoint.close()));
  endpoints = [];
});

async function createEndpoint(observed: Observed[]) {
  const mcp = await createMCP(createConformanceToolbox(observed), {
    serverInfo: { name: 'armorer-conformance', version: '1.0.0' },
    taskStore: createStoreDouble(),
    cacheHints: { 'tools/list': { ttlMs: 60_000 } },
    resources: (server, context) => {
      server.registerResource('era', 'armorer://era', { title: 'Era' }, async () => ({
        contents: [{ uri: 'armorer://era', text: context.era }],
      }));
    },
    prompts: (server) => {
      server.registerPrompt('greet', { description: 'says hello' }, async () => ({
        messages: [{ role: 'assistant', content: { type: 'text', text: 'hello' } }],
      }));
    },
  });
  endpoints.push(mcp);
  return mcp;
}

describe.each(eras)('MCP conformance ($era era)', ({ era, mode, version }) => {
  it('negotiates the era and publishes JSON Schema 2020-12 tool schemas', async () => {
    const mcp = await createEndpoint([]);
    const { client } = await connectInProcessClient(mcp, mode);
    try {
      expect(client.getProtocolEra()).toBe(era);
      expect(client.getNegotiatedProtocolVersion()).toBe(version);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).toSorted()).toEqual(['hold', 'ledger', 'media', 'sum']);
      const sum = tools.find((tool) => tool.name === 'sum');
      expect(sum?.inputSchema).toMatchObject({
        $schema: MCP_JSON_SCHEMA_DIALECT,
        type: 'object',
        required: ['a', 'b'],
      });
    } finally {
      await client.close();
    }
  });

  it('validates arguments and returns structured content with its text mirror', async () => {
    const mcp = await createEndpoint([]);
    const { client } = await connectInProcessClient(mcp, mode);
    try {
      const result = await client.callTool({ name: 'sum', arguments: { a: 2, b: 3 } });
      expect(result.structuredContent).toEqual({ total: 5 });
      expect(result.content).toEqual([
        { type: 'text', text: JSON.stringify({ total: 5 }, null, 2) },
      ]);

      const invalid = await client.callTool({ name: 'sum', arguments: { a: 'two', b: 3 } });
      expect(invalid.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('preserves every content block kind in order instead of serializing it as text', async () => {
    const mcp = await createEndpoint([]);
    const { client } = await connectInProcessClient(mcp, mode);
    try {
      const result = await client.callTool({ name: 'media', arguments: {} });
      expect(result.content).toEqual([...RICH_BLOCKS]);
      expect(result.structuredContent).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it('serves resources and prompts from the same factory', async () => {
    const mcp = await createEndpoint([]);
    const { client } = await connectInProcessClient(mcp, mode);
    try {
      const resource = await client.readResource({ uri: 'armorer://era' });
      expect(resource.contents).toEqual([{ uri: 'armorer://era', text: era }]);
      const prompt = await client.getPrompt({ name: 'greet' });
      expect(prompt.messages).toEqual([
        { role: 'assistant', content: { type: 'text', text: 'hello' } },
      ]);
    } finally {
      await client.close();
    }
  });

  it('hands the request protocol identity, client facts, and trace context to the tool', async () => {
    const observed: Observed[] = [];
    const mcp = await createEndpoint(observed);
    const { client } = await connectInProcessClient(mcp, mode, {
      capabilities: { elicitation: {} },
    });
    propagation.setGlobalPropagator(recordingPropagator);
    try {
      await client.callTool({
        name: 'sum',
        arguments: { a: 1, b: 1 },
        _meta: { traceparent: TRACEPARENT, tracestate: 'armorer=1' },
      });
      const [call] = observed;
      expect(call?.mcp).toMatchObject({
        era,
        method: 'tools/call',
        trace: { traceparent: TRACEPARENT, tracestate: 'armorer=1' },
      });
      expect(call?.mcp?.requestId).toBeString();
      expect((call?.traceContext as Context | undefined)?.getValue(EXTRACTED_TRACEPARENT)).toBe(
        TRACEPARENT,
      );
      if (era === 'modern') {
        // The 2026-07-28 envelope carries these on every request.
        expect(call?.mcp).toMatchObject({
          protocolVersion: MCP_PROTOCOL_VERSION,
          clientInfo: { name: 'armorer-conformance-client', version: '1.0.0' },
          clientCapabilities: { elicitation: {} },
        });
      } else {
        // The stateless 2025 lane never sees the initialize handshake.
        expect(call?.mcp?.clientInfo).toBeUndefined();
        expect(call?.mcp?.clientCapabilities).toBeUndefined();
      }
    } finally {
      propagation.disable();
      await client.close();
    }
  });

  it('extracts baggage into the trace context when the request carries no traceparent', async () => {
    const observed: Observed[] = [];
    const mcp = await createEndpoint(observed);
    const { client } = await connectInProcessClient(mcp, mode);
    propagation.setGlobalPropagator(recordingPropagator);
    try {
      await client.callTool({
        name: 'sum',
        arguments: { a: 1, b: 1 },
        _meta: { baggage: 'tenant=armorer' },
      });
      const [call] = observed;
      expect(call?.mcp?.trace).toEqual({ baggage: 'tenant=armorer' });
      expect((call?.traceContext as Context | undefined)?.getValue(EXTRACTED_BAGGAGE)).toBe(
        'tenant=armorer',
      );
    } finally {
      propagation.disable();
      await client.close();
    }
  });

  it('cancels the tool execution as far as the era allows', async () => {
    const observed: Observed[] = [];
    const mcp = await createEndpoint(observed);
    const { client } = await connectInProcessClient(mcp, mode);
    try {
      const started = new Promise<void>((resolve) => {
        holdStarted.resolve = resolve;
      });
      const controller = new AbortController();
      const call = client.callTool({ name: 'hold', arguments: {} }, { signal: controller.signal });
      await started;
      controller.abort(new Error('user pressed stop'));
      expect(await throwingRejectionOf(call)).toThrow();
      if (era === 'modern') {
        // 2026-07-28: closing the request's response stream aborts the execution.
        await mcp.executionLifecycle.whenIdle();
        expect(observed[0]?.aborted).toBe(true);
      } else {
        // The stateless 2025 lane answers `notifications/cancelled` on a fresh
        // per-request instance that does not own the running call, so only
        // shutdown reaches it. Sessionful 2025 transports (stdio) cancel.
        expect(observed[0]?.aborted).toBe(false);
        await mcp.shutdown();
        expect(observed[0]?.aborted).toBe(true);
      }
    } finally {
      await client.close();
    }
  });

  it('drives the remote tools as Armorer tools through fromMcpClientTools', async () => {
    const mcp = await createEndpoint([]);
    const { client } = await connectInProcessClient(mcp, mode);
    try {
      const tools = await fromMcpClientTools(client, { serverId: 'conformance' });
      const sum = tools.find((tool) => tool.name === 'sum');
      const media = tools.find((tool) => tool.name === 'media');
      expect(await sum?.execute({ a: 4, b: 5 })).toEqual({ total: 9 });
      // Every MCP block type arrives as an ordered portable part.
      expect(await media?.execute({})).toEqual(
        toolContent([
          {
            type: 'image',
            mimeType: 'image/png',
            source: { kind: 'inline', data: 'iVBORw0KGgo=', encoding: 'base64' },
          },
          { type: 'text', text: 'between the image and the audio' },
          {
            type: 'audio',
            mimeType: 'audio/wav',
            source: { kind: 'inline', data: 'UklGRg==', encoding: 'base64' },
          },
          {
            type: 'file',
            name: 'report',
            source: { kind: 'mcp-resource', serverId: 'conformance', uri: 'file:///report.md' },
          },
          {
            type: 'document',
            mimeType: 'text/plain',
            source: { kind: 'inline', data: 'notes', encoding: 'utf8' },
            metadata: { mcpResourceUri: 'file:///notes.txt' },
          },
        ]),
      );
      // Re-exposing that result over MCP emits the same blocks in the same order.
      const reexported = await createToolbox(tools).execute({ name: 'media', arguments: {} });
      expect(toCallToolResult(reexported).content).toEqual([...RICH_BLOCKS]);
      // Without a serverId, a resource link cannot be referenced and the call fails.
      const unidentified = await fromMcpClientTools(client);
      const unidentifiedMedia = unidentified.find((tool) => tool.name === 'media');
      const failed = await createToolbox(unidentifiedMedia ? [unidentifiedMedia] : []).execute({
        name: 'media',
        arguments: {},
      });
      expect(failed.error?.message).toMatch(/no serverId was configured/);
    } finally {
      await client.close();
    }
  });

  it('answers an opted-in tool synchronously to a client that does not declare the Tasks extension', async () => {
    const mcp = await createEndpoint([]);
    const { client } = await connectInProcessClient(mcp, mode);
    try {
      const result = await client.callTool({ name: 'ledger', arguments: { account: 'ops' } });

      expect(result.structuredContent).toEqual({ account: 'ops', balance: 42 });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });
});

describe('MCP conformance (transport behavior owned by the SDK)', () => {
  it('sends Mcp-Method and Mcp-Name on 2026-07-28 requests and caches tools/list per the server hint', async () => {
    const mcp = await createEndpoint([]);
    const { client, exchanges } = await connectInProcessClient(mcp, {
      pin: MCP_PROTOCOL_VERSION,
    });
    try {
      await client.listTools();
      await client.listTools();
      await client.callTool({ name: 'sum', arguments: { a: 1, b: 2 } });
      expect(exchanges.filter((exchange) => exchange.method === 'tools/list')).toHaveLength(1);
      const call = exchanges.find((exchange) => exchange.method === 'tools/call');
      expect(call?.headers['mcp-method']).toBe('tools/call');
      expect(call?.headers['mcp-name']).toBe('sum');
      expect(call?.headers['mcp-protocol-version']).toBe(MCP_PROTOCOL_VERSION);
    } finally {
      await client.close();
    }
  });

  it('lands an auto-negotiating client on 2026-07-28', async () => {
    const mcp = await createEndpoint([]);
    const { client } = await connectInProcessClient(mcp, 'auto');
    try {
      expect(client.getProtocolEra()).toBe('modern');
      expect(client.getNegotiatedProtocolVersion()).toBe(MCP_PROTOCOL_VERSION);
    } finally {
      await client.close();
    }
  });
});
