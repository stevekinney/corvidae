import { beforeEach, describe, expect, it } from 'bun:test';
import {
  clearClientIdMetadataDocumentCacheForTests,
  fetchClientIdMetadataDocument,
  isClientIdMetadataDocumentUrl,
  resetDnsLookupConcurrencyLimiterForTests,
  safeFetchPublicHttpsUrl,
} from './client-metadata-documents.ts';

const validDocumentUrl = 'https://app.example.com/oauth/client.json';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/** A public-looking IPv4 address, distinct per test only where it matters. */
const publicAddress = { address: '93.184.216.34', family: 4 };

function lookupResolvingTo(...addresses: { address: string; family: number }[]) {
  return async () => addresses;
}

describe('safeFetchPublicHttpsUrl', () => {
  it('rejects non-HTTPS URLs before DNS resolution or fetch', async () => {
    let lookupCalled = false;
    let fetchCalled = false;

    await expect(
      safeFetchPublicHttpsUrl('http://app.example.com/client.json', {
        lookupImpl: async () => {
          lookupCalled = true;
          return [publicAddress];
        },
        fetchImpl: async () => {
          fetchCalled = true;
          return new Response();
        },
      }),
    ).rejects.toMatchObject({ reason: 'https_required' });
    expect(lookupCalled).toBe(false);
    expect(fetchCalled).toBe(false);
  });

  it('rejects a private literal before DNS resolution or fetch', async () => {
    let lookupCalled = false;
    let fetchCalled = false;

    await expect(
      safeFetchPublicHttpsUrl('https://127.0.0.1/client.json', {
        lookupImpl: async () => {
          lookupCalled = true;
          return [publicAddress];
        },
        fetchImpl: async () => {
          fetchCalled = true;
          return new Response();
        },
      }),
    ).rejects.toMatchObject({ reason: 'blocked_address' });
    expect(lookupCalled).toBe(false);
    expect(fetchCalled).toBe(false);
  });

  it('rejects when any resolved address is private', async () => {
    let fetchCalled = false;

    await expect(
      safeFetchPublicHttpsUrl(validDocumentUrl, {
        lookupImpl: lookupResolvingTo(publicAddress, { address: '10.0.0.1', family: 4 }),
        fetchImpl: async () => {
          fetchCalled = true;
          return new Response();
        },
      }),
    ).rejects.toMatchObject({ reason: 'blocked_address' });
    expect(fetchCalled).toBe(false);
  });

  it('disables redirects on the fetch operation', async () => {
    let receivedRedirect: RequestRedirect | undefined;
    await safeFetchPublicHttpsUrl(validDocumentUrl, {
      lookupImpl: lookupResolvingTo(publicAddress),
      fetchImpl: async (_input, init) => {
        receivedRedirect = init?.redirect;
        return new Response();
      },
    });
    expect(receivedRedirect).toBe('error');
  });
});

