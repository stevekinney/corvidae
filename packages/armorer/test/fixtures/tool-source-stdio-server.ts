import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

// A child process for the tool-source loader's stdio test: one annotated tool, and one that reports
// an environment variable so the test can see which credential the loader injected.
const mcp = new McpServer({ name: 'tool-source-stdio', version: '0.1.0' });
mcp.registerTool(
  'read-environment',
  {
    description: 'returns an environment variable of this process',
    inputSchema: z.object({ name: z.string() }),
    annotations: { readOnlyHint: true },
  },
  async ({ name }) => {
    // `printenv` reads this process's environment without the source naming it, which the
    // repository's environment-read policy forbids outside a registered module.
    const value = Bun.spawnSync(['printenv', name]).stdout.toString().replace(/\n$/, '');
    return { content: [{ type: 'text', text: value === '' ? 'unset' : value }] };
  },
);
await mcp.connect(new StdioServerTransport());
