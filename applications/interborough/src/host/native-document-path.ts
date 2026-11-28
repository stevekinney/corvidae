const unownedPath = '/__unowned-interborough-document';

/** Preserve Interborough's literal static segments and existing nonempty plugin paths. */
export function nativeDocumentPath(url: URL): string {
  const pathname = url.pathname.replace(/\/{2,}/g, '/');
  try {
    decodeURIComponent(pathname);
  } catch {
    return unownedPath;
  }
  if (/^\/plugins\/[^/]+\/?$/.test(pathname)) return unownedPath;
  // Velveteen normally decodes before picking a route. Keep escapes until it has picked one so an
  // encoded dynamic identifier cannot become a literal static segment such as "new".
  return pathname.replaceAll('%', '%25');
}
