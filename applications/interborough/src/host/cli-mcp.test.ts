/**
 * `interborough mcp` (COR-2539): the endpoint address and the configuration for Claude Code and for
 * any other MCP client, as text and as JSON, for whichever instance the command targets, with no
 * credential in either form even when the target is a saved connection that holds one.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mcpConnection } from '../lib/mcp-connection.ts';
import type { CliClientDependencies } from './cli-client.ts';
import { executeCliWithDispatchAssertions as executeCli } from './cli-dispatch.test-support.ts';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function preferencesWith(contents: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'interborough-cli-mcp-'));
  directories.push(directory);
  const path = join(directory, 'cli-preferences.json');
  await writeFile(path, JSON.stringify(contents));
  return path;
}

/** A fetch that would fail the test: the command must not need the host to be reachable. */
const unreachable: NonNullable<CliClientDependencies['fetch']> = async () => {
  throw new Error('interborough mcp sent a request to a loopback target.');
};

describe('interborough mcp', () => {
  // spawn-free: the injected fetch fails the test if called, and mcp starts no process of its own.
  test('prints the endpoint and both configurations as text for the default instance', async () => {
    const result = await executeCli(['mcp'], {
      fetch: unreachable,
      preferencesPath: join(tmpdir(), 'interborough-cli-mcp-no-such-file.json'),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('MCP endpoint: http://127.0.0.1:7234/bureau/mcp');
    expect(result.stdout).toContain(
      'claude mcp add --transport http interborough http://127.0.0.1:7234/bureau/mcp',
    );
    expect(result.stdout).toContain('"mcpServers"');
    expect(result.stdout).toContain('"url": "http://127.0.0.1:7234/bureau/mcp"');
  });

  // spawn-free: the injected fetch fails the test if called, and mcp starts no process of its own.
  test('prints the same details as data with --output json, for the instance --url names', async () => {
    const result = await executeCli(['mcp', '--url', 'http://127.0.0.1:4310', '--output', 'json'], {
      fetch: unreachable,
    });
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout) as { schemaVersion: number; data: unknown };
    expect(envelope.schemaVersion).toBe(2);
    expect(envelope.data).toEqual(
      JSON.parse(JSON.stringify(mcpConnection('http://127.0.0.1:4310'))),
    );
    expect(envelope.data).toMatchObject({
      endpoint: 'http://127.0.0.1:4310/bureau/mcp',
      claudeCode: { command: expect.stringContaining('claude mcp add --transport http') },
      generic: { configuration: { mcpServers: { interborough: { type: 'http' } } } },
    });
  });

  // spawn-free: the injected fetch stands in for the management endpoint, and mcp starts no process.
  test('prints no credential for a saved connection that holds one, in either form', async () => {
    const credential = 'secret-value-that-must-never-print';
    const preferencesPath = await preferencesWith({
      connections: [
        {
          name: 'remote',
          url: 'https://management.example.test',
          credentialReference: 'INTERBOROUGH_TEST_TOKEN',
        },
      ],
      activeConnection: 'remote',
    });
    const authority = {
      workspace: { actorId: 'alice', workspaceId: 'workspace-a', capabilities: ['read'] },
    };
    const sent: Array<{ url: string; headers: Headers }> = [];
    const dependencies: CliClientDependencies = {
      preferencesPath,
      environment: { INTERBOROUGH_TEST_TOKEN: credential },
      fetch: async (input, init) => {
        sent.push({
          url: input instanceof Request ? input.url : input.toString(),
          headers: new Headers(init?.headers),
        });
        return Response.json(authority);
      },
    };
    for (const output of ['text', 'json'] as const) {
      const result = await executeCli(['mcp', '--output', output], dependencies);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('https://management.example.test/bureau/mcp');
      expect(result.stdout).not.toContain(credential);
      expect(result.stdout).not.toMatch(/authorization|bearer|x-api-key/i);
      expect(result.stderr).not.toContain(credential);
    }
    // The credential went only to the management endpoint's authority check, never into the output.
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((entry) => entry.url.startsWith('https://management.example.test/'))).toBe(
      true,
    );
  });

  // spawn-free: --help returns the registry's text before any target, host or process is resolved.
  test('is a registered command with help that names the endpoint', async () => {
    const help = await executeCli(['mcp', '--help']);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('interborough mcp');
    expect(help.stdout).toContain('/bureau/mcp');
  });
});
