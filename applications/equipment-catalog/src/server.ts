import { mountCatalog } from '@lostgradient/backchannel-mcp/velveteen';
import { buildProduction } from '@lostgradient/velveteen/build';
import { readProductionGeneration } from '@lostgradient/velveteen/build/publication';
import { createApplication } from '@lostgradient/velveteen/server';
import { join } from 'node:path';
import { createFixture } from './fixture.ts';

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
  const fixture = createFixture('/api/mcp');
  const generation = await readProductionGeneration(outputDirectory);
  const mounts = mountCatalog({
    basePath: '/api',
    publicOrigin: fixture.origin,
    operations: fixture.operations,
    host: {},
    authenticateApi: async () => new Response(null, { status: 401 }),
    mcp: {
      serverInfo: { name: 'equipment-catalog', version: '1' },
      authorization: {
        issuer: fixture.origin,
        verifyAccessToken: fixture.oauth.verifyAccessToken,
        resolvePrincipal: fixture.resolvePrincipal,
        handle: fixture.oauth.handle,
      },
    },
  });
  const application = await createApplication({ generation, mounts });
  const server = Bun.serve({
    hostname: '0.0.0.0',
    port: Number(process.env['PORT'] ?? '3000'),
    fetch: (request) =>
      new URL(request.url).pathname.startsWith('/auth/')
        ? fixture.browser.fetch(request)
        : application.fetch(request),
  });
  const shutdown = async () => {
    await server.stop();
    await application.dispose();
    fixture.storage[Symbol.dispose]();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