describe('isClientIdMetadataDocumentUrl', () => {
  it('accepts an https URL with a non-root path', () => {
    expect(isClientIdMetadataDocumentUrl(validDocumentUrl)).toBe(true);
  });

  it('rejects a bare https origin with no path', () => {
    expect(isClientIdMetadataDocumentUrl('https://app.example.com')).toBe(false);
    expect(isClientIdMetadataDocumentUrl('https://app.example.com/')).toBe(false);
  });

  it('rejects http (non-TLS)', () => {
    expect(isClientIdMetadataDocumentUrl('http://app.example.com/client.json')).toBe(false);
  });

  it('rejects a URL with a fragment', () => {
    expect(isClientIdMetadataDocumentUrl(`${validDocumentUrl}#frag`)).toBe(false);
  });

  it('rejects a URL with embedded userinfo', () => {
    expect(isClientIdMetadataDocumentUrl('https://user:pass@app.example.com/client.json')).toBe(
      false,
    );
  });

  it('rejects a DCR-shaped client_id (not a URL at all)', () => {
    expect(isClientIdMetadataDocumentUrl('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(false);
  });

  it('rejects a malformed URL', () => {
    expect(isClientIdMetadataDocumentUrl('not a url')).toBe(false);
  });
});

describe('fetchClientIdMetadataDocument', () => {
  beforeEach(() => {
    clearClientIdMetadataDocumentCacheForTests();
    // The DNS lookup concurrency limiter's in-flight map and outstanding
    // count are process-global module state (see resetDnsLookupConcurrencyLimiterForTests's
    // own doc comment). Several cases below (including the pre-existing
    // "never resolves" case) intentionally leave a lookup permanently
    // pending for the same hostname `validDocumentUrl` uses; without this
    // reset, that stuck entry would coalesce into -- and hang -- every
    // later test that looks up the same hostname.
    resetDnsLookupConcurrencyLimiterForTests();
  });

  const validDocumentBody = {
    client_id: validDocumentUrl,
    client_name: 'Example CIMD Client',
    redirect_uris: ['https://app.example.com/callback'],
  };

  it('returns null for a client_id that is not CIMD-shaped, without ever fetching', async () => {
    let fetchCalled = false;
    const result = await fetchClientIdMetadataDocument('not-a-url', {
      fetchImpl: async () => {
        fetchCalled = true;
        return jsonResponse(validDocumentBody);
      },
      lookupImpl: lookupResolvingTo(publicAddress),
    });
    expect(result).toBeNull();
    expect(fetchCalled).toBe(false);
  });

  it('fetches, validates, and returns a well-formed document', async () => {
    const result = await fetchClientIdMetadataDocument(validDocumentUrl, {
      fetchImpl: async () => jsonResponse(validDocumentBody),
      lookupImpl: lookupResolvingTo(publicAddress),
    });
    expect(result).not.toBeNull();
    expect(result?.clientId).toBe(validDocumentUrl);
    expect(result?.clientName).toBe('Example CIMD Client');
    expect(result?.redirectUris).toEqual(['https://app.example.com/callback']);
    // Defaults applied like DCR: `none` is the only auth method a CIMD
    // document can declare, and both defaults match the DCR schema.
    expect(result?.grantTypes).toEqual(['authorization_code', 'refresh_token']);
    expect(result?.responseTypes).toEqual(['code']);
  });

  it('preserves an additional OAuth extension grant from hosted Claude metadata', async () => {
    const extensionGrant = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
    const result = await fetchClientIdMetadataDocument(validDocumentUrl, {
      fetchImpl: async () =>
        jsonResponse({
          ...validDocumentBody,
          grant_types: ['authorization_code', 'refresh_token', extensionGrant],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
      lookupImpl: lookupResolvingTo(publicAddress),
    });
    expect(result?.grantTypes).toEqual(['authorization_code', 'refresh_token', extensionGrant]);
  });

  for (const invalidGrant of [
    '',
    'authorization code',
    'authorization_code\n',
    'x'.repeat(257),
    42,
  ]) {
    it(`rejects a malformed grant type ${JSON.stringify(invalidGrant)}`, async () => {
      const result = await fetchClientIdMetadataDocument(validDocumentUrl, {
        fetchImpl: async () =>
          jsonResponse({ ...validDocumentBody, grant_types: ['authorization_code', invalidGrant] }),
        lookupImpl: lookupResolvingTo(publicAddress),
      });
      expect(result).toBeNull();
    });
  }

  it('rejects a document whose client_id does not match the fetch URL exactly', async () => {
    const result = await fetchClientIdMetadataDocument(validDocumentUrl, {
      fetchImpl: async () =>
        jsonResponse({ ...validDocumentBody, client_id: 'https://attacker.example.com/x.json' }),
      lookupImpl: lookupResolvingTo(publicAddress),
    });
    expect(result).toBeNull();
  });

  it('rejects a document missing required fields', async () => {
    const result = await fetchClientIdMetadataDocument(validDocumentUrl, {
      fetchImpl: async () => jsonResponse({ client_id: validDocumentUrl }),
      lookupImpl: lookupResolvingTo(publicAddress),
    });
    expect(result).toBeNull();
  });

  it('rejects a document declaring an auth method other than none', async () => {
    const result = await fetchClientIdMetadataDocument(validDocumentUrl, {
      fetchImpl: async () =>
        jsonResponse({ ...validDocumentBody, token_endpoint_auth_method: 'client_secret_post' }),
      lookupImpl: lookupResolvingTo(publicAddress),
    });
    expect(result).toBeNull();
  });

  it('rejects application_type "web" combined with a loopback redirect_uri', async () => {
    const result = await fetchClientIdMetadataDocument(validDocumentUrl, {
      fetchImpl: async () =>
        jsonResponse({
          ...validDocumentBody,
          redirect_uris: ['http://localhost:3000/callback'],
          application_type: 'web',
        }),
      lookupImpl: lookupResolvingTo(publicAddress),
    });
    expect(result).toBeNull();
  });

  it('accepts application_type "native" with a loopback redirect_uri', async () => {
    const result = await fetchClientIdMetadataDocument(validDocumentUrl, {
      fetchImpl: async () =>
        jsonResponse({
          ...validDocumentBody,
          redirect_uris: ['http://localhost:3000/callback'],
          application_type: 'native',
        }),
      lookupImpl: lookupResolvingTo(publicAddress),
    });
    expect(result).not.toBeNull();
    expect(result?.applicationType).toBe('native');
  });

  it('rejects malformed JSON', async () => {
    const result = await fetchClientIdMetadataDocument(validDocumentUrl, {
      fetchImpl: async () =>
        new Response('not json{{{', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      lookupImpl: lookupResolvingTo(publicAddress),
    });
    expect(result).toBeNull();
  });

  it('rejects a non-application/json content type', async () => {
    const result = await fetchClientIdMetadataDocument(validDocumentUrl, {
      fetchImpl: async () =>
        new Response(JSON.stringify(validDocumentBody), {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
      lookupImpl: lookupResolvingTo(publicAddress),
    });
    expect(result).toBeNull();
  });

  it('rejects a non-2xx response', async () => {
    const result = await fetchClientIdMetadataDocument(validDocumentUrl, {
      fetchImpl: async () => new Response('nope', { status: 404 }),
      lookupImpl: lookupResolvingTo(publicAddress),
    });
    expect(result).toBeNull();
  });

  it('rejects a response over the byte limit even when Content-Length lies', async () => {
    const oversizedBody = JSON.stringify({
      ...validDocumentBody,
      client_name: 'x'.repeat(64 * 1024),
    });
    const result = await fetchClientIdMetadataDocument(validDocumentUrl, {
      fetchImpl: async () =>
        new Response(oversizedBody, {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-length': '1' },
        }),
      lookupImpl: lookupResolvingTo(publicAddress),
    });
    expect(result).toBeNull();
  });

  it('rejects a declared Content-Length over the byte limit before reading the body', async () => {
    let bodyRead = false;
    const result = await fetchClientIdMetadataDocument(validDocumentUrl, {
      fetchImpl: async () => {
        const response = new Response(JSON.stringify(validDocumentBody), {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-length': '999999' },
        });
        const originalGetReader = response.body!.getReader.bind(response.body);
        (response.body as unknown as { getReader: () => unknown }).getReader = () => {
          bodyRead = true;
          return originalGetReader();
        };
        return response;
      },
      lookupImpl: lookupResolvingTo(publicAddress),
    });
    expect(result).toBeNull();
    expect(bodyRead).toBe(false);
  });

  it('propagates a fetch-level failure (network error, timeout) as null', async () => {
    const result = await fetchClientIdMetadataDocument(validDocumentUrl, {
      fetchImpl: async () => {
        throw new Error('network unreachable');
      },
      lookupImpl: lookupResolvingTo(publicAddress),
    });
    expect(result).toBeNull();
  });

  it('caches a successful result and does not fetch again within the TTL', async () => {
    let fetchCount = 0;
    let currentTime = 1_000_000;
    const dependencies = {
      fetchImpl: async () => {
        fetchCount += 1;
        return jsonResponse(validDocumentBody);
      },
      lookupImpl: lookupResolvingTo(publicAddress),
      now: () => currentTime,
    };

    const first = await fetchClientIdMetadataDocument(validDocumentUrl, dependencies);
    expect(first).not.toBeNull();
    expect(fetchCount).toBe(1);

    const second = await fetchClientIdMetadataDocument(validDocumentUrl, dependencies);
    expect(second).not.toBeNull();
    expect(fetchCount).toBe(1);

    currentTime += 60 * 60 * 1000; // well past the cache TTL
    const third = await fetchClientIdMetadataDocument(validDocumentUrl, dependencies);
    expect(third).not.toBeNull();
    expect(fetchCount).toBe(2);
  });

  describe('SSRF protections', () => {
    it('rejects a client_id URL whose hostname is a literal loopback address', async () => {
      let fetchCalled = false;
      const result = await fetchClientIdMetadataDocument('https://127.0.0.1/client.json', {
        fetchImpl: async () => {
          fetchCalled = true;
          return jsonResponse(validDocumentBody);
        },
        lookupImpl: lookupResolvingTo(publicAddress),
      });
      expect(result).toBeNull();
      expect(fetchCalled).toBe(false);
    });

    it('rejects a client_id URL whose hostname is a literal cloud-metadata address', async () => {
      const result = await fetchClientIdMetadataDocument('https://169.254.169.254/client.json', {
        fetchImpl: async () => jsonResponse(validDocumentBody),
        lookupImpl: lookupResolvingTo(publicAddress),
      });
      expect(result).toBeNull();
    });

    it('rejects a client_id URL whose hostname is a literal RFC 1918 private address', async () => {
      const result = await fetchClientIdMetadataDocument('https://10.0.0.5/client.json', {
        fetchImpl: async () => jsonResponse(validDocumentBody),
        lookupImpl: lookupResolvingTo(publicAddress),
      });
      expect(result).toBeNull();
    });

    it('rejects a public-looking hostname that resolves (DNS rebinding) to a private address', async () => {
      let fetchCalled = false;
      const result = await fetchClientIdMetadataDocument(validDocumentUrl, {
        fetchImpl: async () => {
          fetchCalled = true;
          return jsonResponse(validDocumentBody);
        },
        lookupImpl: lookupResolvingTo({ address: '192.168.1.5', family: 4 }),
      });
      expect(result).toBeNull();
      expect(fetchCalled).toBe(false);
    });

    it('rejects a hostname when ANY resolved address is private, even if another is public', async () => {
      const result = await fetchClientIdMetadataDocument(validDocumentUrl, {
        fetchImpl: async () => jsonResponse(validDocumentBody),
        lookupImpl: lookupResolvingTo(publicAddress, { address: '127.0.0.1', family: 4 }),
      });
      expect(result).toBeNull();
    });

    it('rejects an IPv6 loopback/link-local literal', async () => {
      const loopback = await fetchClientIdMetadataDocument('https://[::1]/client.json', {
        fetchImpl: async () => jsonResponse(validDocumentBody),
        lookupImpl: lookupResolvingTo(publicAddress),
      });
      expect(loopback).toBeNull();

      const linkLocal = await fetchClientIdMetadataDocument('https://[fe80::1]/client.json', {
        fetchImpl: async () => jsonResponse(validDocumentBody),
        lookupImpl: lookupResolvingTo(publicAddress),
      });
      expect(linkLocal).toBeNull();
    });

    it('rejects a bracketed IPv6 loopback literal without ever consulting DNS', async () => {
      // Regression test for the bracket-stripping bug: `URL.hostname` for
      // `https://[::1]/x` is the literal string `"[::1]"`, not `"::1"`.
      // Before the fix, `isIPv6("[::1]")` returned false, so the check fell
      // through to `dns.lookup`, and this specific test's `lookupImpl`
      // (which ignores its hostname argument entirely, like production
      // `dns.lookup` cannot) would happily return a public address and let
      // the loopback literal through. Asserting `lookupImpl` is never
      // called is what distinguishes "correctly recognized as a literal
      // IPv6 address and blocked directly" from "coincidentally rejected
      // for an unrelated reason."
      let lookupCalled = false;
      const result = await fetchClientIdMetadataDocument('https://[::1]/client.json', {
        fetchImpl: async () => jsonResponse(validDocumentBody),
        lookupImpl: async () => {
          lookupCalled = true;
          return [publicAddress];
        },
      });
      expect(result).toBeNull();
      expect(lookupCalled).toBe(false);
    });

    it('accepts a bracketed public IPv6 literal client_id, fetching the document', async () => {
      // The inverse of the case above and the exact scenario the review
      // comment described: a valid public IPv6-literal Client ID Metadata
      // Document URL must not be rejected. Before the fix this returned
      // null unconditionally, because the bracketed hostname was neither
      // recognized as a literal IP (so never allow-listed) nor resolvable
      // by `dns.lookup` (so it always failed with `dns_resolution_failed`).
      const publicIpv6ClientId = 'https://[2606:4700:4700::1111]/client.json';
      let lookupCalled = false;
      const result = await fetchClientIdMetadataDocument(publicIpv6ClientId, {
        fetchImpl: async (input) => {
          expect(input instanceof Request ? input.url : input.toString()).toBe(publicIpv6ClientId);
          return jsonResponse({ ...validDocumentBody, client_id: publicIpv6ClientId });
        },
        lookupImpl: async () => {
          lookupCalled = true;
          return [publicAddress];
        },
      });
      expect(result).not.toBeNull();
      expect(result?.clientId).toBe(publicIpv6ClientId);
      // A literal IP address is never resolved via DNS; the IP-family
      // check on the (bracket-stripped) hostname must short-circuit it.
      expect(lookupCalled).toBe(false);
    });

    it('rejects when DNS resolution fails outright', async () => {
      const result = await fetchClientIdMetadataDocument(validDocumentUrl, {
        fetchImpl: async () => jsonResponse(validDocumentBody),
        lookupImpl: async () => {
          throw new Error('ENOTFOUND');
        },
      });
      expect(result).toBeNull();
    });

    it('bounds a DNS lookup that never resolves, instead of hanging past the fetch timeout budget', async () => {
      // Regression for a round-3 review finding (P2): the DNS phase had no deadline of its
      // own -- only the fetch that follows it was bounded by cimdFetchTimeoutMs. A stalled
      // resolver (or an attacker-controlled slow-responding name server) could hold this
      // preflight open indefinitely. `dnsTimeoutMs` lets this test exercise the real deadline
      // path without waiting out the production 5-second budget.
      let fetchWasCalled = false;
      const result = await fetchClientIdMetadataDocument(validDocumentUrl, {
        fetchImpl: async () => {
          fetchWasCalled = true;
          return jsonResponse(validDocumentBody);
        },
        lookupImpl: () => new Promise(() => {}), // never resolves or rejects
        dnsTimeoutMs: 25,
      });

      expect(result).toBeNull();
      expect(fetchWasCalled).toBe(false);
    });

    it('passes redirect: "error" to fetch so a redirect to an internal target cannot be followed', async () => {
      let observedRedirectMode: string | undefined;
      const result = await fetchClientIdMetadataDocument(validDocumentUrl, {
        fetchImpl: async (_input, init) => {
          observedRedirectMode = init?.redirect;
          return jsonResponse(validDocumentBody);
        },
        lookupImpl: lookupResolvingTo(publicAddress),
      });
      expect(result).not.toBeNull();
      expect(observedRedirectMode).toBe('error');
    });

    describe('DNS lookup resource bounding', () => {
      it('coalesces concurrent lookups for the same hostname into a single underlying dns.lookup call', async () => {
        // Two concurrent authorization requests for distinct CIMD document
        // URLs on the same hostname must not each start their own
        // uncancellable dns.lookup -- the second should reuse the first's
        // in-flight lookup rather than issuing a duplicate one.
        let lookupCallCount = 0;
        let resolveLookup!: (records: { address: string; family: number }[]) => void;
        const lookupImpl = () => {
          lookupCallCount += 1;
          return new Promise<{ address: string; family: number }[]>((resolve) => {
            resolveLookup = resolve;
          });
        };

        const firstUrl = 'https://app.example.com/oauth/client-one.json';
        const secondUrl = 'https://app.example.com/oauth/client-two.json';

        const firstPromise = fetchClientIdMetadataDocument(firstUrl, {
          fetchImpl: async () => jsonResponse({ ...validDocumentBody, client_id: firstUrl }),
          lookupImpl,
        });
        const secondPromise = fetchClientIdMetadataDocument(secondUrl, {
          fetchImpl: async () => jsonResponse({ ...validDocumentBody, client_id: secondUrl }),
          lookupImpl,
        });

        // Let both calls reach the (still-pending) lookup before resolving it.
        await Promise.resolve();
        await Promise.resolve();
        expect(lookupCallCount).toBe(1);

        resolveLookup([publicAddress]);
        const [first, second] = await Promise.all([firstPromise, secondPromise]);
        expect(first?.clientId).toBe(firstUrl);
        expect(second?.clientId).toBe(secondUrl);
        expect(lookupCallCount).toBe(1);
      });

      it('fails closed (rejects the authorization request) once the DNS lookup concurrency limit is saturated, instead of queuing', async () => {
        // Saturate the limiter with lookups for distinct hostnames that
        // never resolve -- simulating an attacker holding open many
        // uncancellable resolver operations at once, as the report
        // describes. A request that arrives once the limit is reached
        // must fail fast (mapped to "no usable document"), not queue
        // behind the saturating requests.
        let registered = 0;
        let resolveRegistered!: () => void;
        const allRegistered = new Promise<void>((resolve) => {
          resolveRegistered = resolve;
        });
        const releases: (() => void)[] = [];
        const stuckLookup = () =>
          new Promise<{ address: string; family: number }[]>((resolve) => {
            releases.push(() => resolve([]));
            if (++registered === 16) resolveRegistered();
          });

        const saturatingPromises = Array.from({ length: 16 }, (_, index) =>
          fetchClientIdMetadataDocument(
            `https://saturating-host-${index}.example.com/client.json`,
            {
              fetchImpl: async () => jsonResponse(validDocumentBody),
              lookupImpl: stuckLookup,
            },
          ),
        );

        await allRegistered;

        const overLimitResult = await fetchClientIdMetadataDocument(
          'https://one-too-many.example.com/client.json',
          {
            fetchImpl: async () => jsonResponse(validDocumentBody),
            lookupImpl: stuckLookup,
            dnsTimeoutMs: 5000,
          },
        );

        expect(overLimitResult).toBeNull();
        expect(registered).toBe(16);
        for (const release of releases) release();
        await Promise.all(saturatingPromises);
      });
    });
  });
});
