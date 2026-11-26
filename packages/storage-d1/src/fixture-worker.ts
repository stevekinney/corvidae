import { OAuthStore } from '@lostgradient/mcp/oauth';
import { D1Storage, migrate, type D1Database } from './index.ts';

type Environment = { DB: D1Database };

const encoder = new TextEncoder();
const decode = (value: Uint8Array | null) =>
  value === null ? null : new TextDecoder().decode(value);

export default {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    await migrate(environment.DB);
    const storage = new D1Storage(environment.DB);
    const path = new URL(request.url).pathname;
    if (path === '/conditional/success') {
      const applied = await storage.conditionalBatch(
        [{ key: 'version', expectedValue: null }],
        [{ type: 'put', key: 'version', value: encoder.encode('one') }],
      );
      return Response.json({ applied, value: decode(await storage.get('version')) });
    }
    if (path === '/conditional/failure') {
      const applied = await storage.conditionalBatch(
        [{ key: 'version', expectedValue: encoder.encode('stale') }],
        [
          { type: 'put', key: 'version', value: encoder.encode('two') },
          { type: 'put', key: 'created', value: encoder.encode('created') },
        ],
      );
      return Response.json({
        applied,
        version: decode(await storage.get('version')),
        created: decode(await storage.get('created')),
      });
    }
    if (path === '/oauth') {
      const store = new OAuthStore(storage);
      const registered = await store.registerClient({
        issuer: 'https://issuer.test',
        clientId: 'fixture-client',
        name: 'Fixture client',
        redirectUris: ['https://client.test/callback'],
        grantTypes: ['authorization_code'],
        authentication: 'none',
        secretHash: null,
        secretExpiresAt: null,
      });
      const client = await store.getClient('fixture-client');
      return Response.json({ registered, client });
    }
    return new Response('not found', { status: 404 });
  },
};
