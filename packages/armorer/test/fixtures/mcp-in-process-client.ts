import {
  Client,
  StreamableHTTPClientTransport,
  type ClientOptions,
} from '@modelcontextprotocol/client';

import type { MCPServer } from '../../src/integrations/mcp';

/** One HTTP exchange between the SDK client and an Armorer endpoint, as seen on the wire. */
export type RecordedExchange = {
  method: string | undefined;
  headers: Record<string, string>;
  responseText: Promise<string>;
};

export type NegotiationMode = NonNullable<NonNullable<ClientOptions['versionNegotiation']>['mode']>;

/**
 * Connects the official SDK client to an Armorer endpoint in process: the
 * client's Streamable HTTP transport is pointed at `mcp.fetch`, so no socket
 * is opened and both protocol eras run through the SDK's real HTTP entry.
 */
export async function connectInProcessClient(
  mcp: MCPServer,
  mode: NegotiationMode,
  options: Omit<ClientOptions, 'versionNegotiation'> = {},
): Promise<{ client: Client; exchanges: RecordedExchange[] }> {
  const exchanges: RecordedExchange[] = [];
  const transport = new StreamableHTTPClientTransport(new URL('http://armorer.test/mcp'), {
    fetch: async (url, init) => {
      const request = new Request(url, init);
      const body = request.method === 'POST' ? await request.clone().text() : '';
      const response = await mcp.fetch(request);
      exchanges.push({
        method: readJsonRpcMethod(body),
        headers: Object.fromEntries(request.headers.entries()),
        responseText: response.clone().text(),
      });
      return response;
    },
  });
  const client = new Client(
    { name: 'armorer-conformance-client', version: '1.0.0' },
    { ...options, versionNegotiation: { mode } },
  );
  await client.connect(transport);
  return { client, exchanges };
}

function readJsonRpcMethod(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { method?: unknown };
    return typeof parsed.method === 'string' ? parsed.method : undefined;
  } catch {
    return undefined;
  }
}
