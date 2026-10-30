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
 * origin's `Host` (with or without its scheme's default port, as a proxy may send either), with
 * no `Origin` or that origin's own, for a path under `/bureau/a2a/` or `/bureau/assets/` once its
 * dot segments are resolved. An asset request must also carry a credential (`X-API-Key` or
 * `Authorization`), or it is answered 401 here: the Bureau would serve a request without one as
 * the local owner. Every other path refuses that `Host`; the Bureau then requires the key on every
 * A2A JSON-RPC call and checks it, and the asset's owner and scope, on every asset read.
 *
 * The guard reads `Host`, so the reverse proxy in front of a public origin must forward it. One
 * that rewrites it to `127.0.0.1:<port>` makes every request it forwards look local, and so
 * exposes every route as the owner; nothing here can tell the difference.
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

/** The asset routes a public origin reaches, with a credential: the media A2A tasks name. */
export const PUBLIC_ASSETS_PATH_PREFIX = '/bureau/assets/';

/** The port a client may name in `Host` for an origin that leaves it out. */
const DEFAULT_PORTS: Readonly<Record<string, string>> = { 'https:': '443', 'http:': '80' };

/**
 * The `Host` values that name `publicOrigin`: its own, and, when it uses its scheme's default
 * port, the same name with that port written out. No other port.
 */
function publicHosts(publicOrigin: URL): readonly string[] {
  const defaultPort = Object.hasOwn(DEFAULT_PORTS, publicOrigin.protocol)
    ? DEFAULT_PORTS[publicOrigin.protocol]
    : undefined;
  return publicOrigin.port === '' && defaultPort !== undefined
    ? [publicOrigin.host, `${publicOrigin.hostname}:${defaultPort}`]
    : [publicOrigin.host];
}

/** Whether the request presents a credential, as the Bureau handler decides it. */
function presentsCredential(request: Request): boolean {
  return request.headers.has('x-api-key') || request.headers.has('authorization');
}

/**
 * Which public path `request` names, if any. The path is the parsed URL's, with `..` and `%2e%2e`
 * resolved, which is the path the Bureau handler is given; the raw request target is not, so
 * `/bureau/a2a/../jsonrpc` is `/bureau/jsonrpc` here.
 */
function publicPathOf(request: Request): 'a2a' | 'assets' | undefined {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith(PUBLIC_A2A_PATH_PREFIX)) return 'a2a';
  if (pathname.startsWith(PUBLIC_ASSETS_PATH_PREFIX)) return 'assets';
  return undefined;
}

/**
 * The guard's answer to a request naming the public origin and one of its paths, or `null` for
 * any other request, which the loopback check answers.
 */
function publicOriginAnswer(
  request: Request,
  requestHost: string,
  publicOrigin: URL,
  hosts: readonly string[],
): Response | undefined | null {
  if (!hosts.includes(requestHost.toLowerCase())) return null;
  const path = publicPathOf(request);
  // Any other path is the loopback check's, which refuses a `Host` that is not this listener's.
  if (path === undefined) return null;
  const origin = request.headers.get('origin');
  if (origin !== null && origin.toLowerCase() !== publicOrigin.origin) {
    return new Response('Forbidden: cross-origin requests are not accepted.', { status: 403 });
  }
  if (path === 'assets' && !presentsCredential(request)) {
    return new Response('Unauthorized: an asset needs the A2A key.', {
      status: 401,
      headers: { 'www-authenticate': 'Bearer' },
    });
  }
  return undefined;
}

/**
 * A guard for the listener on `port()`. It returns the refusal to send, or `undefined` for a
 * request that may proceed. The port is read per request, because the listener is started before
 * its port is known when the caller asks for a free one. With `publicOrigin`, the guard also
 * accepts that origin for A2A and asset paths, as the module comment describes.
 */
export function createRequestGuard(
  port: () => number,
  publicOrigin?: URL,
): (request: Request) => Response | undefined {
  const acceptedPublicHosts = publicOrigin === undefined ? [] : publicHosts(publicOrigin);
  return (request) => {
    const requestHost = request.headers.get('host');
    if (publicOrigin !== undefined && requestHost !== null) {
      const answer = publicOriginAnswer(request, requestHost, publicOrigin, acceptedPublicHosts);
      if (answer !== null) return answer;
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
