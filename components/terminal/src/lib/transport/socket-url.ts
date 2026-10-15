const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Parameter names that suggest a credential. The server refuses them too; here they never get that far. */
const CREDENTIAL_PARAMETER =
  /token|secret|password|passwd|auth|credential|cookie|api[-_]?key|^key$/i;

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
  for (const name of parsed.searchParams.keys()) {
    if (CREDENTIAL_PARAMETER.test(name)) {
      throw new TypeError(`url must not carry a credential parameter (${name})`);
    }
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
