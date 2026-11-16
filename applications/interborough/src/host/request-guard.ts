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
 * One exception, for A2A beyond loopback (COR-1904) and trigger deliveries (COR-2169): a guard
 * given a public origin, which the host builds only when an A2A key is configured, also accepts
 * that origin's `Host` (with or without its scheme's default port, as a proxy may send either),
 * with no `Origin` or that origin's own, for a path under `/bureau/a2a/`, `/bureau/assets/` or
 * `/triggers/` once its dot segments are resolved. An asset request must also carry a credential
 * (`X-API-Key` or `Authorization`), or it is answered 401 here: the Bureau would serve a request
 * without one as the local owner. A trigger delivery carries none, because the trigger's own
 * `receive` authenticates the sender. Every other path refuses that `Host`; the Bureau then
 * requires the key on every A2A JSON-RPC call and checks it, and the asset's owner and scope, on
 * every asset read. The host hands each public surface a guard of its own, admitting only that
 * surface's paths: `/bureau/*` one for A2A and assets, the trigger route one for
 * `/triggers/<one segment>`; every other route and every unmatched path is checked by the
 * loopback guard. The guard decides on the path of `request.url` as the listener hands it over,
 * which is also the path `withoutBureauPrefix` strips and the trigger route's handler reads, so one
 * path is judged and used; and it refuses any public request whose path holds a dot segment, an
 * encoded dot, slash or backslash, a backslash or a double slash (see {@link isAmbiguousPath}).
 * That is not the target as the client wrote it: on Bun 1.4.4 `request.url` arrives with dot
 * segments, `%2e` segments and literal backslashes already resolved, while the router matched the
 * unresolved target (`/bureau/a2a/\..\jsonrpc` reaches the Bureau as `/a2a/jsonrpc`). That is safe
 * because every surface admits only its own prefix and no handler sees a path the guard did not.
 *
 * The guard reads `Host`, so the reverse proxy in front of a public origin must forward it. One
 * that rewrites it to `127.0.0.1:<port>` makes every request it forwards look local, and so
 * exposes every route as the owner; nothing here can tell the difference.
 *
 * @module request-guard
 */

/**
 * The trigger deliveries a public origin reaches (COR-2169): `POST /triggers/<workflow-id>`, with
 * no credential. The guard checks the `Host`, the `Origin` and the path prefix; the route table
 * answers a method or a path that is not that one (it falls to the loopback-only guard, 403), and
 * the trigger's own `receive` authenticates the sender.
 */
export const PUBLIC_TRIGGERS_PATH_PREFIX = '/triggers/';

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
 * The path of `request.url` with the query and the fragment cut off and an absolute-form target's
 * scheme and authority cut off, and nothing decoded or resolved here. It is the path the guard
 * decides on, `withoutBureauPrefix` strips and the trigger route's handler reads. It is not the
 * target as the client wrote it: Bun has already resolved dot segments, `%2e` segments and literal
 * backslashes in `request.url`, so a request the router matched on its unresolved form can arrive
 * here as another path. Because each public surface admits only its own prefix and the handlers
 * read this same path, the guard stays sound.
 */
export function rawPathOf(request: Request): string {
  const withoutOrigin = request.url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '');
  const end = withoutOrigin.search(/[?#]/);
  const path = end === -1 ? withoutOrigin : withoutOrigin.slice(0, end);
  return path === '' ? '/' : path;
}

/**
 * Whether a raw path can name two places, one to the guard and another to a handler that resolves,
 * strips or decodes it: a dot segment, an encoded dot, slash or backslash (any case), a backslash,
 * or a double slash. A request through the public origin with such a path is refused, and the
 * Bureau handler is given none.
 *
 * Which clauses can fire at the listener on Bun 1.4.4: an encoded slash or backslash (`%2f`,
 * `%5c`), an encoded dot inside a segment (`a%2eb`), and a double slash, which it hands over as
 * written. A dot segment and a literal backslash arrive already resolved, so those two clauses are
 * defense in depth, for another runtime or a request built by hand.
 */
export function isAmbiguousPath(path: string): boolean {
  return (
    /(?:^|\/)\.{1,2}(?:\/|$)/.test(path) ||
    /%(?:2e|2f|5c)/i.test(path) ||
    path.includes('\\') ||
    path.includes('//')
  );
}

/** The public surfaces a guard may admit, each with the one shape of path that is its own. */
export type PublicSurface = 'a2a' | 'assets' | 'triggers';

/** One segment after `/triggers/`: the workflow identifier, and nothing below it. */
const TRIGGER_PATH_PATTERN = /^\/triggers\/[^/]+$/;

/**
 * Which of `surfaces` the raw `path` names, if any. Each surface admits only its own prefix: a
 * guard built for the trigger route never admits an A2A path, and the Bureau's never admits a
 * trigger one.
 */
function publicSurfaceOf(
  path: string,
  surfaces: readonly PublicSurface[],
): PublicSurface | undefined {
  if (surfaces.includes('a2a') && path.startsWith(PUBLIC_A2A_PATH_PREFIX)) return 'a2a';
  if (surfaces.includes('assets') && path.startsWith(PUBLIC_ASSETS_PATH_PREFIX)) return 'assets';
  if (surfaces.includes('triggers') && TRIGGER_PATH_PATTERN.test(path)) return 'triggers';
  return undefined;
}

/**
 * The guard's answer to a request naming the public origin and one of its paths, or `null` for
 * any other request, which the loopback check answers. A public request whose raw path is
 * ambiguous is refused here, whatever surface it names, before any prefix is looked at.
 */
function publicOriginAnswer(
  request: Request,
  requestHost: string,
  publicOrigin: URL,
  hosts: readonly string[],
  surfaces: readonly PublicSurface[],
): Response | undefined | null {
  if (!hosts.includes(requestHost.toLowerCase())) return null;
  const rawPath = rawPathOf(request);
  if (isAmbiguousPath(rawPath)) {
    return new Response('Forbidden: this path is not accepted.', { status: 403 });
  }
  const path = publicSurfaceOf(rawPath, surfaces);
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
 * accepts that origin for the paths of `surfaces` and no others: A2A and assets by default, which
 * is what `/bureau/*` is given, and `['triggers']` for the trigger route. Each route gets a guard
 * of its own surface, so no allowlist decides for a route that did not ask for an entry.
 */
export function createRequestGuard(
  port: () => number,
  publicOrigin?: URL,
  surfaces: readonly PublicSurface[] = ['a2a', 'assets'],
): (request: Request) => Response | undefined {
  const acceptedPublicHosts = publicOrigin === undefined ? [] : publicHosts(publicOrigin);
  return (request) => {
    const requestHost = request.headers.get('host');
    if (publicOrigin !== undefined && requestHost !== null) {
      const answer = publicOriginAnswer(
        request,
        requestHost,
        publicOrigin,
        acceptedPublicHosts,
        surfaces,
      );
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
