import { AsyncLocalStorage } from 'node:async_hooks';

type DurableObjectState = {
  storage: {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
  };
};

type Environment = {
  ASSETS: { fetch(request: Request): Promise<Response> };
  COUNTER: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
  DB: {
    prepare(query: string): {
      bind(...values: unknown[]): { run(): Promise<unknown>; first<T>(): Promise<T | null> };
      run(): Promise<unknown>;
      first<T>(): Promise<T | null>;
    };
  };
  BUCKET: {
    put(key: string, value: string): Promise<unknown>;
    get(key: string): Promise<{ text(): Promise<string> } | null>;
  };
};

const context = new AsyncLocalStorage<string>();

export class Counter {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(): Promise<Response> {
    const count = Number((await this.state.storage.get('count')) ?? 0) + 1;
    await this.state.storage.put('count', count);
    return new Response(String(count));
  }
}

export default {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/durable') {
      return environment.COUNTER.get(environment.COUNTER.idFromName('fixture')).fetch(request);
    }
    if (url.pathname === '/d1') {
      await environment.DB.prepare('create table if not exists fixture (value text)').run();
      await environment.DB.prepare('insert into fixture (value) values (?)').bind('stored').run();
      const row = await environment.DB.prepare('select value from fixture limit 1').first<{
        value: string;
      }>();
      return new Response(row?.value);
    }
    if (url.pathname === '/r2') {
      await environment.BUCKET.put('fixture', 'stored');
      const object = await environment.BUCKET.get('fixture');
      return new Response(await object?.text());
    }
    if (url.pathname === '/async-local-storage') {
      return context.run('carried', async () => {
        await Promise.resolve();
        return new Response(context.getStore());
      });
    }
    if (url.pathname === '/outbound') return fetch('https://upstream.test/fixture');
    if (url.pathname === '/asset')
      return environment.ASSETS.fetch(new Request('https://assets.test/fixture.txt'));
    return new Response('round trip');
  },
};
