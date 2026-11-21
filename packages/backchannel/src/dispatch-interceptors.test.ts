import { expect, it } from 'bun:test';
import { z } from 'zod';

import { httpJsonRpcTransport, inProcessCatalogTransport } from './client/index.ts';
import {
  anonymousPrincipal,
  createOperationHandler,
  createOperationRegistry,
  defineOperation,
  principalFromApiKey,
  type OperationInterceptor,
} from './index.ts';
import { makeOperation } from './json-rpc-operation.test-support.ts';
import { isSubscriptionInvocation } from './operation-catalog/subscription-lifecycle.ts';
import { connectHttp } from './transport-conformance-http.test-support.ts';
import { createTransportConformanceFixture } from './transport-conformance.test-support.ts';

function shortCircuitTrace() {
  const trace: string[] = [];
  const interceptors: OperationInterceptor[] = [
    async (context, next) => {
      trace.push(`before:${context.name}:${context.transport}`);
      expect(context.metadata.summary).toBe('test op');
      expect(context.input).toEqual({ message: 'hello' });
      expect(context.principal).toEqual(anonymousPrincipal());
      expect(context.signal).toBeInstanceOf(AbortSignal);
      const result = await next();
      trace.push('after');
      return result;
    },
    async () => {
      trace.push('short circuit');
      return { ok: true, value: { message: 'intercepted' } };
    },
  ];
  return { trace, interceptors };
}

it('intercepts an authorized JSON-RPC HTTP call in registration order', async () => {
  const { trace, interceptors } = shortCircuitTrace();
  const { call } = connectHttp(createTransportConformanceFixture(), { interceptors });
  const result = await call('probe.echo', { message: 'hello' });
  expect(result).toEqual({ message: 'intercepted' });
  expect(trace).toEqual(['before:probe.echo:jsonRpcHttp', 'short circuit', 'after']);
});

it('short circuits calls in-process and leaves output validation in place', async () => {
  const { trace, interceptors } = shortCircuitTrace();
  const { operations, host } = createTransportConformanceFixture();
  const call = inProcessCatalogTransport({
    registry: createOperationRegistry(operations, { interceptors }),
    host,
    principal: anonymousPrincipal(),
  });
  const output = await call(
    'probe.echo',
    { message: 'hello' },
    { signal: new AbortController().signal },
  );
  expect(output).toEqual({ message: 'intercepted' });
  expect(trace).toEqual(['before:probe.echo:jsonRpcHttp', 'short circuit', 'after']);

  const invalid = inProcessCatalogTransport({
    registry: createOperationRegistry(operations, {
      interceptors: [async () => ({ ok: true, value: 'invalid output' })],
    }),
    host,
    principal: anonymousPrincipal(),
  });
  const error = await invalid('probe.echo', { message: 'hello' }).catch(
    (reason: unknown) => reason,
  );
  expect(error).toMatchObject({ data: { weftCode: 'EngineFailure' } });
});

it('does not invoke interceptors until access checks, validation and authorization pass', async () => {
  let intercepted = 0;
  const operation = makeOperation({
    name: 'probe.restricted',
    inputSchema: z.object({ allowed: z.boolean() }),
    outputSchema: z.boolean(),
    access: { kind: 'authenticated' },
    authorize: async ({ input }) =>
      input.allowed ? { allowed: true } : { allowed: false, reason: 'refused' },
    invoke: async () => true,
  });
  const registry = createOperationRegistry([operation], {
    interceptors: [
      async (_, next) => {
        intercepted += 1;
        return next();
      },
    ],
  });
  const publicCall = inProcessCatalogTransport({
    registry,
    host: {},
    principal: anonymousPrincipal(),
  });
  const authenticatedCall = inProcessCatalogTransport({
    registry,
    host: {},
    principal: principalFromApiKey({ subject: 'client', scopes: [] }),
  });
  const access = await publicCall('probe.restricted', { allowed: true }).catch(
    (reason: unknown) => reason,
  );
  const validation = await authenticatedCall('probe.restricted', {}).catch(
    (reason: unknown) => reason,
  );
  const authorization = await authenticatedCall('probe.restricted', { allowed: false }).catch(
    (reason: unknown) => reason,
  );
  expect(access).toMatchObject({ data: { weftCode: 'Unauthorized' } });
  expect(validation).toMatchObject({ data: { weftCode: 'InvalidParams' } });
  expect(authorization).toMatchObject({ data: { weftCode: 'Forbidden' } });
  expect(intercepted).toBe(0);
  expect(await authenticatedCall('probe.restricted', { allowed: true })).toBe(true);
  expect(intercepted).toBe(1);
});

