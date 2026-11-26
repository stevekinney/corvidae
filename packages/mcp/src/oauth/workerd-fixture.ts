import { MemoryStorage } from '@lostgradient/storage';

import { OAuthStore } from '../oauth-store.ts';
import { hostedOAuth } from './issuer.ts';

let lookupCalls = 0;

const issuer = hostedOAuth({
  issuer: 'https://issuer.test',
  resource: 'https://issuer.test/protected',
  scopes: ['read'],
  startingScopes: ['read'],
  scopeDescriptions: { read: 'Read access' },
  store: new OAuthStore(new MemoryStorage()),
  clientMetadataDocumentFetch: {
    fetchImpl: async () =>
      Response.json({
        client_id: 'https://upstream.test/metadata',
        client_name: 'Metadata client',
        redirect_uris: ['https://issuer.test/callback'],
        token_endpoint_auth_method: 'none',
      }),
    lookupImpl: async () => {
      lookupCalls += 1;
      return [{ address: '93.184.216.34', family: 4 }];
    },
  },
  identity: {
    session: async () => ({
      subject: 'workerd-user',
      tenant: 'workerd-tenant',
      binding: 'session',
    }),
    signIn: async () => new Response(null, { status: 401 }),
    principalForGrant: async () => ({ delegableScopes: ['read'] }),
  },
});

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/protected') {
      const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
      return token && (await issuer.verifyAccessToken(token))
        ? new Response('protected')
        : new Response(null, { status: 401 });
    }
    if (url.pathname === '/dns-lookup-calls') return Response.json({ lookupCalls });
    return issuer.handle(request);
  },
};
