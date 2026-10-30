import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { resolveCapabilityTier } from '../src/approval-policy';
import { expectPromiseToReject } from '../src/async-assertion-test-helpers';
import { createTool } from '../src/create-tool';
import { createToolbox } from '../src/create-toolbox';
import { createMCP } from '../src/integrations/mcp';
import { createInMemoryMcpOAuthTokenStorage } from '../src/integrations/mcp/oauth';
import type { OpenAPISpec } from '../src/integrations/openapi';
import {
  loadToolSource,
  loadToolSources,
  parseToolSourceDescription,
  ToolSourceAuthorizationRequiredError,
  ToolSourceCredentialError,
  ToolSourceDescriptionError,
  type ToolSourceCredentialRequest,
  type ToolSourceDescription,
} from '../src/integrations/tool-sources';
import petstoreSpec from './fixtures/petstore-expanded.json';

const SECRET = 'secret-value-123';

function recordingResolver(values: Record<string, string>) {
  const requests: ToolSourceCredentialRequest[] = [];
  return {
    requests,
    resolveCredential: (request: ToolSourceCredentialRequest) => {
      requests.push(request);
      return Object.hasOwn(values, request.credential) ? values[request.credential] : undefined;
    },
  };
}

function createRecordingFetch(body: unknown = []) {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const recordingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push({ url: request.url, headers: request.headers });
    return Response.json(body);
  }) as typeof fetch;
  return { fetch: recordingFetch, calls };
}

const openApiSource = (
  overrides: Partial<Extract<ToolSourceDescription, { kind: 'openapi' }>> = {},
): ToolSourceDescription => ({
  id: 'pets',
  kind: 'openapi',
  specification: { type: 'document', document: petstoreSpec as OpenAPISpec },
  baseUrl: 'https://pets.example.test',
  ...overrides,
});

describe('parseToolSourceDescription', () => {
  it('round-trips through JSON and holds no secret', () => {
    const description: ToolSourceDescription = {
      id: 'remote',
      kind: 'mcp',
      transport: {
        type: 'http',
        url: 'https://mcp.example.test/mcp',
        authentication: { type: 'bearer', credential: 'remote-token' },
      },
    };
    const restored = parseToolSourceDescription(JSON.parse(JSON.stringify(description)));
    expect(restored).toEqual(description);
  });

  it('rejects unknown fields, unknown kinds, and malformed values', () => {
    const invalid: unknown[] = [
      { id: 'a', kind: 'mcp', transport: { type: 'stdio', command: 'x', token: 'oops' } },
      { id: 'a', kind: 'graphql' },
      { id: '', kind: 'mcp', transport: { type: 'stdio', command: 'x' } },
      { id: 'a', kind: 'mcp', transport: { type: 'http', url: 'not a url' } },
      { id: 'a', kind: 'openapi', specification: { type: 'document', document: [] } },
      'a string',
      null,
    ];
    for (const value of invalid) {
      expect(() => parseToolSourceDescription(value)).toThrow(ToolSourceDescriptionError);
    }
  });
});

