/**
 * The lines a started host prints under "Interborough is listening on" (COR-2539): the interface,
 * the API, the MCP endpoint and the CLI flag that targets this instance, each on a line of its own.
 * They are checked against a real host, so each address named is one the host answers.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildTestDocuments } from './build-info.test-support.ts';
import { connectionLines } from './connection-details.ts';
import { startHost, type Host } from './host.ts';

const homes: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function start(): Promise<Host> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-connection-lines-'));
  homes.push(home);
  // Beside the home, never in it: Bungalow refuses a home that holds files but no deployment identity.
  const buildDirectory = await mkdtemp(join(tmpdir(), 'interborough-connection-build-'));
  homes.push(buildDirectory);
  await buildTestDocuments(buildDirectory);
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    buildDirectory,
    port: 0,
  });
  hosts.push(host);
  return host;
}

describe('connectionLines', () => {
  test('names the interface, the API, the MCP endpoint and the CLI flag, one per line', () => {
    expect(connectionLines(new URL('http://127.0.0.1:7234/'))).toEqual([
      'Interface: http://127.0.0.1:7234',
      'API: http://127.0.0.1:7234/api',
      'MCP: http://127.0.0.1:7234/bureau/mcp',
      'CLI: --url http://127.0.0.1:7234',
    ]);
  });

  test('carries no credential', () => {
    const text = connectionLines(new URL('http://127.0.0.1:7234/')).join('\n');
    expect(text).not.toMatch(/authorization|bearer|api[-_ ]?key|token|secret|password/i);
  });

  test('names addresses the running host answers', async () => {
    const host = await start();
    const lines = connectionLines(host.url);
    const address = (label: string): string => {
      const line = lines.find((entry) => entry.startsWith(`${label}: `));
      if (line === undefined) throw new Error(`No ${label} line.`);
      return line.slice(label.length + 2);
    };

    const page = await fetch(address('Interface'));
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');

    const description = await fetch(`${address('API')}/openapi.json`);
    expect(description.status).toBe(200);

    // The MCP endpoint answers an initialize request, which is what a coding agent sends first.
    const initialized = await fetch(address('MCP'), {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'connection-details-test', version: '0' },
        },
      }),
    });
    expect(initialized.status).toBe(200);
    expect(await initialized.text()).toContain('"serverInfo"');

    expect(address('CLI')).toBe(`--url ${address('Interface')}`);
  });
});
