/**
 * Which URLs a hook may deliver to (COR-1939).
 *
 * A hook's URL is `http` or `https`, has a host, carries no user information (a credential in a URL
 * is logged and copied; a secret belongs in the signing key), no fragment, and is at most 2048
 * characters.
 *
 * Always refused, whatever the policy: the unspecified addresses (`0.0.0.0`, `::`), link-local
 * addresses (`169.254.0.0/16`, which holds the cloud metadata endpoint, and `fe80::/10`), multicast,
 * and the IPv4-mapped forms of those. Loopback (`localhost`, `127.0.0.0/8`, `::1`) and the private
 * ranges (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`) are allowed by default, because Interborough
 * runs on the person's own machine and a receiver on the same machine or network is the main use. A
 * hosted deployment sets {@link HookUrlPolicy.allowPrivateNetworks} to `false` to refuse those too.
 *
 * The check reads the URL, not the network: a name that resolves to a refused address is not
 * caught. The delivery never follows a redirect, which is the other way to reach one.
 *
 * @module hook-url-policy
 */

/** The longest URL a hook may name. */
export const HOOK_URL_MAXIMUM_LENGTH = 2048;

/** The host's policy for hook URLs. */
export interface HookUrlPolicy {
  /**
   * Whether loopback and private-network addresses (and `localhost`) are allowed. Defaults to
   * `true`: Interborough is local-first. Set `false` for a hosted deployment.
   */
  readonly allowPrivateNetworks?: boolean;
}

/** The four parts of an IPv4 literal, or `undefined` when `host` is not one. */
function ipv4Parts(host: string): readonly number[] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (match === null) return undefined;
  const parts = match.slice(1).map(Number);
  return parts.every((part) => part <= 255) ? parts : undefined;
}

/** The IPv4 address an IPv4-mapped IPv6 literal (`::ffff:a.b.c.d` or `::ffff:aabb:ccdd`) holds. */
function mappedIpv4(host: string): readonly number[] | undefined {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (dotted !== null) return ipv4Parts(dotted[1] ?? '');
  const hexadecimal = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (hexadecimal === null) return undefined;
  const high = Number.parseInt(hexadecimal[1] ?? '', 16);
  const low = Number.parseInt(hexadecimal[2] ?? '', 16);
  return [high >> 8, high & 255, low >> 8, low & 255];
}

type AddressClass = 'unspecified' | 'link-local' | 'multicast' | 'loopback' | 'private' | 'public';

function classifyIpv4(parts: readonly number[]): AddressClass {
  const [first = 0, second = 0] = parts;
  if (first === 0) return 'unspecified';
  if (first === 169 && second === 254) return 'link-local';
  if (first >= 224 && first <= 239) return 'multicast';
  if (first === 127) return 'loopback';
  if (first === 10 || (first === 172 && second >= 16 && second <= 31)) return 'private';
  if (first === 192 && second === 168) return 'private';
  return 'public';
}

function classifyIpv6(host: string): AddressClass {
  if (host === '::') return 'unspecified';
  if (host === '::1') return 'loopback';
  const mapped = mappedIpv4(host);
  if (mapped !== undefined) return classifyIpv4(mapped);
  if (/^fe[89ab]/.test(host)) return 'link-local';
  if (host.startsWith('ff')) return 'multicast';
  if (/^f[cd]/.test(host)) return 'private';
  return 'public';
}

/** What kind of address `hostname` (as `URL` reports it) is, by its text. */
function classifyHost(hostname: string): AddressClass {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  if (host.startsWith('[') && host.endsWith(']')) return classifyIpv6(host.slice(1, -1));
  const parts = ipv4Parts(host);
  return parts === undefined ? 'public' : classifyIpv4(parts);
}

/**
 * Why `value` is not a URL a hook may deliver to under `policy`, or `undefined` when it is. The
 * text is a reason to show the caller; it quotes nothing from the URL, which may carry a token.
 */
export function hookUrlDefect(value: string, policy: HookUrlPolicy = {}): string | undefined {
  if (value.length > HOOK_URL_MAXIMUM_LENGTH) {
    return `The URL is longer than ${HOOK_URL_MAXIMUM_LENGTH} characters`;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'The URL is not a valid absolute URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'The URL must use http or https';
  }
  if (url.hostname === '') return 'The URL has no host';
  if (url.username !== '' || url.password !== '') {
    return 'The URL must not carry a user name or password';
  }
  if (url.hash !== '') return 'The URL must not have a fragment';
  const kind = classifyHost(url.hostname);
  if (kind === 'unspecified' || kind === 'link-local' || kind === 'multicast') {
    return 'The URL names an address a hook may not deliver to';
  }
  if ((kind === 'loopback' || kind === 'private') && policy.allowPrivateNetworks === false) {
    return 'This deployment does not allow a hook to deliver to a loopback or private-network address';
  }
  return undefined;
}
