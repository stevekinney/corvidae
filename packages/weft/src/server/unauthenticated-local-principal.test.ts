/**
 * The `unauthenticated-local` principal and the scope requirement on static
 * API keys (COR-1466).
 *
 * A `serve()` with no authentication identifies nobody, so every request runs
 * as the one local user, who holds every built-in scope. A `serve()` with
 * static API keys must say which scopes those keys hold, because every
 * operation except `weft.system.principal` now requires one.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { Engine } from '../core/engine.ts';
import { MCP_PROTOCOL_VERSION } from '../mcp/protocol.ts';
import { MemoryStorage } from '../storage/memory.ts';
import type { AuthConfig } from './authentication.ts';
import { AUTHORIZATION_SCOPES } from './authorization-scope.ts';
import { authContextToPrincipal } from './handler/auth-context-principal.ts';
import { serve, type WeftServer } from './index.ts';
import { principalFromUnauthenticatedLocal } from './principal.ts';
import { NO_AUTHENTICATION_WARNING } from './serve-internals.ts';

const API_KEY = 'unauthenticated-local-test-key';
const ALL_SCOPES_SORTED = [...AUTHORIZATION_SCOPES].toSorted();

type PrincipalBody = {
  readonly method: string;
  readonly subject: string | null;
  readonly scopes: readonly string[];
};

function createEngine(): Engine {
  return new Engine({ storage: new MemoryStorage() });
}

async function readPrincipal(server: WeftServer, headers?: HeadersInit): Promise<PrincipalBody> {
  const response = await fetch(`${server.url}/v1/principal`, headers ? { headers } : undefined);
  expect(response.status).toBe(200);
  return (await response.json()) as PrincipalBody;
}

describe('the unauthenticated-local principal', () => {
  it('holds every built-in scope and names itself', () => {
    const principal = principalFromUnauthenticatedLocal();

    expect(principal.method).toBe('unauthenticated-local');
    expect(principal.subject).toBe('unauthenticated-local');
    expect([...principal.scopes].toSorted()).toEqual(ALL_SCOPES_SORTED);
    for (const scope of AUTHORIZATION_SCOPES) expect(principal.hasScope(scope)).toBe(true);
  });

  it('has scopes that cannot be widened, narrowed, or cleared by a caller', () => {
    const { scopes } = principalFromUnauthenticatedLocal();
    const mutable = scopes as Set<string>;

    expect(() => mutable.add('bureau.tasks:read')).toThrow(TypeError);
    expect(() => mutable.delete('workflows:read')).toThrow(TypeError);
    expect(() => mutable.clear()).toThrow(TypeError);
    expect([...scopes].toSorted()).toEqual(ALL_SCOPES_SORTED);
    expect(principalFromUnauthenticatedLocal().hasScope('bureau.tasks:read')).toBe(false);
  });

  it('is one shared instance, so two requests compare as the same owner', () => {
    expect(principalFromUnauthenticatedLocal()).toBe(principalFromUnauthenticatedLocal());
  });

  it('is what an unauthenticated-local auth context resolves to', () => {
    expect(authContextToPrincipal({ method: 'unauthenticated-local' })).toBe(
      principalFromUnauthenticatedLocal(),
    );
  });
});

describe('serve() with no authentication', () => {
  let engine: Engine | undefined;
  let server: WeftServer | undefined;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
    server = undefined;
    engine = undefined;
  });

  for (const unauthenticatedAccess of [undefined, 'warn', 'allow'] as const) {
    describe(`unauthenticatedAccess: ${unauthenticatedAccess ?? '(default)'}`, () => {
      it('runs every request as the unauthenticated-local principal', async () => {
        const warningSpy = spyOn(console, 'warn').mockImplementation(() => {});
        try {
          engine = createEngine();
          server = serve({
            engine,
            port: 0,
            publicOrigin: 'http://localhost',
            ...(unauthenticatedAccess === undefined ? {} : { unauthenticatedAccess }),
          });

          expect(await readPrincipal(server)).toEqual({
            method: 'unauthenticated-local',
            subject: 'unauthenticated-local',
            scopes: ALL_SCOPES_SORTED,
          });
        } finally {
          warningSpy.mockRestore();
        }
      });

      it('reaches operations that require a scope, over REST and JSON-RPC', async () => {
        const warningSpy = spyOn(console, 'warn').mockImplementation(() => {});
        try {
          engine = createEngine();
          server = serve({
            engine,
            port: 0,
            publicOrigin: 'http://localhost',
            ...(unauthenticatedAccess === undefined ? {} : { unauthenticatedAccess }),
          });

          // workflows:read and system:read, over REST.
          const workflowList = await fetch(`${server.url}/v1/workflows`);
          const retention = await fetch(`${server.url}/v1/retention`);
          expect(workflowList.status).toBe(200);
          expect(retention.status).toBe(200);

          // workflows:admin, over JSON-RPC.
          const response = await fetch(`${server.url}/jsonrpc`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'weft.recover.all', params: {} }),
          });
          expect(await response.json()).toMatchObject({ id: 1, result: { recovered: [] } });
        } finally {
          warningSpy.mockRestore();
        }
      });
    });
  }

  it('records the unauthenticated-local principal in the audit event of a confirmed bulk operation', async () => {
    const warningSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      engine = createEngine();
      server = serve({ engine, port: 0, publicOrigin: 'http://localhost' });
    } finally {
      warningSpy.mockRestore();
    }

    const bulkCancel = async (body: object): Promise<Record<string, unknown>> => {
      const response = await fetch(`${server?.url}/v1/workflows/bulk/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filter: { tags: ['audit-probe'] }, ...body }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as Record<string, unknown>;
    };

    const preview = await bulkCancel({ dryRun: true });
    const committed = await bulkCancel({ confirmationToken: preview['confirmationToken'] });

    expect(committed['auditEvent']).toMatchObject({
      principal: { method: 'unauthenticated-local', subject: 'unauthenticated-local' },
    });
  });

  it("warns that every built-in operation is accessible, and names the local principal, under 'warn'", () => {
    const warningSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      engine = createEngine();
      server = serve({ engine, port: 0, publicOrigin: 'http://localhost' });

      expect(warningSpy).toHaveBeenCalledWith(NO_AUTHENTICATION_WARNING);
      expect(NO_AUTHENTICATION_WARNING).toContain(
        'every built-in operation is accessible to any caller',
      );
      expect(NO_AUTHENTICATION_WARNING).toContain('unauthenticated-local');
      expect(NO_AUTHENTICATION_WARNING).not.toContain('non-public');
      // A package scope is granted only to a credential that holds it.
      expect(NO_AUTHENTICATION_WARNING).toContain('package scope');
    } finally {
      warningSpy.mockRestore();
    }
  });

  it("refuses to start under 'reject', before binding", () => {
    const rejectingEngine = createEngine();
    engine = rejectingEngine;
    expect(() =>
      serve({ engine: rejectingEngine, port: 0, unauthenticatedAccess: 'reject' }),
    ).toThrow('Refusing to start server with no authentication');
  });

  it('refuses to start when WEFT_SERVER_AUTHENTICATION_REQUIRED demands authentication', () => {
    const previous = Bun.env['WEFT_SERVER_AUTHENTICATION_REQUIRED'];
    Bun.env['WEFT_SERVER_AUTHENTICATION_REQUIRED'] = '1';
    try {
      const requiringEngine = createEngine();
      engine = requiringEngine;
      expect(() =>
        serve({ engine: requiringEngine, port: 0, unauthenticatedAccess: 'allow' }),
      ).toThrow('WEFT_SERVER_AUTHENTICATION_REQUIRED');
    } finally {
      if (previous === undefined) delete Bun.env['WEFT_SERVER_AUTHENTICATION_REQUIRED'];
      else Bun.env['WEFT_SERVER_AUTHENTICATION_REQUIRED'] = previous;
    }
  });
});

describe('serve() with authentication configured', () => {
  let engine: Engine | undefined;
  let server: WeftServer | undefined;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
    server = undefined;
    engine = undefined;
  });

  it('never gives a credential-bearing caller the local principal', async () => {
    engine = createEngine();
    server = serve({
      engine,
      port: 0,
      publicOrigin: 'http://localhost',
      auth: { apiKeys: [API_KEY], defaultApiKeyScopes: ['workflows:read'] },
    });

    expect(await readPrincipal(server, { 'X-API-Key': API_KEY })).toEqual({
      method: 'api-key',
      subject: 'api-key-caller',
      scopes: ['workflows:read'],
    });
  });

  it('refuses a credential-less caller instead of running it as the local user', async () => {
    engine = createEngine();
    server = serve({
      engine,
      port: 0,
      publicOrigin: 'http://localhost',
      auth: { apiKeys: [API_KEY], defaultApiKeyScopes: ['workflows:read'] },
    });

    const principal = await fetch(`${server.url}/v1/principal`);
    const workflowList = await fetch(`${server.url}/v1/workflows`);
    expect(principal.status).toBe(401);
    expect(workflowList.status).toBe(401);
  });

  it('refuses a key to an operation whose scope it does not hold', async () => {
    engine = createEngine();
    server = serve({
      engine,
      port: 0,
      publicOrigin: 'http://localhost',
      auth: { apiKeys: [API_KEY], defaultApiKeyScopes: ['workflows:read'] },
    });

    const response = await fetch(`${server.url}/v1/recover`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY },
    });
    expect(response.status).toBe(403);
  });
});

describe('serve() with static API keys', () => {
  let engine: Engine | undefined;
  let server: WeftServer | undefined;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
    server = undefined;
    engine = undefined;
  });

  function expectRefusal(auth: AuthConfig): void {
    const refusingEngine = createEngine();
    engine = refusingEngine;
    expect(() => serve({ engine: refusingEngine, port: 0, auth })).toThrow(
      /defaultApiKeyScopes.*resolveApiKeyPrincipal/s,
    );
  }

  it('throws before binding when neither default scopes nor a resolver is configured', () => {
    expectRefusal({ apiKeys: [API_KEY] });
  });

  it('throws when the default scopes are empty', () => {
    expectRefusal({ apiKeys: [API_KEY], defaultApiKeyScopes: [] });
  });

  it('throws when every default scope is one the server does not recognize', () => {
    // A package scope is granted only when the server registers it, so an
    // unregistered one grants nothing and the key would be refused everywhere.
    expectRefusal({ apiKeys: [API_KEY], defaultApiKeyScopes: ['bureau.tasks:read'] });
  });

  it('starts with non-empty default scopes', () => {
    engine = createEngine();
    server = serve({
      engine,
      port: 0,
      publicOrigin: 'http://localhost',
      auth: { apiKeys: [API_KEY], defaultApiKeyScopes: ['workflows:read'] },
    });
    expect(server.port).toBeGreaterThan(0);
  });

  it('starts with a registered package scope as the only default scope', () => {
    engine = createEngine();
    server = serve({
      engine,
      port: 0,
      publicOrigin: 'http://localhost',
      additionalScopes: ['bureau.tasks:read'],
      auth: { apiKeys: [API_KEY], defaultApiKeyScopes: ['bureau.tasks:read'] },
    });
    expect(server.port).toBeGreaterThan(0);
  });

  it('starts with a resolver in place of default scopes', () => {
    engine = createEngine();
    server = serve({
      engine,
      port: 0,
      publicOrigin: 'http://localhost',
      auth: { apiKeys: [API_KEY], resolveApiKeyPrincipal: async () => null },
    });
    expect(server.port).toBeGreaterThan(0);
  });

  it('does not constrain a server that authenticates by JWT alone', () => {
    engine = createEngine();
    server = serve({
      engine,
      port: 0,
      publicOrigin: 'http://localhost',
      auth: { jwt: { secret: 'jwt-only-server-secret-1234567890' } },
    });
    expect(server.port).toBeGreaterThan(0);
  });
});

describe('MCP sessions on a serve() with no authentication', () => {
  let engine: Engine | undefined;
  let server: WeftServer | undefined;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
    server = undefined;
    engine = undefined;
  });

  const mcpHeaders = (sessionId: string, token?: string): Record<string, string> => ({
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'Mcp-Session-Id': sessionId,
    'Mcp-Protocol-Version': MCP_PROTOCOL_VERSION,
    ...(token === undefined ? {} : { 'Mcp-Session-Token': token }),
  });

  it('requires the continuation token, because every request is the same local user', async () => {
    const warningSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      engine = createEngine();
      server = serve({ engine, port: 0, hostname: '127.0.0.1' });
    } finally {
      warningSpy.mockRestore();
    }

    const initialize = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'probe', version: '1' },
        },
      }),
    });
    const sessionId = initialize.headers.get('Mcp-Session-Id') ?? '';
    const token = initialize.headers.get('Mcp-Session-Token') ?? '';
    expect(initialize.status).toBe(200);
    expect(sessionId).not.toBe('');
    expect(token).not.toBe('');

    const listTools = (sessionToken?: string): Promise<Response> =>
      fetch(`${server?.url}/mcp`, {
        method: 'POST',
        headers: mcpHeaders(sessionId, sessionToken),
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });

    // A second caller that knows only the session id cannot continue or end it.
    const hijacked = await listTools();
    const terminated = await fetch(`${server.url}/mcp`, {
      method: 'DELETE',
      headers: { 'Mcp-Session-Id': sessionId, 'Mcp-Protocol-Version': MCP_PROTOCOL_VERSION },
    });
    expect(hijacked.status).toBe(403);
    expect(terminated.status).toBe(403);

    // The caller that holds the token is admitted.
    const admitted = await listTools(token);
    expect(admitted.status).toBe(200);
  });
});

describe('MCP sessions on a serve() with static API keys', () => {
  let engine: Engine | undefined;
  let server: WeftServer | undefined;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
    server = undefined;
    engine = undefined;
  });

  const KEY_A = 'static-key-a-for-mcp';
  const KEY_B = 'static-key-b-for-mcp';

  it('binds the session to the key that created it: key A continues without a token, key B is refused', async () => {
    const warningSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      engine = createEngine();
      server = serve({
        engine,
        port: 0,
        hostname: '127.0.0.1',
        publicOrigin: 'http://localhost',
        auth: { apiKeys: [KEY_A, KEY_B], defaultApiKeyScopes: ['workflows:read'] },
      });
    } finally {
      warningSpy.mockRestore();
    }

    const initialize = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'X-API-Key': KEY_A,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'a', version: '1' },
        },
      }),
    });
    const sessionId = initialize.headers.get('Mcp-Session-Id') ?? '';
    const token = initialize.headers.get('Mcp-Session-Token') ?? '';
    expect(initialize.status).toBe(200);
    expect(token).not.toBe('');

    const continuation = (key: string, sessionToken?: string): Promise<Response> =>
      fetch(`${server?.url}/mcp`, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'Mcp-Session-Id': sessionId,
          'Mcp-Protocol-Version': MCP_PROTOCOL_VERSION,
          'X-API-Key': key,
          ...(sessionToken === undefined ? {} : { 'Mcp-Session-Token': sessionToken }),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });

    // Key B holds only the session id: refused, on continuation and on DELETE.
    // Every static key is the same `api-key-caller`, so the principal alone
    // cannot tell A from B; the digest of the key the session was bound to can.
    const hijacked = await continuation(KEY_B);
    const terminated = await fetch(`${server.url}/mcp`, {
      method: 'DELETE',
      headers: {
        'Mcp-Session-Id': sessionId,
        'Mcp-Protocol-Version': MCP_PROTOCOL_VERSION,
        'X-API-Key': KEY_B,
      },
    });
    expect(hijacked.status).toBe(403);
    expect(terminated.status).toBe(403);

    // Key A is admitted with no custom token, as a standard MCP client sends it.
    const admittedByKey = await continuation(KEY_A);
    expect(admittedByKey.status).toBe(200);

    // The token still admits, whichever key presents it.
    const admittedByToken = await continuation(KEY_B, token);
    expect(admittedByToken.status).toBe(200);
  });
});