describe('loadToolSource for OpenAPI', () => {
  it('builds tools from an inline document and sends the resolved bearer credential', async () => {
    const { requests, resolveCredential } = recordingResolver({ 'pets-token': SECRET });
    const { fetch, calls } = createRecordingFetch([]);
    const loaded = await loadToolSource(
      openApiSource({ authentication: { type: 'bearer', credential: 'pets-token' } }),
      { resolveCredential, fetch },
    );

    expect(loaded.kind).toBe('openapi');
    expect(loaded.tools.map((tool) => tool.name).toSorted()).toEqual([
      'add-pet',
      'delete-pet',
      'find-pet-by-id',
      'find-pets',
    ]);
    expect(requests).toEqual([{ sourceId: 'pets', credential: 'pets-token' }]);

    const findPets = loaded.tools.find((tool) => tool.name === 'find-pets');
    await findPets?.execute({});
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.startsWith('https://pets.example.test/pets')).toBe(true);
    expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${SECRET}`);
    await loaded.close();
  });

  it('sends an API key in the named header', async () => {
    const { resolveCredential } = recordingResolver({ key: SECRET });
    const { fetch, calls } = createRecordingFetch([]);
    const loaded = await loadToolSource(
      openApiSource({
        authentication: { type: 'api-key', header: 'x-api-key', credential: 'key' },
      }),
      { resolveCredential, fetch },
    );
    await loaded.tools.find((tool) => tool.name === 'find-pets')?.execute({});
    expect(calls[0]?.headers.get('x-api-key')).toBe(SECRET);
  });

  it('fetches a document from its URL without credentials, and honors allowOperations and namePrefix', async () => {
    const { resolveCredential } = recordingResolver({ token: SECRET });
    const { fetch, calls } = createRecordingFetch(petstoreSpec);
    const loaded = await loadToolSource(
      openApiSource({
        specification: { type: 'url', url: 'https://specs.example.test/pets.json' },
        authentication: { type: 'bearer', credential: 'token' },
        allowOperations: ['findPets'],
        namePrefix: 'pets-',
      }),
      { resolveCredential, fetch },
    );
    expect(loaded.tools.map((tool) => tool.name)).toEqual(['pets-find-pets']);
    expect(calls[0]?.url).toBe('https://specs.example.test/pets.json');
    expect(calls[0]?.headers.get('authorization')).toBeNull();
  });

  it('reports an unusable document URL', async () => {
    const failing = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    const notJson = (async () => new Response('openapi: 3.0.0')) as unknown as typeof fetch;
    const description = openApiSource({
      specification: { type: 'url', url: 'https://specs.example.test/pets.yaml' },
    });
    const resolveCredential = () => undefined;
    await expectPromiseToReject(
      loadToolSource(description, { resolveCredential, fetch: failing }),
      (error) => expect(String(error)).toContain('HTTP 404'),
    );
    await expectPromiseToReject(
      loadToolSource(description, { resolveCredential, fetch: notJson }),
      (error) => expect(String(error)).toContain('not valid JSON'),
    );
  });

  it('fails with a named error, never a value, when the resolver has no credential', async () => {
    const { resolveCredential } = recordingResolver({});
    const failure = await loadToolSource(
      openApiSource({ authentication: { type: 'bearer', credential: 'missing' } }),
      { resolveCredential },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ToolSourceCredentialError);
    expect((failure as ToolSourceCredentialError).credential).toBe('missing');
  });

  it('never reads a credential from the environment', async () => {
    process.env['PETS_TOKEN'] = SECRET;
    try {
      const { fetch, calls } = createRecordingFetch([]);
      const loaded = await loadToolSource(openApiSource(), {
        resolveCredential: () => undefined,
        fetch,
      });
      await loaded.tools.find((tool) => tool.name === 'find-pets')?.execute({});
      expect(calls[0]?.headers.get('authorization')).toBeNull();
    } finally {
      delete process.env['PETS_TOKEN'];
    }
  });
});

async function createMcpFixture() {
  const toolbox = createToolbox([
    createTool({
      name: 'lookup',
      description: 'reads something',
      input: z.object({}),
      metadata: { readOnly: true },
      async execute() {
        return { found: true };
      },
    }),
    createTool({
      name: 'wipe',
      description: 'removes something',
      input: z.object({}),
      async execute() {
        return { wiped: true };
      },
    }),
  ]);
  const mcp = await createMCP(toolbox, {
    toolConfiguration: (tool) =>
      tool.name === 'wipe' ? { annotations: { destructiveHint: true } } : {},
  });
  const authorizations: Array<string | null> = [];
  const mcpFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    authorizations.push(request.headers.get('authorization'));
    return mcp.fetch(request);
  }) as typeof fetch;
  return { mcp, authorizations, fetch: mcpFetch };
}

describe('loadToolSource for MCP over HTTP', () => {
  it('lists the server tools with capability tiers and authenticates with the resolved bearer', async () => {
    const fixture = await createMcpFixture();
    const { requests, resolveCredential } = recordingResolver({ 'mcp-token': SECRET });
    const loaded = await loadToolSource(
      {
        id: 'remote',
        kind: 'mcp',
        transport: {
          type: 'http',
          url: 'http://mcp.example.test/mcp',
          authentication: { type: 'bearer', credential: 'mcp-token' },
        },
      },
      { resolveCredential, fetch: fixture.fetch },
    );
    try {
      expect(loaded.kind).toBe('mcp');
      const tiers = Object.fromEntries(
        loaded.tools.map((tool) => [tool.name, resolveCapabilityTier(tool.metadata, tool.tags)]),
      );
      expect(tiers).toEqual({ lookup: 'read-only', wipe: 'dangerous' });
      expect(await loaded.tools.find((tool) => tool.name === 'lookup')?.execute({})).toEqual({
        found: true,
      });
      expect(requests.every((request) => request.sourceId === 'remote')).toBe(true);
      expect(fixture.authorizations.length).toBeGreaterThan(0);
      expect(fixture.authorizations.every((value) => value === `Bearer ${SECRET}`)).toBe(true);
    } finally {
      await loaded.close();
      await loaded.close();
      await fixture.mcp.close();
    }
  });

  it('connects without authentication when the description names none', async () => {
    const fixture = await createMcpFixture();
    const loaded = await loadToolSource(
      {
        id: 'open',
        kind: 'mcp',
        transport: { type: 'http', url: 'http://mcp.example.test/mcp' },
      },
      { resolveCredential: () => undefined, fetch: fixture.fetch },
    );
    try {
      expect(loaded.tools).toHaveLength(2);
      expect(fixture.authorizations.every((value) => value === null)).toBe(true);
    } finally {
      await loaded.close();
      await fixture.mcp.close();
    }
  });

  it('fails before connecting when the bearer credential is missing', async () => {
    const fixture = await createMcpFixture();
    try {
      await expectPromiseToReject(
        loadToolSource(
          {
            id: 'remote',
            kind: 'mcp',
            transport: {
              type: 'http',
              url: 'http://mcp.example.test/mcp',
              authentication: { type: 'bearer', credential: 'absent' },
            },
          },
          { resolveCredential: () => undefined, fetch: fixture.fetch },
        ),
        (error) => expect(error).toBeInstanceOf(ToolSourceCredentialError),
      );
      expect(fixture.authorizations).toEqual([]);
    } finally {
      await fixture.mcp.close();
    }
  });

  it('needs oauth options for an OAuth source, and reports when authorization is required', async () => {
    const description: ToolSourceDescription = {
      id: 'oauth-remote',
      kind: 'mcp',
      transport: {
        type: 'http',
        url: 'http://mcp.example.test/mcp',
        authentication: { type: 'oauth', scope: 'tools' },
      },
    };
    await expectPromiseToReject(
      loadToolSource(description, { resolveCredential: () => undefined }),
      (error) => expect(String(error)).toContain('no `oauth` options'),
    );

    const storageRequests: string[] = [];
    const authorizationUrls: URL[] = [];
    const storage = createInMemoryMcpOAuthTokenStorage();
    const issuer = 'http://mcp.example.test/';
    // Just enough of an authorization server for the SDK to reach the redirect step.
    const authorizationServer = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const { pathname } = new URL(new Request(input, init).url);
      if (pathname === '/.well-known/oauth-protected-resource') {
        return Response.json({ resource: issuer, authorization_servers: [issuer] });
      }
      if (pathname === '/.well-known/oauth-authorization-server') {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}authorize`,
          token_endpoint: `${issuer}token`,
          registration_endpoint: `${issuer}register`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
        });
      }
      if (pathname === '/register') {
        return Response.json({ client_id: 'registered-client', redirect_uris: [] });
      }
      return new Response(null, {
        status: 401,
        headers: {
          'WWW-Authenticate': `Bearer resource_metadata="${issuer}.well-known/oauth-protected-resource"`,
        },
      });
    }) as typeof fetch;
    const failure = await loadToolSource(description, {
      resolveCredential: () => undefined,
      fetch: authorizationServer,
      oauth: {
        tokenStorage: (sourceId) => {
          storageRequests.push(sourceId);
          return storage;
        },
        redirectUrl: 'http://127.0.0.1:9/callback',
        onAuthorizationRequired: (_sourceId, url) => {
          authorizationUrls.push(url);
        },
      },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ToolSourceAuthorizationRequiredError);
    expect(authorizationUrls).toHaveLength(1);
    expect(authorizationUrls[0]?.searchParams.get('client_id')).toBe('registered-client');
    const stored = await storage.load();
    expect(stored.clientInformation?.client_id).toBe('registered-client');
    expect(storageRequests).toEqual(['oauth-remote']);
  });
});

