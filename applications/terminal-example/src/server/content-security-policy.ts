/**
 * The Content-Security-Policy the example sends with every response. It is the policy COR-483
 * proved the selected engine under (`documentation/terminal/security-and-budgets.md`): the engine
 * is `@xterm/xterm`, which needs `script-src 'self'` and no `'wasm-unsafe-eval'`, and the page's
 * one network destination is its own origin, so `connect-src 'self'` carries both the session
 * request and the WebSocket upgrade. `style-src` allows inline styles because Svelte injects the
 * component stylesheets and the engine positions its cells with style attributes. Everything else
 * is closed: no objects, no foreign base, no framing, no form posts.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "script-src 'self'",
  "connect-src 'self'",
].join('; ');

/** Headers every response carries, whatever it holds. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'cache-control': 'no-store',
};
