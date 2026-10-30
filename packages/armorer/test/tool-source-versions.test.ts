/**
 * COR-1950: a saved tool source gives each tool a version derived from what a person approves, so
 * Armorer can bind an approval to it (it refuses an unversioned tool). The version is the same at
 * every load of an unchanged tool, and differs when the input schema, the capability, where the
 * call goes, or (for OpenAPI) the operation changes. It does not move with prose a server may
 * reword, or with a credential.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool } from '../src/create-tool';
import { createToolbox } from '../src/create-toolbox';
import { createMCP } from '../src/integrations/mcp';
import type { OpenAPISpec } from '../src/integrations/openapi';
import {
  loadToolSource,
  type LoadedToolSource,
  type ToolSourceDescription,
} from '../src/integrations/tool-sources';

const loaded: LoadedToolSource[] = [];

afterEach(async () => {
  for (const source of loaded.splice(0)) await source.close();
});

/** The version of each tool of `source`, by name. */
function versionsOf(source: LoadedToolSource): Record<string, string | undefined> {
  return Object.fromEntries(source.tools.map((tool) => [tool.name, tool.identity.version]));
}

async function load(
  description: ToolSourceDescription,
  fetch?: typeof globalThis.fetch,
): Promise<Record<string, string | undefined>> {
  const source = await loadToolSource(description, {
    resolveCredential: (request) => `credential-for-${request.credential}`,
    ...(fetch === undefined ? {} : { fetch }),
  });
  loaded.push(source);
  return versionsOf(source);
}

const VERSION = /^[0-9a-f]{32}$/;

function document(
  overrides: { listDescription?: string; createBodyType?: string } = {},
): OpenAPISpec {
  return {
    openapi: '3.0.0',
    info: { title: 'Pets', version: '1.0.0' },
    paths: {
      '/pets': {
        get: {
          operationId: 'listPets',
          description: overrides.listDescription ?? 'Lists pets.',
          responses: { '200': { description: 'ok' } },
        },
        post: {
          operationId: 'createPet',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { name: { type: overrides.createBodyType ?? 'string' } },
                },
              },
            },
          },
          responses: { '200': { description: 'ok' } },
        },
      },
      '/pets/{id}': {
        delete: {
          operationId: 'deletePet',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  } as OpenAPISpec;
}

function openApi(
  overrides: Partial<Extract<ToolSourceDescription, { kind: 'openapi' }>> & {
    spec?: OpenAPISpec;
  } = {},
): ToolSourceDescription {
  const { spec, ...rest } = overrides;
  return {
    id: 'pets',
    kind: 'openapi',
    specification: { type: 'document', document: spec ?? document() },
    baseUrl: 'https://pets.example.test/',
    ...rest,
  };
}

describe('the version of an OpenAPI tool', () => {
  it('is a digest, differs between operations, and is part of the tool id', async () => {
    const source = await loadToolSource(openApi(), { resolveCredential: () => undefined });
    loaded.push(source);
    const versions = source.tools.map((tool) => tool.identity.version);

    for (const version of versions) expect(version).toMatch(VERSION);
    expect(new Set(versions).size).toBe(source.tools.length);
    for (const tool of source.tools) expect(tool.id).toEndWith(`@${tool.identity.version}`);
  });

  it('is the same at every load of an unchanged source, and with another credential', async () => {
    const first = await load(openApi());
    const second = await load(
      openApi({ authentication: { type: 'bearer', credential: 'another-credential' } }),
    );

    expect(second).toEqual(first);
  });

  it('does not move with the operation description, which a server may reword', async () => {
    const before = await load(openApi());
    const after = await load(openApi({ spec: document({ listDescription: 'Lists every pet.' }) }));

    expect(after).toEqual(before);
  });

  it('moves only for the operation whose schema changed', async () => {
    const before = await load(openApi());
    const after = await load(openApi({ spec: document({ createBodyType: 'integer' }) }));

    expect(after['create-pet']).not.toBe(before['create-pet']);
    expect(after['list-pets']).toBe(before['list-pets']);
    expect(after['delete-pet']).toBe(before['delete-pet']);
  });

  it('moves for every tool when the service moves, or the source is saved under another id', async () => {
    const before = await load(openApi());
    const elsewhere = await load(openApi({ baseUrl: 'https://other.example.test/' }));
    const renamed = await load(openApi({ id: 'animals' }));

    for (const name of Object.keys(before)) {
      expect(elsewhere[name]).not.toBe(before[name]);
      expect(renamed[name]).not.toBe(before[name]);
    }
  });

  it('moves when an operation is the same but its path or method is not', async () => {
    const before = await load(openApi());
    const moved = document();
    const { '/pets/{id}': item = {}, ...rest } = moved.paths ?? {};
    const after = await load(
      openApi({ spec: { ...moved, paths: { ...rest, '/animals/{id}': item } } }),
    );

    expect(after['delete-pet']).not.toBe(before['delete-pet']);
    expect(after['list-pets']).toBe(before['list-pets']);
  });
});

