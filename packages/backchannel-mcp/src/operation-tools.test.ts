/**
 * COR-839 — a catalog's `mcpExposable` operations served as MCP tools through
 * `createOperationMcpMount`, driven by the official SDK client in both eras.
 */
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import {
  Client,
  StreamableHTTPClientTransport,
  type ClientOptions,
} from '@modelcontextprotocol/client';
import { fromMcpClientTools } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createOperationHandler, defineOperation } from '@lostgradient/backchannel';
import type { AuthContext } from '@lostgradient/backchannel/internals';
import {
  createTestHost,
  readerContext,
  strangerContext,
  testEventSchema,
  type TestHost,
} from '@lostgradient/backchannel/testing';
import { createOperationMcpMount, type OperationMcpMountOptions } from './index.ts';
type NegotiationMode = NonNullable<NonNullable<ClientOptions['versionNegotiation']>['mode']>;
const MCP_PROTOCOL_VERSION = '2026-07-28';
const MCP_LEGACY_PROTOCOL_VERSION = '2025-11-25';
const serverInfo = { name: 'probe', version: '1.0.0' };

const transports = { http: true, jsonRpcHttp: true, jsonRpcWebSocket: false, jsonRpcStdio: false };
let echoCalls = 0;

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
  behavior: { kind: 'read' },
  inputSchema: z.object({ message: z.string() }),
  outputSchema: z.object({ message: z.string() }),
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['events:read'] } },
  transports,
  unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
  invoke: async ({ input }) => {
    echoCalls += 1;
    return { message: input.message };
  },
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

const disclosure = defineOperation<z.ZodObject<{}>, z.ZodObject<{ public: z.ZodString }>, TestHost>(
  {
    name: 'probe.disclosure',
    mcpExposable: true,
    summary: 'Public projection',
    destructive: false,
    inputSchema: z.object({}),
    outputSchema: z.object({ public: z.string() }),
    access: { kind: 'public' },
    transports,
    unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
    invoke: async () => ({ public: 'visible', secret: 'private-value' }),
  },
);

const oversized = defineOperation<z.ZodObject<{}>, z.ZodObject<{ value: z.ZodString }>, TestHost>({
  name: 'probe.oversized',
  mcpExposable: true,
  summary: 'Large output',
  destructive: false,
  inputSchema: z.object({}),
  outputSchema: z.object({ value: z.string() }),
  access: { kind: 'public' },
  transports,
  unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
  invoke: async () => ({ value: 'é'.repeat(131072) }),
});

const unsupported = defineOperation<z.ZodObject<{}>, z.ZodObject<{ value: z.ZodAny }>, TestHost>({
  name: 'probe.unsupported',
  mcpExposable: true,
  summary: 'Unserializable output',
  destructive: false,
  inputSchema: z.object({}),
  outputSchema: z.object({ value: z.any() }),
  access: { kind: 'public' },
  transports,
  unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
  invoke: async () => ({ value: 1n }),
});

let writes = 0;
const unionOutput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('first'), value: z.string() }),
  z.object({ kind: z.literal('second'), count: z.number() }),
]);
const union = defineOperation<
  z.ZodObject<{ kind: z.ZodEnum<{ first: 'first'; second: 'second' }> }>,
  typeof unionOutput,
  TestHost
>({
  name: 'probe.union',
  mcpExposable: true,
  summary: 'Object union',
  destructive: false,
  inputSchema: z.object({ kind: z.enum(['first', 'second']) }),
  outputSchema: unionOutput,
  access: { kind: 'public' },
  transports,
  unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
  invoke: async ({ input }) =>
    input.kind === 'first' ? { kind: 'first', value: 'a' } : { kind: 'second', count: 2 },
});
const scalar = defineOperation<z.ZodObject<{}>, z.ZodString, TestHost>({
  name: 'probe.scalar',
  mcpExposable: true,
  summary: 'Scalar result',
  destructive: false,
  inputSchema: z.object({}),
  outputSchema: z.string(),
  access: { kind: 'public' },
  transports,
  unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
  invoke: async () => 'scalar',
});
let cancellationStarted = () => {};
let cancellationObserved = () => {};
const cancellation = defineOperation<z.ZodObject<{}>, z.ZodObject<{}>, TestHost>({
  name: 'probe.cancellation',
  mcpExposable: true,
  summary: 'Wait for cancellation',
  destructive: false,
  inputSchema: z.object({}),
  outputSchema: z.object({}),
  access: { kind: 'public' },
  transports,
  unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
  invoke: async ({ signal }) => {
    cancellationStarted();
    await new Promise<void>((resolve) =>
      signal?.addEventListener(
        'abort',
        () => {
          cancellationObserved();
          resolve();
        },
        { once: true },
      ),
    );
    return {};
  },
});
const write = defineOperation<
  z.ZodObject<{ message: z.ZodString }>,
  z.ZodObject<{ message: z.ZodString }>,
  TestHost
