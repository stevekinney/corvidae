/**
 * The plugins this host loads (COR-1880), and the `plugins` key of `configuration.json` that holds
 * the owner's choices about them:
 *
 * ```json
 * { "plugins": { "example": { "enabled": true, "configuration": { "limit": 3 } } } }
 * ```
 *
 * A plugin absent from the key takes its descriptor's `enabledByDefault` (itself `true` when the
 * descriptor leaves it out) and an empty configuration. Both fields are optional. Every other key
 * of the file is left alone, and an entry for a plugin the host does not load is kept and ignored,
 * so a plugin that is taken out of the workspace and put back finds its settings where it left them.
 *
 * @module plugins
 */

import type { BureauPluginEntry, BureauPluginSettings, PluginListing } from '@lostgradient/bureau';

import { ProviderConfigurationError } from './provider-configuration-error.ts';

/**
 * The plugins the workspace ships, in load order. `HostOptions.plugins` replaces this list for a
 * host that must load others, such as a test. There are none yet: a workspace plugin adds its
 * entry here, with `source: 'package'` and its package name as `location`.
 */
export function workspacePlugins(): readonly BureauPluginEntry[] {
  return [];
}

/** The fields an entry of the `plugins` key may hold. */
const ENTRY_FIELDS: ReadonlySet<string> = new Set(['enabled', 'configuration']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The `plugins` key of an already-parsed configuration document, checked: an object whose entries
 * are objects holding only `enabled` (a boolean) and `configuration`. An absent key means no
 * choices. A malformed one is refused naming the field, like every other key of the file.
 */
export function parsePluginSettings(
  document: Record<string, unknown>,
  path: string,
): Readonly<Record<string, BureauPluginSettings>> {
  const declared = document['plugins'];
  if (declared === undefined) return {};
  if (!isPlainObject(declared)) {
    throw new ProviderConfigurationError(path, 'plugins', 'expected an object.');
  }
  const settings: [string, BureauPluginSettings][] = [];
  for (const [name, entry] of Object.entries(declared)) {
    const field = `plugins.${name}`;
    if (!isPlainObject(entry)) {
      throw new ProviderConfigurationError(path, field, 'expected an object.');
    }
    for (const key of Object.keys(entry)) {
      if (!ENTRY_FIELDS.has(key)) {
        throw new ProviderConfigurationError(path, `${field}.${key}`, 'not a known field.');
      }
    }
    const enabled = entry['enabled'];
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      throw new ProviderConfigurationError(path, `${field}.enabled`, 'expected true or false.');
    }
    settings.push([
      name,
      {
        ...(enabled === undefined ? {} : { enabled }),
        ...(Object.hasOwn(entry, 'configuration') ? { configuration: entry['configuration'] } : {}),
      },
    ]);
  }
  // `fromEntries` defines each name as an own property, so a plugin named `__proto__` is not the prototype.
  return Object.fromEntries(settings);
}

/** The `plugins` key of the configuration `text`, or no choices when there is no file. */
export function readPluginSettings(
  text: string | undefined,
  path: string,
): Readonly<Record<string, BureauPluginSettings>> {
  if (text === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderConfigurationError(path, 'the file', 'it is not valid JSON.');
  }
  if (!isPlainObject(parsed)) {
    throw new ProviderConfigurationError(path, 'the file', 'expected a JSON object.');
  }
  return parsePluginSettings(parsed, path);
}

/** A model provider and the Bungalow secret that holds its API key. */
export type ProviderSecret = {
  /** The provider's name. */
  readonly name: string;
  /** The Bungalow secret key that holds its API key. */
  readonly secretKey: string;
};

/**
 * The providers `/host/paths` reports: those the plugins contribute, each with its first declared
 * secret (a provider has one API key), and the host's own for any name no plugin carries. A plugin
 * that carries a built-in provider's name replaces it, so the provider plugins that arrive with
 * COR-1884 take over without a second list.
 */
export function providerSecrets(
  listing: readonly PluginListing[],
  builtIn: readonly ProviderSecret[],
): readonly ProviderSecret[] {
  const names = new Set(listing.map((plugin) => plugin.descriptor.name));
  const contributed = listing.flatMap((plugin): ProviderSecret[] => {
    const key = plugin.descriptor.secrets[0]?.key;
    const providesModels = plugin.contributions.some((entry) => entry.kind === 'provider');
    return providesModels && key !== undefined
      ? [{ name: plugin.descriptor.name, secretKey: key }]
      : [];
  });
  return [...builtIn.filter((provider) => !names.has(provider.name)), ...contributed];
}
