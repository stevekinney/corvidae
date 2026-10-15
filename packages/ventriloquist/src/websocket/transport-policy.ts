/** Whether `address` is a loopback IP literal: 127.0.0.0/8, `::1`, or an IPv4-mapped loopback. */
export function isLoopbackAddress(address: string): boolean {
  const unmapped = address.toLowerCase().startsWith('::ffff:') ? address.slice(7) : address;
  if (unmapped === '::1') return true;
  const octets = unmapped.split('.');
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255) &&
    octets[0] === '127'
  );
}

/**
 * Whether a listener is bound to the loopback interface alone. A wildcard bind (`0.0.0.0`, `::`) or
 * no hostname at all listens on every interface, so a `Host` header naming `localhost` proves
 * nothing there: only an address that is itself loopback, or the name `localhost`, counts.
 */
export function isLoopbackListener(hostname: string | undefined): boolean {
  if (hostname === undefined) return false;
  const bare =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return bare.toLowerCase() === 'localhost' || isLoopbackAddress(bare);
}

/** An address in the one form proxies are compared in: lowercase, with an IPv4-mapped prefix removed. */
export function normalizeAddress(address: string): string {
  const lower = address.toLowerCase();
  return lower.startsWith('::ffff:') && lower.includes('.') ? lower.slice(7) : lower;
}

/**
 * The scheme a trusted proxy reports for the client's connection. The header may carry a list, and
 * every proxy appends the scheme it saw, so only the last value was written by the proxy closest to
 * this listener, which is the one that is trusted; anything before it came from the client or from
 * hops beyond the trust boundary. Case and padding do not matter. Only `https` counts as secure.
 */
export function forwardedSchemeIsSecure(header: string | null): boolean {
  if (header === null) return false;
  const last = header.split(',').at(-1) ?? '';
  return last.trim().toLowerCase() === 'https';
}

export type TransportFacts = {
  /** The scheme of the upgrade request's URL, as the listener saw it (`https:` or `http:`). */
  readonly protocol: string;
  /** The hostname the listener is bound to, from the server and never from a request header. */
  readonly listenerHostname: string | undefined;
  /** The peer's address as the socket reports it, or `undefined` when it cannot be read. */
  readonly peerAddress: string | undefined;
  /** The host's explicit development switch. Off unless the host turns it on. */
  readonly allowInsecureLoopback: boolean;
  /** Exact, normalized addresses of proxies the host trusts to report the client's scheme. Default: none. */
  readonly trustedProxies?: ReadonlySet<string>;
  /** The request's `X-Forwarded-Proto` value, read only by the caller and only meaningful from a trusted peer. */
  readonly forwardedProto?: string | null;
};

export type TransportDecision =
  | {
      readonly allowed: true;
      readonly transport: 'secure' | 'trusted-proxy' | 'loopback-development';
    }
  | { readonly allowed: false; readonly reason: 'insecure-transport' | 'not-loopback' };

/**
 * Secure transport is the default: only an `https:` upgrade is admitted. A host that terminates TLS
 * in a proxy names that proxy's address in `trustedProxies`, and only then is `X-Forwarded-Proto`
 * believed, by the rule in `forwardedSchemeIsSecure`. From any other peer the header is never
 * consulted, because anyone can send one. The development switch admits plain `http:` only when the
 * listener is bound to loopback and the peer is a loopback address too. The
 * switch relaxes the transport and nothing else, so origin and authentication still apply.
 */
export function decideTransport(facts: TransportFacts): TransportDecision {
  if (facts.protocol === 'https:') return { allowed: true, transport: 'secure' };
  // A forwarded scheme is believed only from a peer the host named; from anyone else it is ignored.
  if (
    facts.peerAddress !== undefined &&
    facts.trustedProxies?.has(normalizeAddress(facts.peerAddress)) === true &&
    forwardedSchemeIsSecure(facts.forwardedProto ?? null)
  ) {
    return { allowed: true, transport: 'trusted-proxy' };
  }
  if (!facts.allowInsecureLoopback) return { allowed: false, reason: 'insecure-transport' };
  if (
    isLoopbackListener(facts.listenerHostname) &&
    facts.peerAddress !== undefined &&
    isLoopbackAddress(facts.peerAddress)
  ) {
    return { allowed: true, transport: 'loopback-development' };
  }
  return { allowed: false, reason: 'not-loopback' };
}
