/**
 * The `toolSources` key of `configuration.json` (COR-1930): the MCP servers and OpenAPI services an
 * agent file may name tools from.
 *
 * ```json
 * {
 *   "toolSources": [
 *     {
 *       "source": {
 *         "id": "tracker",
 *         "kind": "mcp",
 *         "transport": {
 *           "type": "http",
 *           "url": "https://mcp.example.com/mcp",
 *           "authentication": { "type": "bearer", "credential": "token" }
 *         }
 *       }
 *     }
 *   ]
 * }
 * ```
 *
 * `source` is Armorer's `ToolSourceDescription` (`armorer/tool-sources`): plain JSON that names a
 * credential and never holds one. The credential's value is kept encrypted, apart from this file
 * (`tool-source-vault.ts`). Fields of the host's own sit beside `source`, never inside it, because
 * Armorer parses a description strictly. `tools` is reserved for them, keyed by the tool's own
 * (unqualified) name; it holds no field yet, and a field it does not know is refused rather than
 * ignored.
 *
 * ## Tool names
 *
 * An agent file names a source's tool as `<id>__<tool>`: the source's `id`, two underscores, and
 * the tool's own name with any character outside letters, digits, `_` and `-` replaced by `_`
 * ({@link qualifiedToolName}). An `id` is lowercase letters, digits and hyphens, so it never holds
 * `_`, and the first `__` always ends it: two sources, or a source and a built-in tool, can never
 * produce the same name, and Bureau's own tools (`workflows-…`, `settings-…`) hold no `__`. The
 * whole name stays within 64 characters, the shortest limit a model provider sets. A tool that
 * cannot be named that way, or whose name another tool of the same source has already taken, is
 * skipped and reported on the source; the rest still load. The name is a persisted contract: an
 * agent file stores it.
 *
 * The key is optional and an absent key means no sources, so a file written before the key
 * existed loads unchanged. Every other key of the file is left alone.
 *
 * @module tool-sources-configuration
 */

import { parseToolSourceDescription, type ToolSourceDescription } from 'armorer/tool-sources';

import { ProviderConfigurationError } from './provider-configuration-error.ts';

/**
 * A source's identifier: 1 to 20 lowercase letters, digits and hyphens, starting with a letter (a
 * tool name that began with a digit would be refused by Gemini). It is also the tail of the Bungalow secret that holds the source's credentials
 * (`tool-source-<id>`), and the 20-character limit leaves a tool name 42 characters of the 64 a
 * model provider allows.
 */
export const TOOL_SOURCE_IDENTIFIER = /^[a-z][a-z0-9-]{0,19}$/;

/** What separates a source's identifier from a tool's name in the name an agent file uses. */
export const TOOL_NAME_SEPARATOR = '__';

/** The longest tool name the host offers: the shortest limit among the model providers. */
export const MAXIMUM_TOOL_NAME_LENGTH = 64;

/** The host's own settings for one tool of a source. It holds no field yet. */
export type ConfiguredToolSettings = Readonly<Record<never, never>>;

/** One saved tool source. */
export type ConfiguredToolSource = {
  /** The description Armorer loads. It names credentials and holds none. */
  readonly source: ToolSourceDescription;
  /** The host's settings per tool, keyed by the tool's own name. Empty unless the file sets some. */
  readonly tools: ReadonlyMap<string, ConfiguredToolSettings>;
};

