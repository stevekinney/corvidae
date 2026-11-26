/**
 * COR-2436, row 33f: a probe of an MCP server repeats what the server said of itself, so Connect
 * tools fills in Name after the test. The server's own words are untrusted: its name is one line
 * within the length a saved name may have, and its instructions are cut.
 */
import { createMCP, createTool, createToolbox } from 'armorer/testing';
import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { createToolSourceManager, type ToolSourceManager } from './tool-source-manager.ts';
import { keysOf, memoryHome } from './tool-source-memory-home.test-support.ts';
import { MAXIMUM_TOOL_SOURCE_NAME_LENGTH } from './tool-sources-configuration.ts';

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function probeWith(
  serverInfo: { name: string; title?: string; version: string },
  instructions?: string,
) {
  const mcp = await createMCP(
    createToolbox([
      createTool({
        name: 'list_issues',
        description: 'Lists issues.',
        input: z.object({}),
        metadata: { readOnly: true },
        async execute() {
          return [];
        },
      }),
    ]),
    { serverInfo, ...(instructions === undefined ? {} : { instructions }) },
  );
  closers.push(() => mcp.close());
  const manager: ToolSourceManager = createToolSourceManager({
    bungalow: memoryHome().bungalow,
    keys: await keysOf(),
    audit: async () => {},
    origin: () => 'http://127.0.0.1:1',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
      mcp.fetch(new Request(input, init))) as typeof fetch,
  });
  closers.push(() => manager.close());
  return manager.probe({
    id: 'github',
    source: {
      id: 'github',
      kind: 'mcp',
      transport: { type: 'http', url: 'http://mcp.example.test/mcp' },
    },
    principal: 'anonymous:local',
  });
}

describe('what a probe repeats of the server', () => {
  test('its name for a person, and its instructions', async () => {
    const probe = await probeWith(
      { name: 'github-mcp', title: 'GitHub', version: '1.0.0' },
      'An MCP server for issues and files in your repositories.',
    );
    expect(probe).toMatchObject({
      outcome: 'listed',
      server: {
        name: 'GitHub',
        instructions: 'An MCP server for issues and files in your repositories.',
      },
    });
  });

  test('one line within the length a name may have, and instructions cut', async () => {
    const probe = await probeWith(
      { name: `Git\nHub\u0007${'x'.repeat(200)}`, version: '1.0.0' },
      'y'.repeat(5000),
    );
    if (probe.outcome !== 'listed') throw new Error('expected a listing');
    expect(probe.server?.name?.startsWith('Git Hub x')).toBe(true);
    expect(probe.server?.name).toHaveLength(MAXIMUM_TOOL_SOURCE_NAME_LENGTH);
    expect(probe.server?.instructions?.length).toBe(2000);
  });
});
