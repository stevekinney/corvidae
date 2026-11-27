import { openBindingBungalow, resolveWorkerBungalowDescriptor } from './index.ts';

type WorkerEnvironment = Record<string, unknown>;

export default {
  async fetch(request: Request, env: WorkerEnvironment): Promise<Response> {
    const url = new URL(request.url);
    const descriptor = resolveWorkerBungalowDescriptor({
      name: 'bungalow-test',
      env: { ...env, BUNGALOW_TEST_SECRET_API_KEY: 'worker-secret' },
    });
    if (url.pathname === '/foreign') {
      await descriptor.bucket.put('foreign/object', new TextEncoder().encode('foreign'), {
        onlyIf: new Headers({ 'if-none-match': '*' }),
      });
      const foreign = { ...descriptor, prefix: 'foreign/' };
      try {
        await openBindingBungalow({
          name: 'bungalow-test',
          descriptor: foreign,
          databaseWorkspaceClaim: async () => {},
        });
      } catch (error) {
        return new Response(error instanceof Error ? error.message : 'failed', { status: 409 });
      }
      return new Response('opened foreign state', { status: 500 });
    }
    using home = await openBindingBungalow({
      name: 'bungalow-test',
      descriptor,
      databaseWorkspaceClaim: async () => {},
      writableConfiguration: true,
    });
    const snapshot = await home.readConfiguration();
    const write = await home.writeConfiguration(
      '{"worker":true}',
      url.pathname === '/reopen'
        ? { expectedRevision: null }
        : { expectedRevision: snapshot.revision },
    );
    return Response.json({
      deploymentId: home.deploymentId,
      workspaceId: home.workspaceId,
      secret: await home.deploymentSecrets.read('api-key'),
      write,
    });
  },
};
