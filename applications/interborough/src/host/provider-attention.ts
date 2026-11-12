/**
 * The Needs attention item only the host can see (COR-2009): no model provider is connected, so an
 * agent that needs a model cannot answer. The Bureau reads it through `BureauOptions.attention` on
 * every `bureau.health.attention` call, beside the problems it finds itself.
 *
 * A provider counts as connected while the host's catalog holds at least one of its models that is
 * not `unavailable`: a row kept for a provider whose key is missing does not count. The
 * item's time and provider are those of the newest `provider.disconnected` audit entry, which the
 * provider manager writes when a key is removed, so the page can say "The Anthropic key was removed
 * at 10:45 AM"; on a home where no key was ever removed both are `null`.
 *
 * @module provider-attention
 */

import type { AuditTrail, BureauAttentionItem } from '@lostgradient/bureau';
import type { BackendDescriptor } from '@lostgradient/operative/provider-kit';

/** The audit entry the provider manager writes when a provider's key is removed. */
const PROVIDER_DISCONNECTED = 'provider.disconnected';

/** What {@link providerAttention} reads: the catalog's rows, and the audit trail. */
export interface ProviderAttentionSources {
  /** The rows the host's catalog holds now, whatever their availability. */
  readonly rows: () => readonly Pick<BackendDescriptor, 'availability'>[];
  /** The Bureau's audit trail, or `undefined` when it keeps none. */
  readonly auditTrail: () => AuditTrail | undefined;
}

function providerOf(detail: unknown): string | null {
  if (typeof detail !== 'object' || detail === null) return null;
  const provider: unknown = Reflect.get(detail, 'provider');
  return typeof provider === 'string' && provider !== '' ? provider : null;
}

/** The `no-provider` item when no model provider is connected, else nothing. */
export async function providerAttention(
  sources: ProviderAttentionSources,
): Promise<readonly BureauAttentionItem[]> {
  if (sources.rows().some((row) => row.availability !== 'unavailable')) return [];
  const [removed] =
    (await sources
      .auditTrail()
      ?.query({ type: PROVIDER_DISCONNECTED, select: 'newest', limit: 1 })) ?? [];
  return [
    {
      kind: 'no-provider',
      area: 'providers',
      at: removed?.timestampMs ?? null,
      provider: providerOf(removed?.detail),
    },
  ];
}
