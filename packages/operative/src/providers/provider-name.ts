import type { ProviderName } from './types.ts';

/**
 * The grammar every provider name follows, which is the plugin-name grammar: a leading lowercase
 * letter, then lowercase letters, digits and hyphens, ending in a letter or digit. A provider is
 * named by its plugin, bare (`anthropic`, never `plugin:anthropic`).
 *
 * Stored provider settings (`allowedProviders`, `deniedProviders`, a pinned `provider`), a
 * delegated grant's `grantedProviders` and a contributed catalog row's `provider` all validate
 * against this one pattern, so a name no loaded provider carries is still well formed and simply
 * resolves as unavailable.
 */
export const PROVIDER_NAME_PATTERN: RegExp = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Narrows `value` to a {@link ProviderName}: a string that matches {@link PROVIDER_NAME_PATTERN}.
 *
 * It says nothing about whether a provider of that name is loaded; a catalog or a registered
 * `ProviderDefinition` answers that.
 */
export function isProviderName(value: unknown): value is ProviderName {
  return typeof value === 'string' && PROVIDER_NAME_PATTERN.test(value);
}
