import { auth } from '@modelcontextprotocol/client';
import {
  completeMcpOAuthAuthorization,
  connectMcpClientWithOAuth,
  createInMemoryMcpOAuthTokenStorage,
  createMcpOAuthProvider,
} from 'armorer';
import { createInterface } from 'node:readline/promises';

const resource = new URL(process.argv[2] ?? '');
if (resource.protocol !== 'https:' || resource.search || resource.hash)
  throw new Error('Expected an HTTPS MCP resource URL');

for (const role of ['reader', 'editor'] as const) {
  const storage = createInMemoryMcpOAuthTokenStorage();
  const callback = Promise.withResolvers<string>();
  let authorization: URL | undefined;
  const listener = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/start' && authorization) return Response.redirect(authorization);
      if (url.pathname === '/callback') {
        callback.resolve(url.href);
        return new Response('Sign-in received. Return to the terminal.');
      }
      return new Response(null, { status: 404 });
    },
  });
  const redirectUrl = new URL('/callback', listener.url).href;
  const provider = createMcpOAuthProvider({
    redirectUrl,
    clientMetadata: {
      client_name: `Equipment staging ${role} probe`,
      redirect_uris: [redirectUrl],
      application_type: 'native',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: role === 'editor' ? 'equipment:read equipment:write' : 'equipment:read',
    },
    tokenStorage: storage,
    onAuthorizationRequired(url) {
      authorization = url;
    },
  });
  try {
    const scope = role === 'editor' ? 'equipment:read equipment:write' : 'equipment:read';
    if ((await auth(provider, { serverUrl: resource, scope })) !== 'REDIRECT' || !authorization)
      throw new Error('Expected authorization');
    console.log(
      `Open a separate private browser window and sign in as the synthetic ${role}: ${new URL('/start', listener.url).href}\nBefore approving, compare the subject shown on the consent page with the ${role} subject in the approved credential manager.`,
    );
    const callbackUrl = await callback.promise;
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await terminal.question(
        `Did the consent subject match the ${role} record? Type yes: `,
      );
      if (answer.trim().toLowerCase() !== 'yes') throw new Error('Identity was not confirmed');
    } finally {
      terminal.close();
    }
    await completeMcpOAuthAuthorization(provider, {
      serverUrl: resource,
      callbackUrl,
      tokenStorage: storage,
    });
    let renameStatus: number | undefined;
    const client = await connectMcpClientWithOAuth({
      serverUrl: resource,
      provider,
      transportOptions: {
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (typeof init?.body === 'string' && init.body.includes('equipment.rename'))
            renameStatus = response.status;
          return response;
        },
      },
    });
    try {
      const lookup = async () => {
        const result = await client.callTool({
          name: 'equipment.lookup',
          arguments: { assetId: 'CAM-7' },
        });
        if (result.isError) throw new Error('Lookup denied');
        const name = (result.structuredContent as { name?: unknown } | undefined)?.name;
        if (typeof name !== 'string') throw new Error('Lookup did not return a name');
        return name;
      };
      const before = await lookup();
      const next = `Probe ${crypto.randomUUID()}`;
      let denied = false;
      try {
        try {
          const result = await client.callTool({
            name: 'equipment.rename',
            arguments: { assetId: 'CAM-7', name: next },
          });
          denied =
            result.isError === true &&
            (result.structuredContent as { code?: unknown } | undefined)?.code === 'Forbidden';
        } catch (error) {
          if (renameStatus !== 403) throw error;
          denied = true;
        }
        const after = await lookup();
        if (role === 'reader' ? !denied || after !== before : denied || after !== next)
          throw new Error(`${role} authorization assertion failed`);
      } finally {
        if (role === 'editor') {
          const restored = await client.callTool({
            name: 'equipment.rename',
            arguments: { assetId: 'CAM-7', name: before },
          });
          if (restored.isError || (await lookup()) !== before)
            throw new Error('Could not restore the original equipment name');
        }
      }
      console.log(
        JSON.stringify({
          resource: resource.href,
          role,
          identity: 'operator-confirmed',
          lookup: 'passed',
          rename: role === 'reader' ? 'refused' : 'passed',
          readAfter: 'passed',
          ...(role === 'editor' ? { restored: 'passed' } : {}),
        }),
      );
    } finally {
      await client.close();
    }
  } finally {
    await listener.stop(true);
  }
}
