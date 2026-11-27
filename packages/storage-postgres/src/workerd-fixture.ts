import { PostgresStorage } from './postgres.ts';

type Environment = {
  HYPERDRIVE: { connectionString: string };
};

type RequestBody = {
  key?: string;
  prefix?: string;
  value?: string;
  operations?: ({ type: 'put'; key: string; value: string } | { type: 'delete'; key: string })[];
  conditions?: { key: string; expectedValue: string | null }[];
  options?: {
    limit?: number;
    reverse?: boolean;
    gt?: string;
    lt?: string;
    gte?: string;
    lte?: string;
  };
};

const table = 'workerd_postgres_contract';

function encode(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value));
}

function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

export default {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    const body = (await request.json()) as RequestBody;
    const path = new URL(request.url).pathname;
    if (path === '/scan') return scanResponse(body, environment);
    await using store = new PostgresStorage({
      url: environment.HYPERDRIVE.connectionString,
      table,
    });
    switch (path) {
      case '/capabilities':
        return Response.json(store.capabilities());
      case '/reset':
        await store.deletePrefix('');
        return Response.json(null);
      case '/get': {
        const value = await store.get(body.key!);
        return Response.json(value === null ? null : encode(value));
      }
      case '/put':
        await store.put(body.key!, decode(body.value!));
        return Response.json(null);
      case '/delete':
        await store.delete(body.key!);
        return Response.json(null);
      case '/batch':
        await store.batch(
          body.operations!.map((operation) =>
            operation.type === 'put' ? { ...operation, value: decode(operation.value) } : operation,
          ),
        );
        return Response.json(null);
      case '/conditional-batch':
        return Response.json(
          await store.conditionalBatch(
            body.conditions!.map((condition) => ({
              ...condition,
              expectedValue:
                condition.expectedValue === null ? null : decode(condition.expectedValue),
            })),
            body.operations!.map((operation) =>
              operation.type === 'put'
                ? { ...operation, value: decode(operation.value) }
                : operation,
            ),
          ),
        );
      default:
        return new Response('Not found', { status: 404 });
    }
  },
};

function scanResponse(body: RequestBody, environment: Environment): Response {
  const transform = new TransformStream<Uint8Array, Uint8Array>();
  const writer = transform.writable.getWriter();
  void (async () => {
    try {
      await using store = new PostgresStorage({
        url: environment.HYPERDRIVE.connectionString,
        table,
      });
      for await (const [key, value] of store.scan(body.prefix!, body.options)) {
        await writer.write(new TextEncoder().encode(`${JSON.stringify([key, encode(value)])}\n`));
      }
      await writer.close();
    } catch (error) {
      try {
        await writer.abort(error);
      } catch {
        // Reader cancellation already closes the writable side.
      }
    }
  })();
  return new Response(transform.readable, { headers: { 'content-type': 'application/x-ndjson' } });
}
