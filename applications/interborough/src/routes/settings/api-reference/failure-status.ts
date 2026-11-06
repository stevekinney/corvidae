/**
 * The HTTP status a failed read of the API reference carries, for the words "The server answered
 * with an error (500)". A fault the Bureau answers (`HttpClientError`) and a discovery document the
 * server refuses (`DiscoveryFetchError`) both have one; an error that never reached the server, such
 * as a network failure, has none, and the page says the server didn't answer.
 */
export function failureStatusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { status } = error as { status?: unknown };
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
}