it('wraps subscription startup once even as the feed delivers multiple events', async () => {
  const fixture = createTransportConformanceFixture();
  let starts = 0;
  const { subscribe } = connectHttp(fixture, {
    interceptors: [
      async (_, next) => {
        starts += 1;
        return next();
      },
    ],
  });
  fixture.host.feed.publish('one');
  fixture.host.feed.publish('two');
  const stream = subscribe('probe.events', {});
  const iterator = stream[Symbol.asyncIterator]();
  try {
    expect(await iterator.next()).toMatchObject({ value: { id: '1' } });
    expect(await iterator.next()).toMatchObject({ value: { id: '2' } });
    expect(starts).toBe(1);
  } finally {
    await iterator.return?.();
  }
});

it('resolves an authenticated caller’s host once for both authorization and invocation', async () => {
  const calls: string[] = [];
  type Host = { readonly workspace: string };
  const inputSchema = z.object({});
  const outputSchema = z.string();
  const operation = defineOperation<typeof inputSchema, typeof outputSchema, Host>({
    name: 'probe.workspace',
    inputSchema,
    outputSchema,
    mcpExposable: false,
    summary: 'Return the current workspace',
    destructive: false,
    access: { kind: 'authenticated' },
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
    authorize: async ({ host, principal }) => {
      expect(host.workspace).toBe(
        principal.method !== 'unauthenticated' ? (principal.subject ?? '') : '',
      );
      return { allowed: true };
    },
    invoke: async ({ host }) => host.workspace,
  });
  const handler = createOperationHandler<Host>({
    operations: [operation],
    authenticate: async (request) => ({
      method: 'api-key',
      principal: principalFromApiKey({
        subject: request.headers.get('x-test-subject') ?? '',
        scopes: [],
      }),
    }),
    host: async ({ principal, transport }): Promise<Host> => {
      expect(transport).toBe('jsonRpcHttp');
      if (principal.method === 'unauthenticated')
        throw new Error('expected an authenticated principal');
      const workspace = principal.subject ?? '';
      calls.push(workspace);
      return { workspace };
    },
  });
  const connect = (subject: string) =>
    httpJsonRpcTransport({
      baseUrl: 'https://probe.test',
      headers: { 'x-test-subject': subject },
      fetch: (input, init) => handler(new Request(input, init)),
    });
  const results = await Promise.all([
    connect('alice')('probe.workspace', {}),
    connect('bob')('probe.workspace', {}),
  ]);
  expect(results).toEqual(['alice', 'bob']);
  expect(calls.toSorted()).toEqual(['alice', 'bob']);
});

it('closes a subscription an interceptor abandons after invocation', async () => {
  const fixture = createTransportConformanceFixture();
  const { subscribe } = connectHttp(fixture, {
    interceptors: [
      async (_, next) => {
        const started = await next();
        expect(started.ok).toBe(true);
        return { ok: false, fault: { code: 'Unavailable', message: 'busy', data: {} } };
      },
    ],
  });
  const stream = subscribe('probe.events', {});
  const outcome = await stream[Symbol.asyncIterator]()
    .next()
    .catch((reason: unknown) => reason);
  expect(outcome).toMatchObject({ code: 503 });
  expect(fixture.host.closed.count).toBe(1);
});

it('preserves a subscription whose interceptor wraps its close hook', async () => {
  const fixture = createTransportConformanceFixture();
  let closeCalls = 0;
  const { subscribe } = connectHttp(fixture, {
    interceptors: [
      async (_, next) => {
        const started = await next();
        if (!started.ok || !isSubscriptionInvocation(started.value)) return started;
        const invocation = started.value;
        return {
          ok: true,
          value: {
            ...invocation,
            close: async () => {
              closeCalls += 1;
              await invocation.close();
            },
          },
        };
      },
    ],
  });

  fixture.host.feed.publish('available');
  const stream = subscribe('probe.events', {});
  const reader = stream[Symbol.asyncIterator]();
  try {
    expect(await reader.next()).toMatchObject({ done: false, value: { id: '1' } });
    expect(fixture.host.closed.count).toBe(0);
  } finally {
    await reader.return?.();
  }
  expect(closeCalls).toBe(1);
  expect(fixture.host.closed.count).toBe(1);
});
