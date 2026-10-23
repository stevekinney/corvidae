/**
 * Which requests the host answers with the application's shell. The client router owns every path
 * under the origin, so an address no route names still gets `index.html`, and the router renders
 * its not-found view inside the shell (`src/app/shell/route-outlet.svelte`) instead of the host
 * answering a bare 404.
 */
import { isEngineRequestPath } from './engine-proxy.ts';

/** The prefixes whose paths belong to something other than the router: a miss there is a 404. */
const NON_SHELL_PREFIXES = ['/assets', '/bureau', '/host'] as const;

function hasPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
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
  return (request.headers.get('accept') ?? '').toLowerCase().includes('text/html');
}