>({
  name: 'probe.write',
  mcpExposable: true,
  summary: 'Write a message',
  destructive: true,
  behavior: { kind: 'command' },
  inputSchema: z.object({ message: z.string() }),
  outputSchema: z.object({ message: z.string() }),
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['events:read', 'events:write'] } },
  transports,
  unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
  invoke: async ({ input }) => {
    writes += 1;
    return input;
  },
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

/** An operation that raises the fault code its input names, each carrying a remediation. */
const advised = defineOperation<
  z.ZodObject<{
    code: z.ZodEnum<{
      NotFound: 'NotFound';
      RateLimited: 'RateLimited';
      EngineFailure: 'EngineFailure';
    }>;
  }>,
  z.ZodObject<{}>,
  TestHost
>({
  name: 'probe.advised',
  mcpExposable: true,
  summary: 'Raises a fault with advice',
  destructive: false,
  inputSchema: z.object({ code: z.enum(['NotFound', 'RateLimited', 'EngineFailure']) }),
  outputSchema: z.object({}),
  access: { kind: 'authenticated' },
  producibleFaults: ['NotFound', 'RateLimited', 'EngineFailure'],
  transports,
  unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
  invoke: async ({ input }) => {
    const remediation = 'Create the thing first, then call again.';
    if (input.code === 'NotFound') {
      throw { code: 'NotFound', message: 'no thing', data: { resource: 'thing' }, remediation };
    }
    if (input.code === 'RateLimited') {
      throw {
        code: 'RateLimited',
        message: 'slow down',
        data: { retryAfterSeconds: 3 },
        remediation,
      };
    }
    throw { code: 'EngineFailure', message: 'internal error', data: {}, remediation };
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
      subscriptionId: 'sub_1',
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
    subscriptionId: 'sub_finite',
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
  mountOptions: Omit<OperationMcpMountOptions, 'serverInfo'> = {},
) {
  const host = createTestHost();
  const handler = createOperationHandler({
    operations: [
      echo,
      hidden,
      missing,
      advised,
      events,
      finite,
      disclosure,
      oversized,
      unsupported,
      write,
      cancellation,
      union,
      scalar,
    ],
    host,
    authenticate: async () => caller(),
    mounts: [createOperationMcpMount({ serverInfo, idleMs: 20, ...mountOptions })],
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
    const { client } = await connect(mode, readerContext, { oauth: true });
    expect(client.getNegotiatedProtocolVersion()).toBe(version);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).toSorted()).toEqual([
      'probe.advised',
      'probe.cancellation',
      'probe.disclosure',
      'probe.echo',
      'probe.events',
      'probe.finite',
      'probe.missing',
      'probe.oversized',
      'probe.union',
      'probe.unsupported',
      'probe.write',
    ]);
    const echoTool = tools.find((tool) => tool.name === 'probe.echo');
    expect(echoTool?.description).toBe('Answers with the message it was given.');
    expect(echoTool?.inputSchema).toMatchObject({
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
      additionalProperties: false,
    });
    expect(echoTool?.outputSchema).toMatchObject({
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    });
    expect(echoTool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(echoTool?._meta?.['securitySchemes']).toEqual([
      { type: 'oauth2', scopes: ['events:read'] },
    ]);
    const writeTool = tools.find((tool) => tool.name === 'probe.write');
    expect(writeTool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(writeTool?.inputSchema).toMatchObject({ properties: { message: { type: 'string' } } });
    expect(writeTool?.outputSchema).toMatchObject({ properties: { message: { type: 'string' } } });
    expect(writeTool?._meta?.['securitySchemes']).toEqual([
      { type: 'oauth2', scopes: ['events:read'] },
      { type: 'oauth2', scopes: ['events:write'] },
    ]);
    const before = writes;
    const written = await client.callTool({ name: 'probe.write', arguments: { message: 'saved' } });
    expect(written.structuredContent).toEqual({ message: 'saved' });
    expect(writes).toBe(before + 1);
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

  it('lists and invokes each object union arm and omits a scalar output', async () => {
    const { client } = await connect(mode);
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === 'probe.scalar')).toBeUndefined();
    expect(tools.find((tool) => tool.name === 'probe.union')?.outputSchema).toMatchObject({
      type: 'object',
      oneOf: [{ type: 'object' }, { type: 'object' }],
    });
    const first = await client.callTool({ name: 'probe.union', arguments: { kind: 'first' } });
    const second = await client.callTool({ name: 'probe.union', arguments: { kind: 'second' } });
    expect(first.structuredContent).toEqual({ kind: 'first', value: 'a' });
    expect(second.structuredContent).toEqual({ kind: 'second', count: 2 });
  });

  it('refuses a caller the access policy refuses, as a Forbidden tool error', async () => {
    const { client } = await connect(mode, strangerContext);
    const before = echoCalls;
    const result = await client.callTool({ name: 'probe.echo', arguments: { message: 'hello' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'Forbidden' });
    expect(echoCalls).toBe(before);
  });

  it('returns a recoverable scope challenge without invoking the tool', async () => {
    const challenge = 'Bearer error="insufficient_scope", scope="events:read"';
    const { client } = await connect(mode, strangerContext, {
      scopeChallenge: async (operation) =>
        operation.name === 'probe.echo' ? { challenge } : undefined,
    });
    const before = echoCalls;
    const result = await client.callTool({ name: 'probe.echo', arguments: { message: 'hello' } });
    expect(result.isError).toBe(true);
    expect(result._meta?.['mcp/www_authenticate']).toEqual([challenge]);
    expect(echoCalls).toBe(before);
  });

  it('filters tool discovery and refuses direct calls to filtered operations', async () => {
    const options = {
      operationFilter: (operation) => operation.name === 'probe.echo',
    } satisfies Partial<OperationMcpMountOptions>;
    const { client } = await connect(mode, readerContext, options);
    options.operationFilter = () => true;
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['probe.echo']);
    expect(
      await throwingRejectionOf(client.callTool({ name: 'probe.write', arguments: {} })),
    ).toThrow('not found');
  });

  it('imports and invokes the catalog read through Armorer', async () => {
    const { client } = await connect(mode);
    const tools = await fromMcpClientTools(client);
    expect(tools.find((tool) => tool.name === 'probe.hidden')).toBeUndefined();
    expect(
      await tools.find((tool) => tool.name === 'probe.echo')?.execute({ message: 'imported' }),
    ).toEqual({ message: 'imported' });
  });

  it('does not infer OAuth without an explicit host declaration', async () => {
    const { client } = await connect(mode);
    const { tools } = await client.listTools();
    expect(
      tools.find((tool) => tool.name === 'probe.echo')?._meta?.['securitySchemes'],
    ).toBeUndefined();
  });

  it('discloses only fields admitted by the output schema', async () => {
    const { client } = await connect(mode);
    const result = await client.callTool({ name: 'probe.disclosure', arguments: {} });
    expect(result.structuredContent).toEqual({ public: 'visible' });
    expect(JSON.stringify(result)).not.toContain('private-value');
  });

  it('returns a typed error for a result over the UTF-8 byte bound', async () => {
    const { client } = await connect(mode);
    const result = await client.callTool({ name: 'probe.oversized', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: 'Unprocessable',
      data: { reason: 'result too large' },
    });
    expect(JSON.stringify(result)).not.toContain('é');
  });

  it('returns a typed error for an unsupported result', async () => {
    const { client } = await connect(mode);
    const result = await client.callTool({ name: 'probe.unsupported', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: 'Unprocessable',
      data: { reason: 'not JSON serializable' },
    });
  });

  it('answers a fault the operation raises as a tool error result', async () => {
    const { client } = await connect(mode);
    const result = await client.callTool({ name: 'probe.missing', arguments: { id: 'x' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'NotFound', data: { kind: 'thing' } });
  });

  it('carries retryable on every fault, and remediation when the fault sets one', async () => {
    const { client } = await connect(mode);
    const missingResult = await client.callTool({ name: 'probe.missing', arguments: { id: 'x' } });
    expect(missingResult.structuredContent).toEqual({
      code: 'NotFound',
      message: 'no such thing: x',
      data: { kind: 'thing' },
      retryable: false,
    });

    const advice = 'Create the thing first, then call again.';
    const notFound = await client.callTool({
      name: 'probe.advised',
      arguments: { code: 'NotFound' },
    });
    expect(notFound.structuredContent).toEqual({
      code: 'NotFound',
      message: 'no thing',
      data: { resource: 'thing' },
      retryable: false,
      remediation: advice,
    });
    const limited = await client.callTool({
      name: 'probe.advised',
      arguments: { code: 'RateLimited' },
    });
    expect(limited.structuredContent).toMatchObject({ code: 'RateLimited', retryable: true });
  });

  it('never sends a remediation with an EngineFailure, and marks it not retryable', async () => {
    const { client } = await connect(mode);
    const result = await client.callTool({
      name: 'probe.advised',
      arguments: { code: 'EngineFailure' },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      code: 'EngineFailure',
      message: 'internal error',
      data: {},
      retryable: false,
    });
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

it('propagates modern MCP cancellation to the catalog operation', async () => {
  const { client } = await connect({ pin: MCP_PROTOCOL_VERSION });
  const started = new Promise<void>((resolve) => {
    cancellationStarted = resolve;
  });
  const observed = new Promise<void>((resolve) => {
    cancellationObserved = resolve;
  });
  const controller = new AbortController();
  const call = client
    .callTool({ name: 'probe.cancellation', arguments: {} }, { signal: controller.signal })
    .catch(() => undefined);
  await started;
  controller.abort();
  await call;
  await observed;
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
    expect(() => createOperationMcpMount({ serverInfo, maxEvents: 0 })).toThrow(RangeError);
    expect(() => createOperationMcpMount({ serverInfo, idleMs: -1 })).toThrow(RangeError);
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
    expect(tools.find((tool) => tool.name === 'probe.echo')?._meta).toMatchObject({
      ui: { resourceUri: page.uri },
    });
    expect(tools.find((tool) => tool.name === 'probe.missing')?._meta).toBeUndefined();
  });

  it('attaches the default _meta to every tool without an entry, and an entry replaces it', async () => {
    const { client } = await connect(mode, readerContext, {
      toolMeta: { 'probe.echo': { ui: { resourceUri: page.uri } } },
      defaultToolMeta: { ui: { visibility: ['model'] } },
    });
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(1);
    for (const tool of tools) {
      expect(tool._meta).toMatchObject(
        tool.name === 'probe.echo'
          ? { ui: { resourceUri: page.uri } }
          : { ui: { visibility: ['model'] } },
      );
    }
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
    const listed = await client.listResources();
    expect(listed.resources).toEqual([]);
    const outcome = await client.readResource({ uri: page.uri }).then(
      () => 'read',
      () => 'refused',
    );
    expect(outcome).toBe('refused');
  });
});

describe('resources in createOperationMcpMount options', () => {
  it('advertises no resources without any, and refuses a duplicate or empty one', async () => {
    const { client } = await connect({ pin: MCP_PROTOCOL_VERSION });
    expect(client.getServerCapabilities()?.resources).toBeUndefined();
    const resource = { uri: 'ui://a', name: 'a', mimeType: 'text/plain', text: '' };
    expect(() => createOperationMcpMount({ serverInfo, resources: [resource, resource] })).toThrow(
      RangeError,
    );
    expect(() =>
      createOperationMcpMount({ serverInfo, resources: [{ ...resource, uri: '' }] }),
    ).toThrow(RangeError);
  });
});
