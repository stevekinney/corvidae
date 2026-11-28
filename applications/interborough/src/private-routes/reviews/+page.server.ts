import { validatedReviewsTransport } from '@lostgradient/bureau-sdk/reviews';
import type { ServerLoadEvent } from '@lostgradient/velveteen/server';
import { bureauTransport } from '../../lib/bureau-transport.ts';
import { principalQueryScope, resolveHostPrincipal } from '../../lib/scopes.svelte.ts';

const inputs = [
  { status: 'pending', limit: 100 },
  { status: 'resolved', limit: 25 },
] as const;

/** Read the authenticated opening pages under this document request's pinned authority. */
export async function load(event: ServerLoadEvent) {
  const principal = await resolveHostPrincipal({}, event.fetch);
  if (principal?.method !== 'browser-session' || !principal.workspace)
    throw new Error('A browser workspace session is required');
  const call = validatedReviewsTransport(bureauTransport({ baseUrl: '', fetch: event.fetch }));
  const entries = await Promise.all(
    inputs.map(async (input) => ({
      input,
      data: await call('bureau.reviews.list', input, { signal: event.signal }),
    })),
  );
  event.setHeaders({ 'cache-control': 'private, no-store' });
  return {
    address: event.url.href,
    principal,
    seed: { scope: JSON.stringify(principalQueryScope(principal)), entries },
  };
}
