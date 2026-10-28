/**
 * Which requests the host answers with the application's shell. The client router owns every path
 * under the origin, so an address no route names still gets `index.html`, and the router renders
 * its not-found view inside the shell (`src/app/shell/route-outlet.svelte`) instead of the host
 * answering a bare 404.
 */
import { isEngineRequestPath } from './engine-proxy.ts';

/** The prefixes whose paths belong to something other than the router: a miss there is a 404. */
const NON_SHELL_PREFIXES = ['/__dev', '/assets', '/bureau', '/host'] as const;

function hasPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Whether an `Accept` header asks for `text/html`: a media range naming it whose quality is above
 * zero. `q=0` means "not acceptable", so `application/json, text/html;q=0` is a script's request
 * for JSON, not a page. A wildcard range does not count: a script's `fetch` sends the any-type
 * wildcard, and only a navigation names HTML.
 */
export function acceptsHtml(accept: string): boolean {
  return accept.split(',').some((range) => {
    const [mediaType, ...parameters] = range.split(';').map((part) => part.trim());
    if (mediaType?.toLowerCase() !== 'text/html') return false;
    for (const parameter of parameters) {
      const [name, value] = parameter.split('=').map((part) => part.trim());
      if (name?.toLowerCase() !== 'q') continue;
      // A quality that is not a number is malformed, so the range is not one to honor.
      const quality = Number(value);
      return Number.isFinite(quality) && quality > 0;
    }
    return true;
  });
}

/**
 * Whether a request no route matched is a document navigation to an address the router should
 * judge. A request for an asset, the engine, the Bureau, or the host's own endpoints is not, and
 * neither is a script's `fetch`, which does not ask for a page: only a request that accepts HTML
 * gets one, so a real miss on a file stays a 404.
 */
export function isShellNavigation(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const { pathname } = new URL(request.url);
  if (isEngineRequestPath(pathname)) return false;
  if (NON_SHELL_PREFIXES.some((prefix) => hasPrefix(pathname, prefix))) return false;
  return acceptsHtml(request.headers.get('accept') ?? '');
}
