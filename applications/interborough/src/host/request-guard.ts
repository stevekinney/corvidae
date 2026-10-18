/**
 * The guard in front of every route on the public listener.
 *
 * The host answers every request as the one local caller holding every scope, so the only thing
 * between a web page and that caller is what the browser will let the page send. `createBureauHandler`
 * leaves this to the host that binds the port, and these two checks are it:
 *
 * - **Host.** A request must name this listener: `127.0.0.1:<port>` or `localhost:<port>`. A page
 *   on `attacker.example` whose DNS name has been rebound to `127.0.0.1` still sends
 *   `Host: attacker.example`, and is refused.
 * - **Origin.** A browser attaches `Origin` to a cross-site form post, a `fetch`, and a WebSocket
 *   handshake. When one is present it must be this listener's own origin. A request without one
 *   (a navigation, a command-line client) is not a cross-site request.
 *
 * Both refusals answer 403.
 *
 * @module request-guard
 */

/** Every `Host` this listener answers to, for the port it ended up on. */
export function allowedHosts(port: number): readonly string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

/**
 * A guard for the listener on `port()`. It returns the refusal to send, or `undefined` for a
 * request that may proceed. The port is read per request, because the listener is started before
 * its port is known when the caller asks for a free one.
 */
export function createRequestGuard(port: () => number): (request: Request) => Response | undefined {
  return (request) => {
    const hosts = allowedHosts(port());
    const host = request.headers.get('host');
    if (host === null || !hosts.includes(host.toLowerCase())) {
      return new Response('Forbidden: this host answers only to its own address.', { status: 403 });
    }
    const origin = request.headers.get('origin');
    if (origin !== null && !hosts.some((allowed) => origin.toLowerCase() === `http://${allowed}`)) {
      return new Response('Forbidden: cross-origin requests are not accepted.', { status: 403 });
    }
    return undefined;
  };
}
