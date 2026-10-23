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
import { createOperationMcpMount, type OperationMcpMountOptions } from './operation-tools.ts';
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

/** A subscription whose stream ends after one element, as a removed resource's does. */
const finite = defineOperation<
  typeof eventsInput,
  typeof eventsEnvelope,
  typeof testEventSchema,
  TestHost
>({
  name: 'probe.finite',
  kind: 'subscription',
  mcpExposable: true,
  summary: 'A feed that ends',
  destructive: false,
  inputSchema: eventsInput,
  outputSchema: eventsEnvelope,
  eventSchema: testEventSchema,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: false },
  unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
  invoke: async () => ({
    envelope: { subscriptionId: 'sub_finite', cursor: '0' },
    iterable: (async function* () {
      yield { kind: 'removed', cursor: '1', emittedAtMs: 0, payload: {} };
    })(),
    close: async () => undefined,
  }),
});

const eras: Array<{ era: string; mode: NegotiationMode; version: string }> = [
  { era: 'modern', mode: { pin: MCP_PROTOCOL_VERSION }, version: MCP_PROTOCOL_VERSION },
  { era: 'legacy', mode: 'legacy', version: MCP_LEGACY_PROTOCOL_VERSION },
];

const clients: Client[] = [];
afterEach(async () => {
  while (clients.length > 0) await clients.pop()!.close();
});

async function connect(
  mode: NegotiationMode,
  caller: () => AuthContext = readerContext,
  mountOptions: OperationMcpMountOptions = {},
) {
  const host = createTestHost();
  const handler = createOperationHandler({
    operations: [echo, hidden, missing, events, finite],
    host,
    authenticate: async () => caller(),
    mounts: [createOperationMcpMount({ idleMs: 20, ...mountOptions })],
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
      'probe.finite',
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

describe('a subscription tool whose stream ends', () => {
  it('answers with what it delivered and reports that the stream ended', async () => {
    const { client } = await connect({ pin: MCP_PROTOCOL_VERSION });
    const result = await client.callTool({ name: 'probe.finite', arguments: {} });
    expect(result.structuredContent).toMatchObject({
      events: [{ kind: 'removed', cursor: '1' }],
      nextCursor: '1',
      ended: true,
    });
  });
});

describe('createOperationMcpMount options', () => {
  it('refuses a non-positive event bound and a negative idle wait', () => {
    expect(() => createOperationMcpMount({ maxEvents: 0 })).toThrow(RangeError);
    expect(() => createOperationMcpMount({ idleMs: -1 })).toThrow(RangeError);
  });
});

describe.each(eras)('injected resources and tool metadata ($era era)', ({ mode }) => {
  const page = {
    uri: 'ui://probe/page',
    name: 'probe-page',
    mimeType: 'text/html;profile=mcp-app',
    text: '<!doctype html><title>probe</title>',
    _meta: { ui: { csp: { connectDomains: [] } } },
  };

  it('lists and reads an injected resource, and attaches _meta to the named tool only', async () => {
    const { client } = await connect(mode, readerContext, {
      resources: [page],
      toolMeta: { 'probe.echo': { ui: { resourceUri: page.uri } }, 'probe.absent': { x: 1 } },
    });
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toEqual([page.uri]);
    const read = await client.readResource({ uri: page.uri });
    expect(read.contents).toMatchObject([
      { uri: page.uri, mimeType: page.mimeType, text: page.text, _meta: page._meta },
    ]);
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === 'probe.echo')?._meta).toEqual({
      ui: { resourceUri: page.uri },
    });
    expect(tools.find((tool) => tool.name === 'probe.missing')?._meta).toBeUndefined();
  });

  it('runs a function body per read with the request context', async () => {
    let reads = 0;
    const { client } = await connect(mode, readerContext, {
      resources: [{ ...page, text: () => `read ${(reads += 1)}` }],
    });
    await client.readResource({ uri: page.uri });
    const second = await client.readResource({ uri: page.uri });
    expect(second.contents).toMatchObject([{ text: 'read 2' }]);
  });

  it('neither lists nor reads a resource its authorize refuses', async () => {
    const { client } = await connect(mode, strangerContext, {
      resources: [{ ...page, authorize: () => false }],
    });
    expect((await client.listResources()).resources).toEqual([]);
    await expect(client.readResource({ uri: page.uri })).rejects.toThrow();
  });
});

describe('resources in createOperationMcpMount options', () => {
  it('advertises no resources without any, and refuses a duplicate or empty one', async () => {
    const { client } = await connect({ pin: MCP_PROTOCOL_VERSION });
    expect(client.getServerCapabilities()?.resources).toBeUndefined();
    const resource = { uri: 'ui://a', name: 'a', mimeType: 'text/plain', text: '' };
    expect(() => createOperationMcpMount({ resources: [resource, resource] })).toThrow(RangeError);
    expect(() => createOperationMcpMount({ resources: [{ ...resource, uri: '' }] })).toThrow(
      RangeError,
    );
  });
});
