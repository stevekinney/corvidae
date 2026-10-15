const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Check the address before a socket is made from it. The address may name where to connect and
 * which profile to run, and nothing that grants access: credentials travel in the host's HttpOnly
 * session cookie, never in a URL a log, a history entry or a referrer could keep.
 */
export function validateSocketUrl(address: string, allowInsecureLoopback: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    throw new TypeError('url must be an absolute ws: or wss: address');
  }
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
    throw new TypeError('url must use the ws: or wss: scheme');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new TypeError('url must not carry credentials; the host sets an HttpOnly cookie');
  }
  // An allowlist, not a denylist: a list of credential names is always one short. The address
  // names the profile and nothing else, and the server refuses any other key as well.
  for (const name of parsed.searchParams.keys()) {
    if (name !== 'profile') {
      throw new TypeError('url may carry only the profile parameter');
    }
  }
  if (parsed.searchParams.getAll('profile').length !== 1) {
    throw new TypeError('url must carry exactly one profile parameter');
  }
  if (parsed.protocol === 'ws:') {
    const loopback =
      LOOPBACK_NAMES.has(parsed.hostname) || /^127(\.\d{1,3}){3}$/.test(parsed.hostname);
    if (!allowInsecureLoopback || !loopback) {
      throw new TypeError(
        'a plain ws: address is allowed only to a loopback host, and only when allowInsecureLoopback is set',
      );
    }
  }
  return parsed.href;
}
