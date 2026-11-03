/**
 * The sample world's GitHub tool source (`tmp/design-review/decisions.md`, "Coordinator call: …
 * the GitHub tool source"): a local MCP server over stdio that the showcase home connects as the
 * source `github`, so Capabilities lists its three tools, List issues, Create issue and Delete
 * branch, with Delete branch left off. It stands in for GitHub's own server and never reaches
 * GitHub: each tool answers from fixed data, and nothing it is asked to do happens anywhere.
 *
 * The seed (`sample-world-seed.ts`) connects it as `bun <this file>`, which the host spawns on every
 * start.
 *
 * @module github-stub-mcp
 */

import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

/** The identifier the sample world saves the source under, which prefixes its tools' names. */
export const GITHUB_SOURCE_ID = 'github';

/** The three tools the server lists, by the name it serves each under, with each tool's title. */
export const GITHUB_STUB_TOOLS = {
  list_issues: 'List issues',
  create_issue: 'Create issue',
  delete_branch: 'Delete branch',
} as const;

/** The open issues List issues answers with. */
const OPEN_ISSUES = [
  { number: 212, title: 'Release notes skip merged changes on Fridays' },
  { number: 208, title: 'Refund approvals should say why they wait' },
] as const;

/** Builds the server, with the three tools registered. */
export function createGitHubStubServer(): McpServer {
  const server = new McpServer({ name: 'github', version: '1.0.0' });
  server.registerTool(
    'list_issues',
    {
      title: GITHUB_STUB_TOOLS.list_issues,
      description: 'List the open issues of a repository.',
      inputSchema: z.object({ repository: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async () => ({ content: [{ type: 'text', text: JSON.stringify(OPEN_ISSUES) }] }),
  );
  server.registerTool(
    'create_issue',
    {
      title: GITHUB_STUB_TOOLS.create_issue,
      description: 'Open a new issue in a repository.',
      inputSchema: z.object({ repository: z.string(), title: z.string(), body: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ title }) => ({
      content: [{ type: 'text', text: JSON.stringify({ number: 213, title }) }],
    }),
  );
  server.registerTool(
    'delete_branch',
    {
      title: GITHUB_STUB_TOOLS.delete_branch,
      description: 'Delete a branch from a repository. It can’t be undone.',
      inputSchema: z.object({ repository: z.string(), branch: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ branch }) => ({
      content: [{ type: 'text', text: JSON.stringify({ deleted: branch }) }],
    }),
  );
  return server;
}

if (import.meta.main) {
  await createGitHubStubServer().connect(new StdioServerTransport());
}
