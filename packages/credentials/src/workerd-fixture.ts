import { MemoryStorage } from '@lostgradient/storage';
import { createApiKeys } from './api-keys.ts';
import { createBrowserSignIn, oidc } from './browser-sign-in.ts';

const storage = new MemoryStorage();
const authority = { workspaceId: 'workspace', subject: 'person', scopes: ['assets:read'] };
const apiKeys = createApiKeys({
  storage,
  resolveAuthority: async () => authority,
  authorizeManagement: async () => true,
});
const browser = createBrowserSignIn({
  publicOrigin: 'https://credentials.test',
  storage,
  workspaceId: authority.workspaceId,
  cookieName: 'credentials_session',
  provider: oidc({
    issuer: 'https://identity.test',
    clientId: 'credentials',
    clientSecret: 'secret',
    fetch: (url, options) =>
      fetch(url, { ...options, body: (options.body ?? null) as BodyInit | null }),
  }),
  resolveAccount: async () => authority.subject,
  resolveMembership: async ({ workspaceId }) =>
    workspaceId === authority.workspaceId ? { workspaceId } : null,
});

const json = (value: unknown, status = 200) => Response.json(value, { status });

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/auth/')) {
      const publicRequest = new Request(
        `https://credentials.test${url.pathname}${url.search}`,
        request,
      );
      return browser.fetch(publicRequest);
    }
    if (url.pathname === '/keys/issue' && request.method === 'POST') {
      const issued = await apiKeys.issue('manager', {
        label: 'Worker proof',
        workspaceId: authority.workspaceId,
        subject: authority.subject,
        scopes: authority.scopes,
      });
      return json(issued);
    }
    if (url.pathname === '/keys/revoke' && request.method === 'POST') {
      const id = url.searchParams.get('id');
      if (!id) return new Response('Missing id', { status: 400 });
      await apiKeys.revoke('manager', { ...authority, id });
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/protected') {
      const verified = await apiKeys.verify(request.headers.get('x-api-key') ?? '');
      if (verified) return json(verified);
      const session = await browser.currentSession(request);
      return session ? json(session) : new Response('Unauthorized', { status: 401 });
    }
    return new Response('Not Found', { status: 404 });
  },
};
