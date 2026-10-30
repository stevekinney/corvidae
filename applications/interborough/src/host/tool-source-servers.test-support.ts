/**
 * In-process servers the saved-tool-source tests connect to, each on a free loopback port. No
 * network beyond the loopback is touched, and every token in them is made up for the test.
 *
 * - {@link startMcpServer}: an MCP server over Streamable HTTP that answers only a bearer token it
 *   was given, with a read-only tool (`lookup`) and a destructive one (`wipe`).
 * - {@link startOAuthMcpServer}: an MCP server behind a mock OAuth authorization server (discovery,
 *   dynamic registration, PKCE, authorization code and refresh grants, RFC 9207 `iss`), whose one
 *   tool is `echo`.
 * - {@link petsDocument}: an OpenAPI document with a read, a write, and a delete operation.
 * - {@link startRenamingMcpServer}, {@link startPetsServer} and {@link writablePetsDocument}: a
 *   mutating MCP tool and a mutating OpenAPI operation that record the calls that ran, whose input
 *   schema a test can change (COR-1950).
 */
import { createMCP, createTool, createToolbox } from 'armorer';
import { z } from 'zod';

/** A started server: its origin, what it saw, and how to stop it. */
export type TestServer = {
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string;
  /** The `Authorization` header of every MCP request it answered or refused, in order. */
  readonly authorizations: readonly (string | null)[];
  /** Stop listening. */
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

/** A read-only tool named `name`, for a server whose tool names a test chooses. */
function namedTool(name: string) {
  return createTool({
    name,
    description: `reads something called ${name}`,
    input: z.object({}),
    metadata: { readOnly: true },
    async execute() {
      return { found: true };
    },
  });
}

/**
 * An MCP server that serves only the read-only tools `toolNames`, in that order, to
 * `Authorization: Bearer <token>`.
 */
export function startMcpServerListing(
  token: string,
  toolNames: readonly string[],
): Promise<TestServer> {
  return serveMcp(token, toolNames.map(namedTool), () => ({}));
}

/** An MCP server that serves its tools only to `Authorization: Bearer <token>`. */
export function startMcpServer(token: string): Promise<TestServer> {
  return serveMcp(token, [lookup, wipe], (tool) =>
    tool.name === 'wipe' ? { annotations: { destructiveHint: true } } : {},
  );
}

async function serveMcp(
  token: string,
  tools: Parameters<typeof createToolbox>[0],
  toolConfiguration: (tool: { name: string }) => Record<string, unknown>,
): Promise<TestServer> {
  const mcp = await createMCP(createToolbox(tools), {
    toolConfiguration,
  });
  const authorizations: (string | null)[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const header = request.headers.get('authorization');
      authorizations.push(header);
      if (header !== `Bearer ${token}`) return new Response('unauthorized', { status: 401 });
      return mcp.fetch(request);
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    authorizations,
    stop: () => server.stop(true),
  };
}

/** What the OAuth server issued and received, for a test to look for in storage. */
export type OAuthMcpServer = TestServer & {
  /** The access token the server has issued, if any. */
  readonly issuedAccessTokens: readonly string[];
  /** The PKCE verifiers it received at the token endpoint. */
  readonly receivedVerifiers: readonly string[];
};

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Buffer.from(digest).toString('base64url');
}

