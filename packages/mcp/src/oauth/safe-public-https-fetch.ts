import { lookup as defaultDnsLookup } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';
import { isAddressInCidr, withDeadline } from './security-utilities.ts';

const defaultFetchTimeoutMilliseconds = 5_000;

const blockedIpCidrs = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '255.255.255.255/32',
  '::1/128',
  '::/128',
  '64:ff9b::/96',
  '::ffff:0:0/96',
  '100::/64',
  '2001:db8::/32',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
] as const;

function isBlockedIpAddress(address: string): boolean {
  return blockedIpCidrs.some((cidr) => isAddressInCidr(address, cidr));
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

export class ClientMetadataDocumentFetchError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'ClientMetadataDocumentFetchError';
  }
}

export type DnsLookupAllFunction = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<{ address: string; family: number }[]>;

const lookupAll: DnsLookupAllFunction = (hostname, options) => defaultDnsLookup(hostname, options);

export type SafePublicHttpsFetchOptions = {
  fetchImpl?:
    ((input: string | URL | Request, init?: RequestInit) => Promise<Response>) | undefined;
  lookupImpl?: DnsLookupAllFunction | undefined;
  dnsTimeoutMs?: number | undefined;
  fetchTimeoutMs?: number;
  headers?: HeadersInit;
};

const dnsLookupConcurrencyLimit = 16;
let outstandingDnsLookupCount = 0;
const inFlightDnsLookupsByHostname = new Map<
  string,
  Promise<{ address: string; family: number }[]>
>();

// DNS lookup has no cancellable deadline. Coalescing a hostname prevents one
// stalled name from consuming repeated resolver work, while the global limit
// fails closed instead of creating an unbounded queue of distinct names. This
// is deliberately not a TTL cache: every later request must resolve and check
// the current complete address set again.

function boundedCoalescedLookup(
  hostname: string,
  lookupImpl: DnsLookupAllFunction,
): Promise<{ address: string; family: number }[]> {
  const inFlight = inFlightDnsLookupsByHostname.get(hostname);
  if (inFlight) return inFlight;
  if (outstandingDnsLookupCount >= dnsLookupConcurrencyLimit) {
    return Promise.reject(new Error('DNS lookup concurrency limit exceeded'));
  }

  outstandingDnsLookupCount += 1;
  const lookupPromise = lookupImpl(hostname, { all: true, verbatim: true }).finally(() => {
    outstandingDnsLookupCount -= 1;
    inFlightDnsLookupsByHostname.delete(hostname);
  });
  inFlightDnsLookupsByHostname.set(hostname, lookupPromise);
  return lookupPromise;
}

async function assertHostnameIsPubliclyRoutable(
  hostname: string,
  lookupImpl: DnsLookupAllFunction,
  dnsTimeoutMilliseconds: number,
): Promise<void> {
  if (isIPv4(hostname) || isIPv6(hostname)) {
    if (isBlockedIpAddress(hostname)) {
      throw new ClientMetadataDocumentFetchError('blocked_address');
    }
    return;
  }

  let records: { address: string }[];
  try {
    records = await withDeadline(
      boundedCoalescedLookup(hostname, lookupImpl),
      dnsTimeoutMilliseconds,
    );
  } catch {
    throw new ClientMetadataDocumentFetchError('dns_resolution_failed');
  }
  if (records.length === 0) throw new ClientMetadataDocumentFetchError('dns_resolution_failed');
  if (records.some((record) => isBlockedIpAddress(record.address))) {
    throw new ClientMetadataDocumentFetchError('blocked_address');
  }
}

/**
 * Fetches one client-supplied HTTPS URL through the complete SSRF boundary:
 * HTTPS-only, literal-IP blocking, every resolved address checked, and no redirects.
 * The resolve-then-connect gap is additionally bounded by normal HTTPS certificate
 * validation: a name rebound to an internal service cannot present a valid certificate
 * for the original public hostname.
 */
export async function safeFetchPublicHttpsUrl(
  input: string | URL,
  options: SafePublicHttpsFetchOptions = {},
): Promise<Response> {
  const url = input instanceof URL ? input : new URL(input);
  if (url.protocol !== 'https:') throw new ClientMetadataDocumentFetchError('https_required');
  await assertHostnameIsPubliclyRoutable(
    stripIpv6Brackets(url.hostname),
    options.lookupImpl ?? lookupAll,
    options.dnsTimeoutMs ?? defaultFetchTimeoutMilliseconds,
  );
  return (options.fetchImpl ?? fetch)(url, {
    method: 'GET',
    redirect: 'error',
    ...(options.headers ? { headers: options.headers } : {}),
    signal: AbortSignal.timeout(options.fetchTimeoutMs ?? defaultFetchTimeoutMilliseconds),
  });
}
