import { describe, expect, it } from 'bun:test';

import { defineOperation } from '../operation-registry.ts';
import {
  createTestHost,
  eventsOperation,
  scopedEchoOperation,
} from './operation-handler.test-support.ts';
import { createOperationHandler } from './operation-handler.ts';

async function documents(handler: ReturnType<typeof createOperationHandler>) {
  const read = async (path: string) => {
    const response = await handler(new Request(`http://localhost${path}`));
    return (await response.json()) as Record<string, unknown>;
  };
  return {
    openApi: await read('/openapi.json'),
    openRpc: await read('/openrpc.json'),
    asyncApi: await read('/asyncapi.json'),
  };
}

function build() {
  const host = createTestHost();
  const socketOnly = defineOperation<
    typeof eventsOperation.inputSchema,
    typeof eventsOperation.outputSchema,
    typeof eventsOperation.eventSchema,
    typeof host
  >({
    ...eventsOperation,
    name: 'probe.socket',
    transports: { http: false, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: false },
  });
  return createOperationHandler({
    operations: [eventsOperation, scopedEchoOperation, socketOnly],
    host,
  });
}

describe('the discovery documents createOperationHandler serves', () => {
  it('lists each http subscription as a Server-Sent Events channel at the route', async () => {
    const { asyncApi } = await documents(build());

    const channels = asyncApi['channels'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(channels)).toEqual(['probe/events']);
    expect(channels['probe/events']).toMatchObject({
      address: '/v1/subscriptions/probe.events',
      'x-weft-transport': 'server-sent-events',
    });
    expect(JSON.stringify(asyncApi)).not.toContain('json-rpc-websocket');
    expect(JSON.stringify(asyncApi)).not.toContain('probe.socket');
  });

  it('declares HTTP and WebSocket in OpenRPC, with no MCP metadata', async () => {
    const { openRpc } = await documents(build());

    const methods = (openRpc['methods'] as { name: string }[]).map((method) => method.name);
    expect(methods.toSorted()).toEqual([
      'probe.events',
      'probe.scoped',
      'probe.socket',
      'rpc.discover',
    ]);
    expect(openRpc['x-weft-mcp']).toBeUndefined();
  });

  it('lists only the direct routes it serves in OpenAPI, and none of Weft’s bindings', async () => {
    const { openApi } = await documents(build());

    expect(Object.keys(openApi['paths'] as object).toSorted()).toEqual([
      '/asyncapi.json',
      '/openapi.json',
      '/openrpc.json',
      '/v1/health',
    ]);
  });

  it('advertises no credential scheme when no authenticate is configured', async () => {
    const { openApi } = await documents(build());

    expect(openApi['security']).toEqual([]);
  });
});
