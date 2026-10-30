import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

import { readEnvironmentVariable } from './environment-configuration';

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
  async ({ name }) => ({
    content: [{ type: 'text', text: readEnvironmentVariable(name) ?? 'unset' }],
  }),
);
await mcp.connect(new StdioServerTransport());
