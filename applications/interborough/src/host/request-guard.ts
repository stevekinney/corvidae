/**
 * The guard in front of every route on the public listener.
 *
 * The host answers every request as the one local caller holding every scope, so the only thing
 * between a web page and that caller is what the browser will let the page send. `createBureauHandler`
 * leaves this to the host that binds the port, and these two checks are it:
 *
 * - **Host.** A request must name this listener: `127.0.0.1:<port>` or `localhost:<port>`, with the
 *   port left out only on port 80. A page
 *   on `attacker.example` whose DNS name has been rebound to `127.0.0.1` still sends
 *   `Host: attacker.example`, and is refused.
 * - **Origin.** A browser attaches `Origin` to a cross-site form post, a `fetch`, and a WebSocket
 *   handshake. When one is present it must be this listener's own origin. A request without one
 *   (a navigation, a command-line client) is not a cross-site request.
 *
 * Both refusals answer 403.
 *
 * One exception, for A2A beyond loopback (COR-1904): a guard given a public origin, which the
 * host builds only for `/bureau/*` and only when an A2A key is configured, also accepts that
 * origin's `Host`, with no `Origin` or that origin's own, for a path under `/bureau/a2a/` once its
 * dot segments are resolved. Every other path refuses that `Host`, and the Bureau then requires
 * the key on every A2A JSON-RPC call.
 *
 * @module request-guard
 */

/** The port a client leaves out of `Host` and `Origin` for plain HTTP. */
const DEFAULT_HTTP_PORT = 80;

/**
 * Every `Host` this listener answers to, for the port it ended up on. A client omits the default
 * port, so a listener on port 80 also answers to the bare names, and only a listener on port 80:
 * on any other port a bare name means port 80 and is somewhere else.
 */
export function allowedHosts(port: number): readonly string[] {
  const names = ['127.0.0.1', 'localhost'];
  return [...names.map((name) => `${name}:${port}`), ...(port === DEFAULT_HTTP_PORT ? names : [])];
}

/** The paths a public origin reaches: the A2A interfaces and their cards. */
export const PUBLIC_A2A_PATH_PREFIX = '/bureau/a2a/';

/**
 * Whether `request` names the public origin and an A2A path. The path is the parsed URL's, with
 * `..` and `%2e%2e` resolved, which is the path the Bureau handler is given; the raw request target
 * is not, so `/bureau/a2a/../jsonrpc` is `/bureau/jsonrpc` here.
 */
function isPublicA2aRequest(request: Request, host: string, publicOrigin: URL): boolean {
  return (
    host.toLowerCase() === publicOrigin.host &&
    new URL(request.url).pathname.startsWith(PUBLIC_A2A_PATH_PREFIX)
  );
}

/**
 * A guard for the listener on `port()`. It returns the refusal to send, or `undefined` for a
 * request that may proceed. The port is read per request, because the listener is started before
 * its port is known when the caller asks for a free one. With `publicOrigin`, the guard also
 * accepts that origin for A2A paths, as the module comment describes.
 */
export function createRequestGuard(
  port: () => number,
  publicOrigin?: URL,
): (request: Request) => Response | undefined {
  return (request) => {
    const requestHost = request.headers.get('host');
    if (
      publicOrigin !== undefined &&
      requestHost !== null &&
      isPublicA2aRequest(request, requestHost, publicOrigin)
    ) {
      const origin = request.headers.get('origin');
      if (origin === null || origin.toLowerCase() === publicOrigin.origin) return undefined;
      return new Response('Forbidden: cross-origin requests are not accepted.', { status: 403 });
    }
    const hosts = allowedHosts(port());
    if (requestHost === null || !hosts.includes(requestHost.toLowerCase())) {
      return new Response('Forbidden: this host answers only to its own address.', { status: 403 });
    }
    const origin = request.headers.get('origin');
    if (origin !== null && !hosts.some((allowed) => origin.toLowerCase() === `http://${allowed}`)) {
      return new Response('Forbidden: cross-origin requests are not accepted.', { status: 403 });
    }
    return undefined;
  };
}
