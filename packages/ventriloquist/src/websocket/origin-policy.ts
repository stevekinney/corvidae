/**
 * Canonicalize an origin to its `scheme://host[:port]` tuple. The literal `null` (a sandboxed frame
 * or a `file:` page), an empty value, anything the URL parser rejects and anything that is not an
 * `http` or `https` origin return `undefined`, so none of them can ever match an allowlist entry.
 * The URL parser lowercases the host and elides a default port, so `https://Example.com:443` and
 * `https://example.com` compare equal. A path, query, fragment or credentials make a value a URL
 * rather than an origin and are refused too.
 */
export function canonicalizeOrigin(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'null') return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (parsed.pathname !== '/' && parsed.pathname !== '')
  ) {
    return undefined;
  }
  return parsed.origin;
}

/** Decides whether the `Origin` header of an upgrade request names an origin the host allows. */
export type OriginPolicy = (originHeader: string | null) => boolean;

/**
 * Build the origin check from an explicit allowlist. The allowlist is required: an empty list, a
 * wildcard, the literal `null` and any entry that is not a plain `http` or `https` origin are
 * refused at construction, because a policy that silently matched nothing (or everything) would
 * hide the mistake. A request with no `Origin` header, a `null` one or one that does not parse is
 * denied, so a non-browser client cannot skip the check by leaving the header out.
 */
export function createOriginPolicy(allowedOrigins: readonly string[]): OriginPolicy {
  if (allowedOrigins.length === 0) {
    throw new RangeError('allowedOrigins must name at least one origin');
  }
  const allowed = new Set<string>();
  for (const entry of allowedOrigins) {
    const canonical = canonicalizeOrigin(entry);
    if (canonical === undefined) {
      throw new RangeError(
        `allowedOrigins entry ${JSON.stringify(entry)} is not an http(s) origin`,
      );
    }
    allowed.add(canonical);
  }
  return (originHeader) => {
    if (originHeader === null) return false;
    const canonical = canonicalizeOrigin(originHeader);
    return canonical !== undefined && allowed.has(canonical);
  };
}
