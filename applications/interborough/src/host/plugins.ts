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

import type { BureauPluginEntry, BureauPluginSettings } from '@lostgradient/bureau';
import anthropic from '@lostgradient/plugin-anthropic';
import gemini from '@lostgradient/plugin-gemini';
import inspectors from '@lostgradient/plugin-inspectors';
import openai from '@lostgradient/plugin-openai';
import typesafe from '@lostgradient/plugin-typesafe';

import { ProviderConfigurationError } from './provider-configuration-error.ts';

/**
 * The plugins the workspace ships, in load order. `HostOptions.plugins` replaces this list for a
 * host that must load others, such as a test. A workspace plugin adds its entry here, with
 * `source: 'package'` and its package name as `location`.
 */
export function workspacePlugins(): readonly BureauPluginEntry[] {
  return [
    { descriptor: anthropic, source: 'package', location: '@lostgradient/plugin-anthropic' },
    { descriptor: openai, source: 'package', location: '@lostgradient/plugin-openai' },
    { descriptor: gemini, source: 'package', location: '@lostgradient/plugin-gemini' },
    { descriptor: typesafe, source: 'package', location: '@lostgradient/plugin-typesafe' },
    { descriptor: inspectors, source: 'package', location: '@lostgradient/plugin-inspectors' },
  ];
}

/** The decision model the `decisions.model` setting defaults to: the typesafe plugin's Jev model. */
export const DEFAULT_DECISION_MODEL = 'typesafe:jev';

/**
 * The `decisions` option that makes {@link DEFAULT_DECISION_MODEL} the default of `decisions.model`,
 * or nothing when the typesafe plugin is not loaded or the owner disabled it, since Bureau refuses
 * a default that names a model no plugin contributed. The setting selects the model: the owner can
 * still choose `catalog`. Until the plugin's `typesafe-api-key` secret is saved a decision routed to
 * the model refuses, and saving it applies to the next decision.
 */
export function defaultDecisionOptions(
  entries: readonly BureauPluginEntry[],
  settings: Readonly<Record<string, BureauPluginSettings>>,
): { readonly decisions: { readonly model: string } } | Record<string, never> {
  const entry = entries.find((candidate) => candidate.descriptor.name === typesafe.name);
  if (entry === undefined) return {};
  const enabled = Object.hasOwn(settings, typesafe.name)
    ? settings[typesafe.name]?.enabled
    : undefined;
  if (enabled ?? entry.descriptor.enabledByDefault ?? true) {
    return { decisions: { model: DEFAULT_DECISION_MODEL } };
  }
  return {};
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
