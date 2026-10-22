import type { McpUiResourceCsp } from '@modelcontextprotocol/ext-apps/app-bridge';

/**
 * A CSP source expression a resource may declare: a scheme and host (optionally with a leading
 * wildcard label, a port, and a path), and nothing else. Anything that could end the directive or
 * smuggle in another source (`;`, `,`, whitespace, quotes) fails the match and is dropped.
 */
const DECLARED_SOURCE =
  /^(?:https?|wss?):\/\/(?:\*\.)?[A-Za-z0-9.-]+(?::(?:\d{1,5}|\*))?(?:\/[^\s;,'"]*)?$/;

/** Keeps the declared origins that are well-formed CSP sources and drops the rest. */
export function sanitizeDeclaredSources(sources: unknown): string[] {
  // Server-supplied metadata: anything but an array of strings declares nothing.
  if (!Array.isArray(sources)) return [];
  return sources.filter(
    (source): source is string => typeof source === 'string' && DECLARED_SOURCE.test(source),
  );
}

function directive(name: string, values: readonly string[]): string {
  return `${name} ${values.length === 0 ? "'none'" : values.join(' ')}`;
}

/**
 * Builds the `Content-Security-Policy` for an MCP App document from the CSP its resource
 * declared. Without a declaration the policy is deny-all apart from the document's own inline
 * script and style and `data:`/`blob:` media, so the app can run but can reach no origin.
 */
export function buildMcpAppContentSecurityPolicy(declared: McpUiResourceCsp | undefined): string {
  const connect = sanitizeDeclaredSources(declared?.connectDomains);
  const resources = sanitizeDeclaredSources(declared?.resourceDomains).join(' ');
  const frames = sanitizeDeclaredSources(declared?.frameDomains);
  const base = sanitizeDeclaredSources(declared?.baseUriDomains);
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${resources}`.trim(),
    `style-src 'unsafe-inline' ${resources}`.trim(),
    `img-src data: blob: ${resources}`.trim(),
    `font-src data: ${resources}`.trim(),
    `media-src data: blob: ${resources}`.trim(),
    directive('connect-src', connect),
    directive('frame-src', frames),
    directive('base-uri', base),
    "object-src 'none'",
    "form-action 'none'",
  ].join('; ');
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

/**
 * Builds the `srcdoc` for an MCP App: the CSP `<meta>` comes first, ahead of every byte of the
 * app's HTML, and the head is left open so the app's own `<head>` and `<body>` parse as usual.
 */
export function buildMcpAppDocument(html: string, declared: McpUiResourceCsp | undefined): string {
  const policy = escapeAttribute(buildMcpAppContentSecurityPolicy(declared));
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}">${html}`;
}
