import { z } from 'zod';

import { createOperationHandler, defineOperation } from './index.ts';

/** Builds the shared, transport-neutral Backchannel smoke handler. */
export function createRuntimeSmokeHandler() {
  const echo = defineOperation({
    name: 'portable.echo',
    summary: 'Echoes a portable smoke message.',
    destructive: false,
    mcpExposable: false,
    inputSchema: z.object({ message: z.string() }),
    outputSchema: z.object({ message: z.string() }),
    access: { kind: 'public' },
    transports: { http: false, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: false },
    unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
    invoke: async ({ input }) => ({ message: input.message }),
  });
  return createOperationHandler({ operations: [echo], host: {} });
}

/** Exercises REST JSON-RPC and a caller-provided WebSocket transport over the same handler. */
export async function runRuntimeSmoke(
  baseUrl: URL,
  exchangeWebSocket: (url: URL, request: string) => Promise<string>,
): Promise<void> {
  const request = JSON.stringify({
    jsonrpc: '2.0',
    method: 'portable.echo',
    params: { message: 'portable' },
    id: 1,
  });
  const response = await fetch(new URL('/jsonrpc', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: request,
  });
  const body = (await response.json()) as { result?: { message?: string } };
  if (response.status !== 200 || body.result?.message !== 'portable') {
    throw new Error('Backchannel REST smoke exchange failed.');
  }
  const reply = JSON.parse(await exchangeWebSocket(new URL('/jsonrpc', baseUrl), request)) as {
    result?: { message?: string };
  };
  if (reply.result?.message !== 'portable')
    throw new Error('Backchannel WebSocket smoke exchange failed.');
}
