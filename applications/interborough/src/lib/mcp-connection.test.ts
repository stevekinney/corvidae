/**
 * The connection details a person is shown (COR-2539): the endpoint, the Claude Code command and the
 * `mcpServers` entry, each built from the one function that every surface shares.
 */
import { describe, expect, test } from 'bun:test';

import {
  claudeCodeAddArguments,
  claudeCodeAddCommand,
  genericMcpConfiguration,
  MCP_PATH,
  mcpConnection,
  mcpEndpoint,
} from './mcp-connection.ts';

describe('mcpEndpoint', () => {
  test('is Bureau’s endpoint on the origin, from a URL or a string, whatever path the origin carried', () => {
    expect(MCP_PATH).toBe('/bureau/mcp');
    expect(mcpEndpoint('http://127.0.0.1:7234')).toBe('http://127.0.0.1:7234/bureau/mcp');
    expect(mcpEndpoint(new URL('http://127.0.0.1:7234/'))).toBe('http://127.0.0.1:7234/bureau/mcp');
    expect(mcpEndpoint('https://agents.example.com/some/page?q=1')).toBe(
      'https://agents.example.com/bureau/mcp',
    );
  });
});

describe('the Claude Code registration', () => {
  test('is `mcp add --transport http <name> <endpoint>`, with a scope only when one is named', () => {
    const endpoint = 'http://127.0.0.1:7234/bureau/mcp';
    expect(claudeCodeAddArguments('interborough', endpoint)).toEqual([
      'mcp',
      'add',
      '--transport',
      'http',
      'interborough',
      endpoint,
    ]);
    expect(claudeCodeAddArguments('interborough', endpoint, 'local').slice(-2)).toEqual([
      '-s',
      'local',
    ]);
    expect(claudeCodeAddCommand('interborough', endpoint)).toBe(
      `claude mcp add --transport http interborough ${endpoint}`,
    );
  });

  test('quotes an argument a shell would split or expand', () => {
    expect(claudeCodeAddCommand('it’s', 'http://h/a b?x=$HOME')).toBe(
      "claude mcp add --transport http 'it’s' 'http://h/a b?x=$HOME'",
    );
    expect(claudeCodeAddCommand("a'b", 'http://h/x')).toContain("'a'\\''b'");
  });
});

describe('mcpConnection', () => {
  test('holds the endpoint, the command and the mcpServers entry, which name the same address', () => {
    const connection = mcpConnection('http://127.0.0.1:4310/');
    expect(connection.endpoint).toBe('http://127.0.0.1:4310/bureau/mcp');
    expect(connection.claudeCode.command).toBe(
      'claude mcp add --transport http interborough http://127.0.0.1:4310/bureau/mcp',
    );
    expect(connection.claudeCode.arguments.at(-1)).toBe(connection.endpoint);
    expect(connection.generic.configuration).toEqual(
      genericMcpConfiguration('interborough', connection.endpoint),
    );
    expect(JSON.parse(connection.generic.text)).toEqual({
      mcpServers: { interborough: { type: 'http', url: 'http://127.0.0.1:4310/bureau/mcp' } },
    });
  });

  test('carries no credential: no header, key or token appears in any of its forms', () => {
    const text = JSON.stringify(mcpConnection('http://127.0.0.1:7234'));
    expect(text).not.toMatch(/authorization|bearer|header|api[-_ ]?key|token|secret|password/i);
  });
});
