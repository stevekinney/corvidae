import { createFixture } from '@lostgradient/equipment-fixture';
import { readEquipmentEnvironment } from '@lostgradient/equipment-fixture/environment-configuration';
import { createToolboxMcpHandler } from 'armorer/mcp/http';

const configuration = readEquipmentEnvironment();
const fixture = createFixture('/mcp', configuration);
const handler = await createToolboxMcpHandler(fixture.toolbox, {
  tools: [
    { id: fixture.lookup.id, name: 'equipment.lookup', scopes: ['equipment:read'] },
    { id: fixture.rename.id, name: 'equipment.rename', scopes: ['equipment:write'] },
  ],
  authorization: {
    origin: fixture.origin,
    resourcePath: '/mcp',
    issuer: fixture.origin,
    scopes: ['equipment:read', 'equipment:write'],
    verifyAccessToken: fixture.oauth.verifyAccessToken,
    resolvePrincipal: fixture.resolvePrincipal,
  },
  requestContext: (_principal, grant) => fixture.requestContext(grant.subject),
});
const server = Bun.serve({
  hostname: '0.0.0.0',
  port: configuration.port,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/auth/')) return fixture.browser.fetch(request);
    if (path === '/mcp' || path.startsWith('/.well-known/oauth-protected-resource'))
      return handler.fetch(request);
    return fixture.oauth.handle(request);
  },
});
const shutdown = async () => {
  await server.stop();
  await handler.close();
  fixture.storage[Symbol.dispose]();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
