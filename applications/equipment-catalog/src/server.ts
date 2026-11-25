import { principalFromApiKey } from '@lostgradient/backchannel';
import { operationsFromToolbox } from '@lostgradient/backchannel-armorer';
import { mountCatalog } from '@lostgradient/backchannel-mcp/velveteen';
import { createFixture, publicRequest } from '@lostgradient/equipment-fixture';
import { readEquipmentEnvironment } from '@lostgradient/equipment-fixture/environment-configuration';
import { buildProduction } from '@lostgradient/velveteen/build';
import { readProductionGeneration } from '@lostgradient/velveteen/build/publication';
import { createApplication } from '@lostgradient/velveteen/server';
import { join } from 'node:path';
import { z } from 'zod';

const root = import.meta.dir + '/..';
const outputDirectory = join(root, '.velveteen/production');
if (process.argv.includes('--build')) {
  await buildProduction({
    projectDirectory: root,
    routesDirectory: join(root, 'src/routes'),
    outputDirectory,
    mode: 'production',
  });
} else {
  const configuration = readEquipmentEnvironment();
  const fixture = createFixture('/api/mcp', configuration);
  const output = z.object({ assetId: z.literal('CAM-7'), name: z.string() });
  const operations = operationsFromToolbox(
    fixture.toolbox,
    [
      {
        tool: fixture.lookup.id,
        name: 'equipment.lookup',
        scopes: ['equipment:read'],
        outputSchema: output,
        mcpExposable: true,
        behavior: { kind: 'read', key: ['assetId'] },
      },
      {
        tool: fixture.rename.id,
        name: 'equipment.rename',
        scopes: ['equipment:write'],
        outputSchema: output,
        mcpExposable: true,
        behavior: { kind: 'command', invalidates: ['equipment.lookup'] },
      },
    ],
    {
      requestContext: (principal) => {
        if (!('subject' in principal) || !principal.subject)
          throw new Error('Missing fixture subject');
        return fixture.requestContext(principal.subject);
      },
    },
  );
  const generation = await readProductionGeneration(outputDirectory);
  const mounts = mountCatalog({
    basePath: '/api',
    publicOrigin: fixture.origin,
    operations,
    host: {},
    authenticateApi: async () => new Response(null, { status: 401 }),
    mcp: {
      serverInfo: { name: 'equipment-catalog', version: '1' },
      authorization: {
        issuer: fixture.origin,
        verifyAccessToken: fixture.oauth.verifyAccessToken,
        resolvePrincipal: async (grant) => {
          const authority = await fixture.resolvePrincipal(grant);
          return (
            authority && {
              ...authority,
              principal: principalFromApiKey({
                subject: grant.subject,
                scopes: authority.delegableScopes,
              }),
            }
          );
        },
        handle: fixture.oauth.handle,
      },
    },
  });
  const application = await createApplication({ generation, mounts });
  const server = Bun.serve({
    hostname: '0.0.0.0',
    port: configuration.port,
    fetch: (incoming) => {
      const request = publicRequest(incoming, fixture.origin);
      if (request instanceof Response) return request;
      return new URL(request.url).pathname.startsWith('/auth/')
        ? fixture.browser.fetch(request)
        : application.fetch(request);
    },
  });
  const shutdown = async () => {
    await server.stop();
    await application.dispose();
    fixture.storage[Symbol.dispose]();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
