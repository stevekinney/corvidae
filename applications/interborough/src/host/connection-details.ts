/**
 * The lines a started host prints after "Interborough is listening on <url>" (COR-2539): where its
 * interface, API and MCP endpoint are, and the flag that points the CLI at this instance. One per
 * line, each a label, a colon and a value, so a person finds the address by the label and a script
 * splits on the first colon and a space. `dev.ts` and `serve.ts` print the same lines.
 *
 * @module connection-details
 */

import { mcpEndpoint } from '../lib/mcp-connection.ts';

/** The path Interborough's own HTTP API is served under (`api-routes.ts`). */
export const API_PATH = '/api';

/** The CLI flag that targets one host (`cli-client.ts`). */
export const CLI_TARGET_FLAG = '--url';

/**
 * The connection lines for the host listening at `url`:
 *
 * ```text
 * Interface: http://127.0.0.1:7234
 * API: http://127.0.0.1:7234/api
 * MCP: http://127.0.0.1:7234/bureau/mcp
 * CLI: --url http://127.0.0.1:7234
 * ```
 *
 * None of them carries a credential: a host on loopback needs none.
 */
export function connectionLines(url: URL): string[] {
  const origin = url.origin;
  return [
    `Interface: ${origin}`,
    `API: ${new URL(API_PATH, origin).href}`,
    `MCP: ${mcpEndpoint(origin)}`,
    `CLI: ${CLI_TARGET_FLAG} ${origin}`,
  ];
}
