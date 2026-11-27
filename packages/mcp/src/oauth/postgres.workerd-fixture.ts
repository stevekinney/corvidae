import { createPostgresOAuthStores } from './postgres.ts';

type Environment = {
  HYPERDRIVE: { connectionString: string };
};

export default {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    await using store = createPostgresOAuthStores({
      url: environment.HYPERDRIVE.connectionString,
      table: 'workerd_oauth_clients',
    });
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/client') {
      return Response.json(await store.registerClient(await request.json()), { status: 201 });
    }
    if (request.method === 'GET' && url.pathname === '/client')
      return Response.json(await store.getClient(url.searchParams.get('id') ?? ''));
    return new Response('Not found', { status: 404 });
  },
};