describe('loadToolSource for MCP over stdio', () => {
  it('spawns the command and injects credentials only through the resolver', async () => {
    const { requests, resolveCredential } = recordingResolver({ 'child-token': SECRET });
    process.env['CHILD_TOKEN'] = 'from-the-parent-environment';
    const loaded = await loadToolSource(
      {
        id: 'local',
        kind: 'mcp',
        transport: {
          type: 'stdio',
          command: process.execPath,
          args: [
            '--no-install',
            new URL('./fixtures/tool-source-stdio-server.ts', import.meta.url).pathname,
          ],
          env: { PLAIN_SETTING: 'plain' },
          credentialEnv: { SOURCE_TOKEN: 'child-token' },
        },
      },
      { resolveCredential },
    );
    try {
      expect(loaded.tools.map((tool) => tool.name)).toEqual(['read-environment']);
      expect(loaded.tools.map((tool) => resolveCapabilityTier(tool.metadata))).toEqual([
        'read-only',
      ]);
      const read = (name: string) => loaded.tools[0]?.execute({ name });
      expect(await read('SOURCE_TOKEN')).toBe(SECRET);
      expect(await read('PLAIN_SETTING')).toBe('plain');
      expect(await read('CHILD_TOKEN')).toBe('unset');
      expect(requests).toEqual([{ sourceId: 'local', credential: 'child-token' }]);
    } finally {
      delete process.env['CHILD_TOKEN'];
      await loaded.close();
    }
  });
});

describe('loadToolSources', () => {
  it('loads the sources that work and reports the ones that fail', async () => {
    const { fetch } = createRecordingFetch([]);
    const result = await loadToolSources(
      [
        openApiSource({ id: 'good' }),
        openApiSource({ id: 'bad', authentication: { type: 'bearer', credential: 'absent' } }),
      ],
      { resolveCredential: () => undefined, fetch },
    );
    expect(result.sources.map((source) => source.id)).toEqual(['good']);
    expect(result.failures.map((failure) => failure.id)).toEqual(['bad']);
    expect(result.failures[0]?.error).toBeInstanceOf(ToolSourceCredentialError);
  });
});