/** What an absent `toolSources` key means: no source. */
export const NO_TOOL_SOURCES: readonly ConfiguredToolSource[] = Object.freeze([]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The name an agent file uses for `toolName` of source `sourceId`, or the reason the tool cannot
 * be offered.
 */
export function qualifiedToolName(
  sourceId: string,
  toolName: string,
): { readonly name: string } | { readonly skipped: string } {
  const own = toolName.replace(/[^A-Za-z0-9_-]/g, '_');
  const name = `${sourceId}${TOOL_NAME_SEPARATOR}${own}`;
  if (toolName === '') return { skipped: 'the tool has no name.' };
  if (name.length > MAXIMUM_TOOL_NAME_LENGTH) {
    return {
      skipped: `its name is longer than ${MAXIMUM_TOOL_NAME_LENGTH} characters once qualified.`,
    };
  }
  return { name };
}

function parseEntry(entry: unknown, location: string, field: string): ConfiguredToolSource {
  if (!isPlainObject(entry)) {
    throw new ProviderConfigurationError(location, field, 'expected an object.');
  }
  for (const key of Object.keys(entry)) {
    if (key !== 'source' && key !== 'tools') {
      throw new ProviderConfigurationError(location, `${field}.${key}`, 'not a known field.');
    }
  }
  let source: ToolSourceDescription;
  try {
    source = parseToolSourceDescription(entry['source']);
  } catch (error) {
    // Armorer's message names the field and never a URL.
    throw new ProviderConfigurationError(
      location,
      `${field}.source`,
      error instanceof Error ? error.message : 'not a tool source description.',
    );
  }
  if (!TOOL_SOURCE_IDENTIFIER.test(source.id)) {
    throw new ProviderConfigurationError(
      location,
      `${field}.source.id`,
      'expected 1 to 20 lowercase letters, digits or hyphens, starting with a letter.',
    );
  }
  const tools = new Map<string, ConfiguredToolSettings>();
  const declared = entry['tools'];
  if (declared !== undefined) {
    if (!isPlainObject(declared)) {
      throw new ProviderConfigurationError(location, `${field}.tools`, 'expected an object.');
    }
    for (const [name, settings] of Object.entries(declared)) {
      if (!isPlainObject(settings)) {
        throw new ProviderConfigurationError(
          location,
          `${field}.tools.${name}`,
          'expected an object.',
        );
      }
      for (const key of Object.keys(settings)) {
        throw new ProviderConfigurationError(
          location,
          `${field}.tools.${name}.${key}`,
          'not a known field.',
        );
      }
      tools.set(name, Object.freeze({}));
    }
  }
  return { source, tools };
}

/**
 * Check the `toolSources` key of the parsed configuration, `value` being what the file holds under
 * it (`undefined` when it holds none). `location` names the file in an error. The message names
 * the field and never repeats a value.
 */
export function parseToolSourcesConfiguration(
  value: unknown,
  location: string,
): readonly ConfiguredToolSource[] {
  if (value === undefined) return NO_TOOL_SOURCES;
  if (!Array.isArray(value)) {
    throw new ProviderConfigurationError(location, 'toolSources', 'expected a list.');
  }
  const entries = value.map((entry: unknown, index) =>
    parseEntry(entry, location, `toolSources[${index}]`),
  );
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (seen.has(entry.source.id)) {
      throw new ProviderConfigurationError(
        location,
        `toolSources[${index}].source.id`,
        'another source has this identifier.',
      );
    }
    seen.add(entry.source.id);
  }
  return entries;
}

/**
 * The `toolSources` key of a configuration file's text: none for a file that is not there
 * (`undefined`) or has no such key. A file that is not a JSON object is refused.
 */
export function readToolSourcesConfiguration(
  text: string | undefined,
  location: string,
): readonly ConfiguredToolSource[] {
  if (text === undefined) return NO_TOOL_SOURCES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderConfigurationError(location, 'the file', 'it is not valid JSON.');
  }
  if (!isPlainObject(parsed)) {
    throw new ProviderConfigurationError(location, 'the file', 'expected a JSON object.');
  }
  return parseToolSourcesConfiguration(parsed['toolSources'], location);
}

/** The `toolSources` value to write for `sources`, in the shape {@link parseToolSourcesConfiguration} reads. */
export function serializeToolSources(sources: readonly ConfiguredToolSource[]): unknown[] {
  return sources.map(({ source, tools }) => ({
    source,
    ...(tools.size === 0 ? {} : { tools: Object.fromEntries(tools) }),
  }));
}
