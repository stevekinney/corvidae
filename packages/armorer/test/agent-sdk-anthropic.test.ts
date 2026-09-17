import type { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { createToolbox, type AnyToolbox } from '../src';

import { createTool } from '../src/create-tool';
import { createMCP } from '../src/integrations/mcp';

type McpSdkServerConfigurationWithInstance = ReturnType<typeof createSdkMcpServer>;

function textContent(content: unknown): string | undefined {
  const first = Array.isArray(content) ? content[0] : undefined;
  if (first && typeof first === 'object' && 'text' in first && typeof first.text === 'string') {
    return first.text;
  }
  return undefined;
}

describe('Anthropic Agent SDK MCP integration', () => {
  it('lists and executes tools through an in-process MCP server instance', async () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(
      createTool({
        name: 'sum',
        description: 'adds two numbers',
        input: z.object({ a: z.number(), b: z.number() }),
        async execute({ a, b }) {
          return a + b;
        },
      }),
    );

    const mcp = await createMCP(toolbox, {
      serverInfo: { name: 'toolbox-tools', version: '0.1.0' },
    });

    const configuration = {
      type: 'sdk',
      name: 'toolbox-tools',
      instance: mcp,
    } satisfies McpSdkServerConfigurationWithInstance;

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'anthropic-agent-sdk-test', version: '0.0.0' });
    await configuration.instance.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const tools = await client.listTools();
      const result = await client.callTool({ name: 'sum', arguments: { a: 2, b: 3 } });

      expect(tools.tools.some((tool) => tool.name === 'sum')).toBe(true);
      expect(textContent(result.content)).toContain('5');
    } finally {
      await client.close();
      await configuration.instance.close();
    }
  });
});
