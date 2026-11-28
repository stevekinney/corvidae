import { isEngineRequestPath } from './engine-proxy.ts';

/** The prefixes whose paths belong to something other than the router: a miss there is a 404. */
const NON_DOCUMENT_PREFIXES = [
  '/__dev',
  '/assets',
  '/bureau',
  '/host',
  '/auth',
  '/oauth',
  '/.well-known',
  '/triggers',
  '/_remote',
  '/key-admin',
] as const;

function hasPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isNativeAssetPath(pathname: string): boolean {
  return hasPrefix(pathname, '/_assets');
}

/** Unclaimed reads go to Velveteen for documents, assets and 404s. */
export function isDocumentRequest(request: Request): boolean {
  if ((request.method !== 'GET' && request.method !== 'HEAD') || request.headers.has('upgrade'))
    return false;
  const { pathname } = new URL(request.url);
  return (
    !isEngineRequestPath(pathname) &&
    !NON_DOCUMENT_PREFIXES.some((prefix) => hasPrefix(pathname, prefix))
  );
}
