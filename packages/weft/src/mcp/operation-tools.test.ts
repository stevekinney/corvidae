/**
 * COR-839 — a catalog's `mcpExposable` operations served as MCP tools through
 * `createOperationMcpMount`, driven by the official SDK client in both eras.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AuthContext } from '../server/authentication.ts';
import {
  createTestHost,
  readerContext,
  strangerContext,
  testEventSchema,
  type TestHost,
} from '../server/handler/operation-handler.test-support.ts';
import { createOperationHandler } from '../server/handler/operation-handler.ts';
import { defineOperation } from '../server/operation-registry.ts';
import type { NegotiationMode } from './mcp-client.test-support.ts';
import { createOperationMcpMount } from './operation-tools.ts';
import { MCP_LEGACY_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION } from './protocol.ts';

const transports = { http: true, jsonRpcHttp: true, jsonRpcWebSocket: false, jsonRpcStdio: false };

const echo = defineOperation<
  z.ZodObject<{ message: z.ZodString }>,
  z.ZodObject<{ message: z.ZodString }>,
  TestHost
>({
  name: 'probe.echo',
  mcpExposable: true,
  summary: 'Echo a message',
  description: 'Answers with the message it was given.',
  destructive: false,
  inputSchema: z.object({ message: z.string() }),
  outputSchema: z.object({ message: z.string() }),
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['events:read'] } },
  transports,
  unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
  invoke: async ({ input }) => ({ message: input.message }),
});

const hidden = defineOperation<z.ZodObject<{}>, z.ZodObject<{}>, TestHost>({
  name: 'probe.hidden',
  mcpExposable: false,
  summary: 'Not an MCP tool',
  destructive: false,
  inputSchema: z.object({}),
  outputSchema: z.object({}),
  access: { kind: 'public' },
  transports,
  unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
  invoke: async () => ({}),
});

const missing = defineOperation<z.ZodObject<{ id: z.ZodString }>, z.ZodObject<{}>, TestHost>({
  name: 'probe.missing',
  mcpExposable: true,
  summary: 'Always missing',
  destructive: true,
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({}),
  access: { kind: 'authenticated' },
  producibleFaults: ['NotFound'],
  transports,
  unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
  invoke: async ({ input }) => {
    throw { code: 'NotFound', message: `no such thing: ${input.id}`, data: { kind: 'thing' } };
  },
});

const eventsInput = z.object({ fromCursor: z.string().min(1).optional() });
const eventsEnvelope = z.object({ subscriptionId: z.string(), cursor: z.string() });

const events = defineOperation<
  typeof eventsInput,
  typeof eventsEnvelope,
  typeof testEventSchema,
  TestHost
>({
  name: 'probe.events',
  kind: 'subscription',
  mcpExposable: true,
  summary: 'Follow the probe feed',
  destructive: false,
  inputSchema: eventsInput,
  outputSchema: eventsEnvelope,
  eventSchema: testEventSchema,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['events:read'] } },
  transports: { http: true, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: false },
  unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
  invoke: async ({ input, host }) => {
    const controller = new AbortController();
    return {
      envelope: { subscriptionId: 'sub_1', cursor: input.fromCursor ?? '0' },
      iterable: host.feed.subscribe(input.fromCursor, controller.signal),
      close: async () => {
        host.closed.count += 1;
        controller.abort();
      },
    };
  },
});

const eras: Array<{ era: string; mode: NegotiationMode; version: string }> = [
  { era: 'modern', mode: { pin: MCP_PROTOCOL_VERSION }, version: MCP_PROTOCOL_VERSION },
  { era: 'legacy', mode: 'legacy', version: MCP_LEGACY_PROTOCOL_VERSION },
];

const clients: Client[] = [];
afterEach(async () => {
  while (clients.length > 0) await clients.pop()!.close();
});

async function connect(mode: NegotiationMode, caller: () => AuthContext = readerContext) {
  const host = createTestHost();
  const handler = createOperationHandler({
    operations: [echo, hidden, missing, events],
    host,
    authenticate: async () => caller(),
    mounts: [createOperationMcpMount({ idleMs: 20 })],
  });
  const transport = new StreamableHTTPClientTransport(new URL('http://catalog.test/mcp'), {
    fetch: (url, init) => handler(new Request(url, init)),
  });
  const client = new Client(
    { name: 'catalog-tools-client', version: '1.0.0' },
    { versionNegotiation: { mode } },
  );
  await client.connect(transport);
  clients.push(client);
  return { client, host };
}

describe.each(eras)('catalog operations as MCP tools ($era era)', ({ mode, version }) => {
  it('lists exactly the mcpExposable operations, with their input schemas', async () => {
    const { client } = await connect(mode);
    expect(client.getNegotiatedProtocolVersion()).toBe(version);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).toSorted()).toEqual([
      'probe.echo',
      'probe.events',
      'probe.missing',
    ]);
    const echoTool = tools.find((tool) => tool.name === 'probe.echo');
    expect(echoTool?.description).toBe('Answers with the message it was given.');
    expect(echoTool?.inputSchema).toMatchObject({
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
      additionalProperties: false,
    });
    expect(tools.find((tool) => tool.name === 'probe.missing')?.annotations).toMatchObject({
      destructiveHint: true,
    });
  });

  it('runs a tool through the catalog pipeline and answers with its validated output', async () => {
    const { client } = await connect(mode);
    const result = await client.callTool({ name: 'probe.echo', arguments: { message: 'hello' } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ message: 'hello' });
  });

  it('refuses a caller the access policy refuses, as a Forbidden tool error', async () => {
    const { client } = await connect(mode, strangerContext);
    const result = await client.callTool({ name: 'probe.echo', arguments: { message: 'hello' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'Forbidden' });
  });

  it('answers a fault the operation raises as a tool error result', async () => {
    const { client } = await connect(mode);
    const result = await client.callTool({ name: 'probe.missing', arguments: { id: 'x' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'NotFound', data: { kind: 'thing' } });
  });

  it('does not serve an operation that is not mcpExposable', async () => {
    const { client } = await connect(mode);
    const outcome = await client.callTool({ name: 'probe.hidden', arguments: {} }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    const refused = 'error' in outcome || ('result' in outcome && outcome.result.isError === true);
    expect(refused).toBe(true);
  });

  it('answers a subscription with what it has recorded and the cursor to resume from', async () => {
    const { client, host } = await connect(mode);
    host.feed.publish('first');
    host.feed.publish('second');
    const first = await client.callTool({ name: 'probe.events', arguments: {} });
    expect(first.isError).toBeFalsy();
    const page = first.structuredContent as { events: Array<{ kind: string }>; nextCursor: string };
    expect(page.events.map((event) => event.kind)).toEqual(['first', 'second']);
    expect(host.closed.count).toBe(1);

    host.feed.publish('third');
    const resumed = await client.callTool({
      name: 'probe.events',
      arguments: { fromCursor: page.nextCursor },
    });
    const next = resumed.structuredContent as { events: Array<{ kind: string }> };
    expect(next.events.map((event) => event.kind)).toEqual(['third']);
  });
});

describe('createOperationMcpMount options', () => {
  it('refuses a non-positive event bound and a negative idle wait', () => {
    expect(() => createOperationMcpMount({ maxEvents: 0 })).toThrow(RangeError);
    expect(() => createOperationMcpMount({ idleMs: -1 })).toThrow(RangeError);
  });
});
