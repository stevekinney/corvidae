import type { S3TestServer } from '@lostgradient/testing/s3-server';
import { afterEach } from 'bun:test';

/** One request the proxy received: its method and the object key it addressed. */
export type ProxiedRequest = { readonly method: string; readonly key: string };

/**
 * Decide what one request gets: a `Response` answers it without reaching the S3 test server, and
 * `undefined` forwards it. The hook may also change the server's bucket before it forwards, which
 * is how a test puts another writer's object in place between Bungalow's read and its write.
 */
export type S3Interception = (
  request: ProxiedRequest,
) => Response | undefined | Promise<Response | undefined>;

/** A loopback proxy in front of an S3 test server that records and can intercept each request. */
export type S3Proxy = {
  /** `http://127.0.0.1:<port>`, to pass as `S3_ENDPOINT`. */
  readonly endpoint: string;
  /** Every request in the order it arrived, intercepted or not. */
  readonly requests: readonly ProxiedRequest[];
  /** Replace the interception hook; `undefined` forwards everything. */
  intercept(hook: S3Interception | undefined): void;
};

/** The key a path-style request addresses: `/bucket/a/b` addresses `a/b`. */
function keyOf(url: URL): string {
  return decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
}

/**
 * Start a proxy in front of `upstream`, stopped after the calling test. The S3 test server never
 * fails a request on its own, so a test that needs a 500, a lost conditional write, or an object
 * that vanishes between two requests describes it here and lets everything else reach the server.
 */
export function useS3Proxy(): (upstream: S3TestServer) => S3Proxy {
  const servers: ReturnType<typeof Bun.serve>[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.stop(true);
  });
  return (upstream) => {
    const requests: ProxiedRequest[] = [];
    let hook: S3Interception | undefined;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const proxied = { method: request.method, key: keyOf(url) };
        requests.push(proxied);
        const answer = await hook?.(proxied);
        if (answer !== undefined) return answer;
        const headers = new Headers(request.headers);
        headers.delete('host');
        const forwarded: RequestInit = { method: request.method, headers };
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          forwarded.body = await request.arrayBuffer();
        }
        return fetch(`${upstream.endpoint}${url.pathname}${url.search}`, forwarded);
      },
    });
    servers.push(server);
    return {
      endpoint: `http://127.0.0.1:${server.port}`,
      requests,
      intercept(next) {
        hook = next;
      },
    };
  };
}
