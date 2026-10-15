/**
 * URL admission policy (COR-794): the static checks every URL passes before
 * anything is resolved or fetched, address classification for SSRF defense,
 * and the redirect-following host fetch that revalidates every hop and pins
 * each connection to an address it has validated twice.
 *
 * DNS and HTTP are injected ports (`AssetHostResolver`, `AssetFetcher`); this
 * module never touches the network itself. Address classification is pure
 * arithmetic over parsed octets.
 *
 * Nothing here ever puts a URL into an error message or a return value
 * other than its origin: a rejected URL's path, query (where signatures
 * live), and userinfo stay with the caller.
 */
import { AssetAdmissionError } from './errors';
import type { AssetFetcher, AssetHostResolver, AssetUrlPolicy } from './types';

// ── Address classification ────────────────────────────────────────────

function parseIpv4(text: string): number[] | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : undefined;
}

/** Parses an IPv6 address (without brackets) into eight 16-bit groups, accepting `::` and a dotted IPv4 tail. */
function parseIpv6(text: string): number[] | undefined {
  let source = text.toLowerCase();
  const zone = source.indexOf('%');
  if (zone !== -1) source = source.slice(0, zone);
  const lastColon = source.lastIndexOf(':');
  if (lastColon === -1) return undefined;
  if (source.slice(lastColon + 1).includes('.')) {
    // Rewrite a dotted IPv4 tail as the two hexadecimal groups it stands for.
    const ipv4 = parseIpv4(source.slice(lastColon + 1));
    if (!ipv4) return undefined;
    const high = ((ipv4[0]! << 8) | ipv4[1]!).toString(16);
    const low = ((ipv4[2]! << 8) | ipv4[3]!).toString(16);
    source = `${source.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const halves = source.split('::');
  if (halves.length > 2) return undefined;
  const parseGroups = (half: string | undefined): number[] =>
    half
      ? half
          .split(':')
          .map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : Number.NaN))
      : [];
  const head = parseGroups(halves[0]);
  let groups = head;
  if (halves.length === 2) {
    const rest = parseGroups(halves[1]);
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return undefined;
    groups = [...head, ...Array.from({ length: missing }, () => 0), ...rest];
  }
  if (groups.length !== 8 || groups.some((group) => Number.isNaN(group))) return undefined;
  return groups;
}

function inRange(octets: readonly number[], prefix: readonly number[], bits: number): boolean {
  let remaining = bits;
  for (let index = 0; remaining > 0; index++) {
    const take = Math.min(8, remaining);
    const mask = (0xff << (8 - take)) & 0xff;
    if (((octets[index] ?? 0) & mask) !== ((prefix[index] ?? 0) & mask)) return false;
    remaining -= take;
  }
  return true;
}

const PRIVATE_IPV4: ReadonlyArray<readonly [readonly number[], number]> = [
  [[0], 8], // "this" network
  [[10], 8],
  [[100, 64], 10], // carrier-grade NAT
  [[127], 8], // loopback
  [[169, 254], 16], // link-local, including cloud metadata endpoints
  [[172, 16], 12],
  [[192, 0, 0], 24],
  [[192, 0, 2], 24], // documentation
  [[192, 168], 16],
  [[198, 18], 15], // benchmarking
  [[198, 51, 100], 24], // documentation
  [[203, 0, 113], 24], // documentation
  [[224], 4], // multicast
  [[240], 4], // reserved and broadcast
];

function isPrivateIpv4(octets: readonly number[]): boolean {
  return PRIVATE_IPV4.some(([prefix, bits]) => inRange(octets, prefix, bits));
}

function embeddedIpv4(groups: readonly number[]): number[] {
  return [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff];
}

function isPrivateIpv6(groups: readonly number[]): boolean {
  const bytes = groups.flatMap((group) => [group >> 8, group & 0xff]);
  const leadingZeroGroups = groups.slice(0, 5).every((group) => group === 0);
  // ::, ::1, IPv4-compatible ::a.b.c.d, and IPv4-mapped ::ffff:a.b.c.d all defer to the IPv4 rules.
  if (leadingZeroGroups && (groups[5] === 0 || groups[5] === 0xffff)) {
    if (groups[5] === 0 && groups[6] === 0 && (groups[7] ?? 0) <= 1) return true;
    return isPrivateIpv4(embeddedIpv4(groups));
  }
  // IPv4-translated ::ffff:0:a.b.c.d (::ffff:0:0/96) embeds an IPv4 destination.
  if (groups.slice(0, 4).every((group) => group === 0) && groups[4] === 0xffff && groups[5] === 0) {
    return isPrivateIpv4(embeddedIpv4(groups));
  }
  // NAT64 64:ff9b::/96 embeds an IPv4 destination too.
  if (
    inRange(bytes, [0x00, 0x64, 0xff, 0x9b], 32) &&
    groups.slice(2, 6).every((group) => group === 0)
  ) {
    return isPrivateIpv4(embeddedIpv4(groups));
  }
  // 6to4 2002::/16 carries its IPv4 relay address in the next 32 bits.
  if (groups[0] === 0x2002) {
    return isPrivateIpv4([groups[1]! >> 8, groups[1]! & 0xff, groups[2]! >> 8, groups[2]! & 0xff]);
  }
  return (
    inRange(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48) || // local-use NAT64 (RFC 8215)
    inRange(bytes, [0xfc], 7) || // unique local
    inRange(bytes, [0xfe, 0x80], 10) || // link-local
    inRange(bytes, [0xfe, 0xc0], 10) || // site-local (deprecated, still routable on some networks)
    inRange(bytes, [0xff], 8) || // multicast
    inRange(bytes, [0x20, 0x01, 0x0d, 0xb8], 32) || // documentation
    inRange(bytes, [0x01, 0x00, 0, 0, 0, 0, 0, 0], 64) // discard-only
  );
}

/** Whether `address` (an IPv4 or IPv6 literal, IPv6 optionally bracketed) is non-public. Unparseable input counts as private. */
export function isPrivateAddress(address: string): boolean {
  const unbracketed =
    address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const ipv4 = parseIpv4(unbracketed);
  if (ipv4) return isPrivateIpv4(ipv4);
  const ipv6 = parseIpv6(unbracketed);
  if (ipv6) return isPrivateIpv6(ipv6);
  return true;
}

/** The IP literal a URL's host names, or `undefined` for a DNS name. The WHATWG parser has already normalized decimal and hex IPv4 forms. */
function hostLiteral(url: URL): string | undefined {
  const host = url.hostname;
  if (host.startsWith('[')) return host;
  return parseIpv4(host) ? host : undefined;
}

function isLocalName(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, '');
  return name === 'localhost' || name.endsWith('.localhost');
}

// ── Signed URLs ───────────────────────────────────────────────────────

function parseCompactTimestamp(value: string): number | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
}

function relativeExpiry(dateValue: string | null, secondsValue: string | null): number | undefined {
  if (dateValue === null || secondsValue === null) return undefined;
  const start = parseCompactTimestamp(dateValue);
  const seconds = Number(secondsValue);
  if (start === undefined || !Number.isFinite(seconds)) return undefined;
  return start + seconds * 1000;
}

/**
 * The earliest expiry a recognized signing scheme encodes in `url`, in epoch
 * milliseconds: AWS SigV4 (`X-Amz-Date` + `X-Amz-Expires`), Google V4
 * (`X-Goog-Date` + `X-Goog-Expires`), CloudFront/GCS V2 (`Expires`, epoch
 * seconds), and Azure SAS (`se`, ISO-8601).
 */
export function signedUrlExpiry(url: URL): number | undefined {
  const parameters = url.searchParams;
  const candidates = [
    relativeExpiry(parameters.get('X-Amz-Date'), parameters.get('X-Amz-Expires')),
    relativeExpiry(parameters.get('X-Goog-Date'), parameters.get('X-Goog-Expires')),
  ];
  const expires = parameters.get('Expires');
  if (expires !== null && /^\d+$/.test(expires)) candidates.push(Number(expires) * 1000);
  const azure = parameters.get('se');
  if (azure !== null) {
    const parsed = Date.parse(azure);
    if (!Number.isNaN(parsed)) candidates.push(parsed);
  }
  const defined = candidates.filter((candidate): candidate is number => candidate !== undefined);
  return defined.length > 0 ? Math.min(...defined) : undefined;
}

// ── Static validation ─────────────────────────────────────────────────

/**
 * Query parameters that carry a long-lived bearer credential rather than a
 * time-limited signature. A signed URL (which encodes its own expiry and is
 * refused once that passes) is not one of these.
 */
const BEARER_QUERY_PARAMETERS = new Set([
  'access_token',
  'api_key',
  'api-key',
  'apikey',
  'auth',
  'auth_token',
  'client_secret',
  'password',
  'private_token',
  'refresh_token',
  'secret',
  'token',
]);

function carriesBearerCredential(url: URL): boolean {
  for (const name of url.searchParams.keys()) {
    if (BEARER_QUERY_PARAMETERS.has(name.toLowerCase())) return true;
  }
  return false;
}

/** The origin of `raw`, or `'invalid'` when it does not parse. Never includes userinfo, path, or query. */
export function originOf(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return 'invalid';
  }
}

/**
 * Every check a URL must pass before it is resolved or fetched: it parses;
 * its scheme is allowed; it carries no credentials (userinfo, or a bearer
 * token in its query); any signature it carries
 * has not expired; and, unless the policy allows private networks, its host
 * is neither a private literal address nor a local name.
 */
export function checkUrl(raw: string, policy: AssetUrlPolicy, now: number): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AssetAdmissionError('unsupported-source', 'The URL does not parse.');
  }
  if (!policy.allowedSchemes.includes(url.protocol)) {
    throw new AssetAdmissionError(
      'scheme-not-allowed',
      `The "${url.protocol}" scheme is not allowed.`,
    );
  }
  if (url.username !== '' || url.password !== '' || carriesBearerCredential(url)) {
    throw new AssetAdmissionError(
      'credential-bearing-url',
      'URLs carrying credentials are refused.',
    );
  }
  const expiry = signedUrlExpiry(url);
  if (expiry !== undefined && expiry <= now) {
    throw new AssetAdmissionError('signed-url-expired', 'The signed URL has expired.');
  }
  if (!policy.allowPrivateNetwork) {
    const literal = hostLiteral(url);
    if ((literal !== undefined && isPrivateAddress(literal)) || isLocalName(url.hostname)) {
      throw new AssetAdmissionError('private-address', 'The URL names a private network address.');
    }
  }
  return url;
}

// ── Host fetch ────────────────────────────────────────────────────────

export interface HostFetchOptions {
  readonly url: string;
  readonly policy: AssetUrlPolicy;
  readonly now: () => number;
  readonly resolveHost: AssetHostResolver | undefined;
  readonly fetch: AssetFetcher | undefined;
  readonly maxBytes: number;
  readonly signal: AbortSignal;
  /** Routes every port call through the caller's abort-aware tracking. */
  readonly track: <T>(promise: Promise<T>) => Promise<T>;
}

export interface HostFetchResult {
  readonly bytes: Uint8Array;
  readonly contentType: string | undefined;
  readonly origin: string;
  readonly redirects: number;
}

async function resolveOnce(
  hostname: string,
  options: HostFetchOptions,
): Promise<readonly string[]> {
  if (!options.resolveHost) {
    throw new AssetAdmissionError('dns-resolution-failed', 'No host resolver is configured.');
  }
  let addresses: readonly string[];
  try {
    addresses = await options.track(options.resolveHost(hostname));
  } catch (error) {
    if (options.signal.aborted) throw error;
    throw new AssetAdmissionError('dns-resolution-failed', 'The host name did not resolve.');
  }
  if (addresses.length === 0) {
    throw new AssetAdmissionError('dns-resolution-failed', 'The host name did not resolve.');
  }
  return addresses;
}

/**
 * Chooses the address to connect to. A literal host is used as is (it
 * already passed {@link checkUrl}). A DNS name is resolved and every answer
 * must be public; it is then resolved a second time immediately before the
 * connection, and that answer must still be all-public and still contain
 * the pinned address — a changed answer is DNS rebinding.
 */
async function pinAddress(url: URL, options: HostFetchOptions): Promise<string> {
  const literal = hostLiteral(url);
  if (literal !== undefined) return literal.replace(/^\[|\]$/g, '');
  const checkPrivate = !options.policy.allowPrivateNetwork;
  const first = await resolveOnce(url.hostname, options);
  if (checkPrivate && first.some(isPrivateAddress)) {
    throw new AssetAdmissionError(
      'private-address',
      'The host name resolves to a private address.',
    );
  }
  const pinned = first[0]!;
  const second = await resolveOnce(url.hostname, options);
  if (!second.includes(pinned) || (checkPrivate && second.some(isPrivateAddress))) {
    throw new AssetAdmissionError(
      'dns-rebinding',
      'The host name resolved differently on connection.',
    );
  }
  return pinned;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Fetches `options.url`, following and revalidating each redirect hop itself. */
export async function fetchWithPolicy(options: HostFetchOptions): Promise<HostFetchResult> {
  let current = checkUrl(options.url, options.policy, options.now());
  if (!options.fetch) {
    throw new AssetAdmissionError('source-not-available', 'No host fetch port is configured.');
  }
  for (let redirects = 0; ; redirects++) {
    const address = await pinAddress(current, options);
    let response;
    try {
      response = await options.track(
        options.fetch({
          url: current.href,
          address,
          maxBytes: options.maxBytes,
          signal: options.signal,
        }),
      );
    } catch (error) {
      if (options.signal.aborted) throw error;
      throw new AssetAdmissionError('fetch-failed', 'The host fetch failed.');
    }
    if (REDIRECT_STATUSES.has(response.status) && response.location !== undefined) {
      if (redirects >= options.policy.maxRedirects) {
        throw new AssetAdmissionError('too-many-redirects', 'The redirect chain is too long.');
      }
      let next: string;
      try {
        next = new URL(response.location, current).href;
      } catch {
        throw new AssetAdmissionError('fetch-failed', 'A redirect location does not parse.');
      }
      current = checkUrl(next, options.policy, options.now());
      continue;
    }
    if (response.status < 200 || response.status > 299) {
      throw new AssetAdmissionError('fetch-failed', `The host answered ${response.status}.`);
    }
    return {
      bytes: response.body,
      contentType: response.contentType,
      origin: current.origin,
      redirects,
    };
  }
}
