export type BrowserAssetEvidence = {
  origin: string;
  csp: string;
  requests: Array<{ method: string; url: string; path: string }>;
  responses: Array<{ url: string; status: number; contentType: string }>;
  failures: string[];
};

const acceptedXtermCsp =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; script-src 'self'; connect-src 'self'";

export function validateBrowserAssetEvidence(evidence: BrowserAssetEvidence): boolean {
  if (evidence.csp !== acceptedXtermCsp || evidence.failures.length > 0) return false;
  const expected = new Map([
    ['/', 'text/html'],
    ['/candidate.css', 'text/css'],
    ['/probe.js', 'text/javascript'],
  ]);
  const origin = evidence.origin.replace(/\/$/, '');
  if (evidence.requests.length !== expected.size || evidence.responses.length !== expected.size)
    return false;
  if (
    evidence.requests.some(
      (request) =>
        request.method !== 'GET' ||
        !request.url.startsWith(`${origin}/`) ||
        !expected.has(request.path) ||
        new URL(request.url).origin !== origin,
    )
  )
    return false;
  return evidence.responses.every((response) => {
    const path = new URL(response.url).pathname;
    return (
      new URL(response.url).origin === origin &&
      response.status === 200 &&
      expected.get(path) === response.contentType.split(';', 1)[0]?.trim()
    );
  });
}
