/**
 * The saved tool sources the end-to-end host starts with (`tool-sources-support.ts` names them): two
 * servers on loopback ports the seed starts, and the `toolSources` key of the host's configuration.
 * Tool sources load when the host starts, so they are written before it does.
 *
 * - `e2e-notes`: an MCP server that needs no credential, with `lookup` (read-only) and `wipe`
 *   (destructive).
 * - `e2e-petstore`: an OpenAPI document embedded in the description, so it needs no server, whose
 *   `create-pet` is flagged `acceptsSecrets` and whose settings also name a tool it does not list.
 * - `e2e-ledger`: an MCP server behind a mock OAuth authorization server (`startOAuthMcpServer`),
 *   with no tokens, so it waits for a sign-in.
 * - `e2e-broken`: an MCP address nothing listens on, so it fails with the host's message.
 *
 * No credential is stored and no real service is called; every token the OAuth server issues is made up.
 */
import { createMCP, createTool, createToolbox } from 'armorer';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import { startOAuthMcpServer } from '../../src/host/tool-source-servers.test-support.ts';
import {
  E2E_FLAGGED_TOOL,
  E2E_LONG_OPERATION,
  E2E_TOOL_SOURCES,
  E2E_UNMATCHED_TOOL,
} from './tool-sources-support.ts';

/** The servers the seed started, and how to stop them. */
export type ToolSourceServers = {
  readonly notesOrigin: string;
  readonly ledgerOrigin: string;
  stop(): Promise<void>;
};

const lookup = createTool({
  name: 'lookup',
  description: 'reads something',
  input: z.object({}),
  metadata: { readOnly: true },
  async execute() {
    return { found: true };
  },
});

const wipe = createTool({
  name: 'wipe',
  description: 'removes something',
  input: z.object({}),
  async execute() {
    return { wiped: true };
  },
});

/** Starts the MCP servers the seeded sources point at. */
export async function startToolSourceServers(): Promise<ToolSourceServers> {
  const mcp = await createMCP(createToolbox([lookup, wipe]), {
    toolConfiguration: (tool) =>
      tool.name === 'wipe' ? { annotations: { destructiveHint: true } } : {},
  });
  const notes = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => mcp.fetch(request),
  });
  const ledger = await startOAuthMcpServer();
  return {
    notesOrigin: `http://127.0.0.1:${notes.port}`,
    ledgerOrigin: ledger.origin,
    stop: async () => {
      await notes.stop(true);
      await ledger.stop();
    },
  };
}

function operation(operationId: string) {
  return { operationId, responses: { '200': { description: 'ok' } } };
}

/** An OpenAPI document with a read, a write, a delete and a read with a long name. */
const PETSTORE_DOCUMENT = {
  openapi: '3.0.0',
  info: { title: 'Pets', version: '1.0.0' },
  paths: {
    '/pets': { get: operation('listPets'), post: operation('createPet') },
    '/pets/{id}': {
      delete: {
        ...operation('deletePet'),
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      },
    },
    '/everything': { get: operation(E2E_LONG_OPERATION) },
  },
};

/** Adds the `toolSources` key to the configuration `home` already holds, leaving every other key as it was. */
export async function seedToolSources(home: string, servers: ToolSourceServers): Promise<void> {
  const path = join(home, 'configuration.json');
  const configuration = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  await writeFile(
    path,
    JSON.stringify({
      ...configuration,
      toolSources: [
        {
          source: {
            id: E2E_TOOL_SOURCES.notes,
            kind: 'mcp',
            transport: { type: 'http', url: `${servers.notesOrigin}/` },
          },
        },
        {
          source: {
            id: E2E_TOOL_SOURCES.petstore,
            kind: 'openapi',
            specification: { type: 'document', document: PETSTORE_DOCUMENT },
            baseUrl: 'http://127.0.0.1:9',
          },
          tools: {
            [E2E_FLAGGED_TOOL]: { acceptsSecrets: true },
            [E2E_UNMATCHED_TOOL]: { acceptsSecrets: true },
          },
        },
        {
          source: {
            id: E2E_TOOL_SOURCES.ledger,
            kind: 'mcp',
            transport: {
              type: 'http',
              url: `${servers.ledgerOrigin}/`,
              authentication: { type: 'oauth' },
            },
          },
        },
        {
          source: {
            id: E2E_TOOL_SOURCES.broken,
            kind: 'mcp',
            transport: { type: 'http', url: 'http://127.0.0.1:9/' },
          },
        },
      ],
    }),
  );
}
