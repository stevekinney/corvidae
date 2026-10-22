/**
 * Drives one real MCP `initialize` handshake against `POST {origin}/mcp`
 * (plan §9.7 T7.3: "interactive 'Test MCP session' panel showing full
 * headers/body"). Weft serves `/mcp` through the official MCP SDK: protocol
 * 2026-07-28 on its modern lane, and 2025-era clients such as this one on the
 * SDK's stateless legacy lane, which answers `initialize` in the revision the
 * client asked for when the SDK supports it (`2025-03-26` here) and keeps no
 * session, so the response carries no `Mcp-Session-Id`.
 * `mcp-test-session.integration.test.ts` holds that contract against a real
 * `serve()`.
 *
 * A scoped `fetch()`, not `HttpClient`, for the same reason as
 * `discovery-client.ts`: `/mcp` is outside `HttpClient`'s modeled surface.
 */
import type { HttpClient } from '@lostgradient/weft';

import { discoveryOrigin } from './discovery-client.ts';

export interface McpTestSessionRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface McpTestSessionResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface McpTestSessionResult {
  readonly request: McpTestSessionRequest;
  readonly response: McpTestSessionResponse;
}

const MCP_PROTOCOL_VERSION_FOR_TEST = '2025-03-26';

function buildInitializeBody(): unknown {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION_FOR_TEST,
      capabilities: {},
      clientInfo: { name: 'weft-ui', version: '0.1.0' },
    },
  };
}

function headersToRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

/**
 * Sends one `initialize` request and returns the full request/response
 * shape for display — never throws on a non-2xx status (that's a valid,
 * displayable outcome for this panel, e.g. a 403 from a stale/mismatched
 * token would be the exact scenario the panel documents). Only a genuine
 * transport failure (network error, DNS failure) rejects.
 */
export async function testMcpSession(
  client: Pick<HttpClient, 'baseUrl' | 'headers'>,
): Promise<McpTestSessionResult> {
  const url = `${discoveryOrigin(client)}/mcp`;
  const requestHeaders: Record<string, string> = {
    ...client.headers,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  const body = buildInitializeBody();

  const response = await fetch(url, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(body),
  });

  const contentType = response.headers.get('content-type') ?? '';
  const responseBody = contentType.includes('json')
    ? await response.json().catch(() => null)
    : await response.text();

  return {
    request: { url, headers: requestHeaders, body },
    response: {
      status: response.status,
      statusText: response.statusText,
      headers: headersToRecord(response.headers),
      body: responseBody,
    },
  };
}
