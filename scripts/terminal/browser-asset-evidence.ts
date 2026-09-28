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
  const requestCounts = new Map<string, number>();
  for (const request of evidence.requests) {
    if (
      request.method !== 'GET' ||
      !request.url.startsWith(`${origin}/`) ||
      !expected.has(request.path) ||
      new URL(request.url).origin !== origin ||
      new URL(request.url).pathname !== request.path
    )
      return false;
    requestCounts.set(request.path, (requestCounts.get(request.path) ?? 0) + 1);
  }
  if ([...expected.keys()].some((path) => requestCounts.get(path) !== 1)) return false;
  const responseCounts = new Map<string, number>();
  return (
    evidence.responses.every((response) => {
      const path = new URL(response.url).pathname;
      responseCounts.set(path, (responseCounts.get(path) ?? 0) + 1);
      return (
        new URL(response.url).origin === origin &&
        response.status === 200 &&
        expected.get(path) === response.contentType.split(';', 1)[0]?.trim()
      );
    }) && [...expected.keys()].every((path) => responseCounts.get(path) === 1)
  );
}
