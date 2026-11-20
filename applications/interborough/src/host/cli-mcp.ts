/**
 * `interborough mcp` (COR-2539): the address of the instance's MCP endpoint and the configuration
 * that points a coding agent at it, the same ones Settings › MCP shows. It reads no host state and
 * sends no request: the address is the resolved target's own origin plus `/bureau/mcp`, so it works
 * for `--url`, a saved connection, or the instance a linked worktree runs, and it needs the host to
 * be running only when the person pastes what it prints. The target's credential, which a saved
 * remote connection carries, is never read into the output.
 *
 * @module cli-mcp
 */

import { mcpConnection, type McpConnection } from '../lib/mcp-connection.ts';
import type { CliTarget } from './cli-client-transport.ts';
import type { CliCommandResult, Parsed } from './cli-client.ts';

/** The text `interborough mcp` prints: the endpoint, then each configuration under its own heading. */
export function mcpConnectionText(connection: McpConnection): string {
  return [
    `MCP endpoint: ${connection.endpoint}`,
    '',
    'Claude Code:',
    `  ${connection.claudeCode.command}`,
    '',
    'Any other MCP client (an mcpServers entry):',
    ...connection.generic.text.split('\n').map((line) => `  ${line}`),
  ].join('\n');
}

/** Run `interborough mcp` against the resolved target: text for a person, the connection object for `--output json`. */
export function executeMcp(target: CliTarget, parsed: Parsed): CliCommandResult {
  const connection = mcpConnection(target.url);
  return { data: parsed.output === 'text' ? mcpConnectionText(connection) : connection };
}