/** An MCP server that needs an OAuth access token, with the authorization server beside it. */
export async function startOAuthMcpServer(): Promise<OAuthMcpServer> {
  const echo = createTool({
    name: 'echo',
    description: 'echoes the given message',
    input: z.object({ message: z.string() }),
    metadata: { readOnly: true },
    async execute({ message }) {
      return { message };
    },
  });
  const mcp = await createMCP(createToolbox([echo]), {
    serverInfo: { name: 'mock-mcp', version: '1.0.0' },
  });
  const clients = new Set<string>();
  const codes = new Map<string, { clientId: string; challenge: string }>();
  const accessTokens = new Set<string>();
  const refreshTokens = new Set<string>();
  const issuedAccessTokens: string[] = [];
  const receivedVerifiers: string[] = [];
  const authorizations: (string | null)[] = [];

  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const issuer = `http://127.0.0.1:${server.port}/`;
      const url = new URL(request.url);
      if (url.pathname === '/.well-known/oauth-protected-resource') {
        return Response.json({ resource: issuer, authorization_servers: [issuer] });
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}authorize`,
          token_endpoint: `${issuer}token`,
          registration_endpoint: `${issuer}register`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none'],
          authorization_response_iss_parameter_supported: true,
        });
      }
      if (url.pathname === '/register' && request.method === 'POST') {
        const body = (await request.json()) as Record<string, unknown>;
        const clientId = `client-${crypto.randomUUID()}`;
        clients.add(clientId);
        return Response.json({ ...body, client_id: clientId });
      }
      if (url.pathname === '/authorize') {
        const clientId = url.searchParams.get('client_id');
        const redirectUri = url.searchParams.get('redirect_uri');
        const challenge = url.searchParams.get('code_challenge');
        const state = url.searchParams.get('state');
        if (!clientId || !clients.has(clientId) || !redirectUri || !challenge) {
          return new Response('invalid_request', { status: 400 });
        }
        const code = `code-${crypto.randomUUID()}`;
        codes.set(code, { clientId, challenge });
        const redirect = new URL(redirectUri);
        redirect.searchParams.set('code', code);
        if (state) redirect.searchParams.set('state', state);
        redirect.searchParams.set('iss', issuer);
        return Response.redirect(redirect.toString(), 302);
      }
      if (url.pathname === '/token' && request.method === 'POST') {
        const params = new URLSearchParams(await request.text());
        if (params.get('grant_type') === 'authorization_code') {
          const code = params.get('code') ?? '';
          const verifier = params.get('code_verifier') ?? '';
          const entry = codes.get(code);
          if (
            entry === undefined ||
            entry.clientId !== params.get('client_id') ||
            (await sha256Base64Url(verifier)) !== entry.challenge
          ) {
            return Response.json({ error: 'invalid_grant' }, { status: 400 });
          }
          receivedVerifiers.push(verifier);
          codes.delete(code);
          const accessToken = `access-${crypto.randomUUID()}`;
          const refreshToken = `refresh-${crypto.randomUUID()}`;
          accessTokens.add(accessToken);
          refreshTokens.add(refreshToken);
          issuedAccessTokens.push(accessToken);
          return Response.json({
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: refreshToken,
          });
        }
        return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
      }
      if (url.pathname === '/') {
        const header = request.headers.get('authorization');
        authorizations.push(header);
        const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
        if (token === undefined || !accessTokens.has(token)) {
          return new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': `Bearer resource_metadata="${issuer}.well-known/oauth-protected-resource"`,
            },
          });
        }
        return mcp.fetch(request);
      }
      return new Response('not found', { status: 404 });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    authorizations,
    issuedAccessTokens,
    receivedVerifiers,
    stop: () => server.stop(true),
  };
}

/** An OpenAPI document: a read, a write, and a delete operation. Its tools are `list-pets`, `create-pet` and `delete-pet`. */
export const petsDocument = {
  openapi: '3.0.0',
  info: { title: 'Pets', version: '1.0.0' },
  paths: {
    '/pets': {
      get: { operationId: 'listPets', responses: { '200': { description: 'ok' } } },
      post: { operationId: 'createPet', responses: { '200': { description: 'ok' } } },
    },
    '/pets/{id}': {
      delete: {
        operationId: 'deletePet',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'ok' } },
      },
    },
  },
};

/** What {@link startRenamingMcpServer} saw: the arguments of every `rename` call that ran. */
export type RenamingMcpServer = TestServer & {
  /** The arguments of each `rename` call the server executed, in order. */
  readonly renamed: readonly unknown[];
  /**
   * Serve `rename` with its one string argument called `field` from now on, at the same address:
   * the server changed its tool's input schema between two starts of the host.
   */
  changeField(field: string): Promise<void>;
};

async function renamingMcp(field: string, renamed: unknown[]) {
  const rename = createTool({
    name: 'rename',
    description: 'renames something',
    input: z.object({ [field]: z.string() }),
    // No annotations: an MCP tool the server does not vouch for is a mutating one.
    async execute(params) {
      renamed.push(params);
      return { renamed: true };
    },
  });
  return createMCP(createToolbox([rename]));
}

/**
 * An MCP server over Streamable HTTP for the approval tests: one mutating tool, `rename`, that
 * records every call it ran, answering only `Authorization: Bearer <token>`.
 */
export async function startRenamingMcpServer(token: string): Promise<RenamingMcpServer> {
  const renamed: unknown[] = [];
  const authorizations: (string | null)[] = [];
  let mcp = await renamingMcp('target', renamed);
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const header = request.headers.get('authorization');
      authorizations.push(header);
      if (header !== `Bearer ${token}`) return new Response('unauthorized', { status: 401 });
      return mcp.fetch(request);
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    authorizations,
    renamed,
    async changeField(field) {
      mcp = await renamingMcp(field, renamed);
    },
    stop: () => server.stop(true),
  };
}

/** What {@link startPetsServer} saw: every request that reached it. */
export type PetsServer = TestServer & {
  /** The method, path and JSON body of each request, in order. */
  readonly requests: readonly { method: string; path: string; body: unknown }[];
};

/** A service for {@link writablePetsDocument} to point at, which records what it is sent. */
export async function startPetsServer(): Promise<PetsServer> {
  const requests: { method: string; path: string; body: unknown }[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const text = await request.text();
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: text === '' ? null : (JSON.parse(text) as unknown),
      });
      return Response.json({ ok: true });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    authorizations: [],
    requests,
    stop: () => server.stop(true),
  };
}

/**
 * An OpenAPI document with one write, `createPet` (the tool `create-pet`), whose JSON body is an
 * object with one string property called `field`.
 */
export function writablePetsDocument(field: string) {
  return {
    openapi: '3.0.0',
    info: { title: 'Pets', version: '1.0.0' },
    paths: {
      '/pets': {
        post: {
          operationId: 'createPet',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', properties: { [field]: { type: 'string' } } },
              },
            },
          },
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };
}
