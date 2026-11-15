/**
 * A provider's configuration on the Models page: where it comes from, and what a draft of it means.
 * The schema is the one the Bureau reports for the provider's plugin (`bureau.plugins.contributions`),
 * and the stored value is the one Settings › Plugins edits (`GET /host/plugins`), so both pages are
 * two views of one fact.
 */
import type { ContributedProvider } from '../../../lib/bureau-plugin-kinds.ts';
import {
  contributedFormHasFields,
  contributedFormSchema,
} from '../../../lib/contributed-configuration.ts';
import type { PluginStanding } from '../../../lib/host-plugins.ts';
import { providerDisplayName } from './format-model.ts';

/** What the dialogs of one provider need to draw and save its plugin's configuration. */
export type ProviderConfigurationSource = {
  /** The provider's name, as the host's providers list has it. */
  readonly provider: string;
  /** The plugin that holds the configuration; `PUT /host/plugins/<plugin>` saves it. */
  readonly plugin: string;
  /** The plugin's name as a person reads it, for the words about its settings. */
  readonly title: string;
  /** The configuration's JSON Schema, or `null` when it could not be written as one. */
  readonly schema: Readonly<Record<string, unknown>> | null;
  /** The configuration the host stores. */
  readonly stored: unknown;
};

/**
 * The source of each provider that has a plugin the host lists, by provider name. A provider whose
 * plugin the host does not list has nothing to save to, so it has no entry.
 */
export function providerConfigurationSources(
  providers: readonly ContributedProvider[],
  plugins: readonly PluginStanding[],
): ReadonlyMap<string, ProviderConfigurationSource> {
  const sources = new Map<string, ProviderConfigurationSource>();
  for (const provider of providers) {
    const plugin = plugins.find((candidate) => candidate.descriptor.name === provider.plugin);
    if (plugin === undefined) continue;
    sources.set(provider.name, {
      provider: provider.name,
      plugin: provider.plugin,
      title: plugin.descriptor.title,
      schema: provider.configuration,
      stored: plugin.configuration,
    });
  }
  return sources;
}

/**
 * The name a person knows a provider by: its plugin's title ("Ollama"), else the name the page has
 * words for, else the identifier. A provider the page has no words for would read lowercase
 * (`ollama`) from `providerDisplayName` alone.
 */
export function providerTitle(
  provider: string,
  sources: ReadonlyMap<string, ProviderConfigurationSource>,
): string {
  return sources.get(provider)?.title ?? providerDisplayName(provider);
}

/** Whether the provider's plugin has a configuration field to draw: a provider with none has no settings to manage. */
export function hasSettingsToShow(source: ProviderConfigurationSource | undefined): boolean {
  return (
    source !== undefined &&
    contributedFormHasFields(contributedFormSchema(`provider:${source.provider}`, source.schema))
  );
}

/** A stored configuration as an object: anything else is `{}`, as the host reads it. */
export function configurationObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {};
}

/**
 * A configuration as the host keeps it: a field the form holds no value for (cleared text, a
 * cleared number, an emptied list) is left out, because an empty value is unset, and the host
 * refuses an allowlist with nothing in it.
 */
export function configurationWithoutEmpty(
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, field]) =>
        field !== undefined && field !== '' && !(Array.isArray(field) && field.length === 0),
    ),
  );
}

/**
 * The stored fields the form does not draw, which a save must keep: the configuration replaces
 * what is stored, so leaving one out would delete it. A schema that describes free keys draws them all.
 */
export function undrawnFields(
  stored: Readonly<Record<string, unknown>>,
  formSchema: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const additional = formSchema?.['additionalProperties'];
  if (typeof additional === 'object' && additional !== null) return {};
  const properties = formSchema?.['properties'];
  const drawn = typeof properties === 'object' && properties !== null ? properties : {};
  return Object.fromEntries(Object.entries(stored).filter(([key]) => !Object.hasOwn(drawn, key)));
}