/** An MCP server over the in-memory fetch, with a `remove` tool whose schema and annotations vary. */
async function mcpServer(
  options: { field?: string; destructive?: boolean; description?: string } = {},
) {
  const toolbox = createToolbox([
    createTool({
      name: 'remove',
      description: options.description ?? 'removes something',
      input: z.object({ [options.field ?? 'target']: z.string() }),
      async execute() {
        return { removed: true };
      },
    }),
    createTool({
      name: 'lookup',
      description: 'reads something',
      input: z.object({}),
      metadata: { readOnly: true },
      async execute() {
        return { found: true };
      },
    }),
  ]);
  const mcp = await createMCP(toolbox, {
    toolConfiguration: (tool) =>
      tool.name === 'remove' && options.destructive === true
        ? { annotations: { destructiveHint: true } }
        : {},
  });
  return {
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      mcp.fetch(new Request(input, init))) as typeof fetch,
    close: () => mcp.close(),
  };
}

const mcpSource = (url = 'http://mcp.example.test/mcp', id = 'remote'): ToolSourceDescription => ({
  id,
  kind: 'mcp',
  transport: { type: 'http', url },
});

async function mcpVersions(
  options: Parameters<typeof mcpServer>[0] = {},
  description: ToolSourceDescription = mcpSource(),
) {
  const server = await mcpServer(options);
  try {
    return await load(description, server.fetch);
  } finally {
    await server.close();
  }
}

describe('the version of an MCP tool', () => {
  it('is a digest, and the same on a new server process with the same tools', async () => {
    const first = await mcpVersions();
    const second = await mcpVersions();

    expect(first['remove']).toMatch(VERSION);
    expect(first['lookup']).toMatch(VERSION);
    expect(first['remove']).not.toBe(first['lookup']);
    expect(second).toEqual(first);
  });

  it('does not move with the description', async () => {
    const before = await mcpVersions();
    const after = await mcpVersions({ description: 'deletes things, reworded' });

    expect(after).toEqual(before);
  });

  it('moves for the tool whose input schema changed, and for no other', async () => {
    const before = await mcpVersions();
    const after = await mcpVersions({ field: 'path' });

    expect(after['remove']).not.toBe(before['remove']);
    expect(after['lookup']).toBe(before['lookup']);
  });

  it('moves when the server widens a tool to destructive', async () => {
    const before = await mcpVersions();
    const after = await mcpVersions({ destructive: true });

    expect(after['remove']).not.toBe(before['remove']);
    expect(after['lookup']).toBe(before['lookup']);
  });

  it('moves for every tool when the server is at another address, or saved under another id', async () => {
    const before = await mcpVersions();
    const elsewhere = await mcpVersions({}, mcpSource('http://other.example.test/mcp'));
    const renamed = await mcpVersions({}, mcpSource('http://mcp.example.test/mcp', 'other'));

    for (const name of Object.keys(before)) {
      expect(elsewhere[name]).not.toBe(before[name]);
      expect(renamed[name]).not.toBe(before[name]);
    }
  });
});
