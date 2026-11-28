import type { ServerLoadEvent } from '@lostgradient/velveteen/server';
import { resolveHostPrincipal } from '../../lib/scopes.svelte.ts';

export async function load(event: ServerLoadEvent) {
  const principal = await resolveHostPrincipal({}, event.fetch);
  if (!principal?.workspace) throw new Error('A workspace identity is required.');
  event.setHeaders({ 'cache-control': 'private, no-store' });
  return { address: event.url.href, principal };
}
