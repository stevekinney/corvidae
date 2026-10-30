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
 * Armorer parses a description strictly. `tools` holds them per tool, keyed by the tool's own
 * (raw, unqualified) name as the server lists it, never by the `<id>__<tool>` name an agent file
 * uses: the raw name is stable across the naming rules below, which a later change may alter. It
 * has one field, `acceptsSecrets` (a boolean, off unless `true`): the host sets the tool's
 * `metadata.acceptsSecrets` from it when the source loads, which is what lets Armorer give the tool
 * the plaintext of a secret answer (COR-1816). A field it does not know is refused rather than
 * ignored. A name the server does not list is not an error: the source reports it as a diagnostic.
 *
 * ## Tool names
 *
 * An agent file names a source's tool as `<id>__<tool>`: the source's `id`, two underscores, and
 * the tool's own name ({@link qualifiedToolName}). An `id` is lowercase letters, digits and
 * hyphens, so it never holds `_`, and the first `__` always ends it: two sources, or a source and a
 * built-in tool, can never produce the same name, and Bureau's own tools (`workflows-…`,
 * `settings-…`) hold no `__`. The whole name stays within 64 characters, the shortest limit a model
 * provider sets.
 *
 * The name is a persisted contract: an agent file stores it, and a tool approval hangs on it. So
 * the mapping from a tool's own name to the name an agent file uses is a function of that name
 * alone, never of what else the server lists or in which order:
 *
 * - A name that is already made of letters, digits, `_` and `-`, fits, and does not end in a
 *   digest suffix is used as it is: `<id>__<tool>`.
 * - Any other name (a character outside that set, a name too long, or one that ends in `-` and
 *   eight hex digits) is `<id>__<readable>-<digest>`: `readable` is the name with each unsafe
 *   character replaced by `_`, cut so the whole stays within 64 characters, and `digest` is the
 *   first eight hex digits of the SHA-256 of the tool's own, raw name. `foo.bar` and `foo_bar`
 *   therefore never share a name, and neither changes when the other is added, dropped, or listed
 *   first. Every name made this way ends in the digest suffix and no name made the first way does,
 *   so the two forms never meet.
 * - Should two raw names still land on one name (a repeated name, or a digest collision), every one
 *   of them is skipped and reported on the source, never the first: whichever the server lists
 *   first must not decide which tool a stored name means. A tool with no name is skipped too. The
 *   rest still load.
 *
 * The key is optional and an absent key means no sources, so a file written before the key
 * existed loads unchanged. Every other key of the file is left alone.
 *
 * @module tool-sources-configuration
 */

import { createHash } from 'node:crypto';

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

/** The host's own settings for one tool of a source. */
export type ConfiguredToolSettings = {
  /**
   * Whether the tool may receive the plaintext of a secret answer. Off unless `true`; the host
   * sets `metadata.acceptsSecrets` on the tool from it (COR-1816).
   */
  readonly acceptsSecrets?: boolean;
};

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

/** A digest suffix: `-` and the eight hex digits {@link qualifiedToolName} appends to a name it changed. */
const DIGEST_SUFFIX = /-[0-9a-f]{8}$/;

/** How many characters of the SHA-256 of a tool's raw name its qualified name carries. */
const DIGEST_LENGTH = 8;

/**
 * The name an agent file uses for `toolName` of source `sourceId`, or the reason the tool cannot
 * be offered. The mapping depends on `toolName` alone (see the module comment); it does not detect
 * a collision, which {@link qualifyToolNames} does across a source's tools.
 */
export function qualifiedToolName(
  sourceId: string,
  toolName: string,
): { readonly name: string } | { readonly skipped: string } {
  if (toolName === '') return { skipped: 'the tool has no name.' };
  const prefix = `${sourceId}${TOOL_NAME_SEPARATOR}`;
  const readable = toolName.replace(/[^A-Za-z0-9_-]/g, '_');
  if (
    readable === toolName &&
    prefix.length + toolName.length <= MAXIMUM_TOOL_NAME_LENGTH &&
    !DIGEST_SUFFIX.test(toolName)
  ) {
    return { name: `${prefix}${toolName}` };
  }
  const digest = createHash('sha256').update(toolName).digest('hex').slice(0, DIGEST_LENGTH);
  // The readable part is cut, never the digest: a cut name must still be told from its siblings.
  const room = MAXIMUM_TOOL_NAME_LENGTH - prefix.length - 1 - DIGEST_LENGTH;
  return { name: `${prefix}${readable.slice(0, room)}-${digest}` };
}

/** What {@link qualifyToolNames} makes of a source's tools. */
export type QualifiedToolNames = {
  /** The tools offered, each with the name an agent file uses, in the order given. */
  readonly named: readonly { readonly tool: string; readonly name: string }[];
  /** The tools not offered, each with the reason. */
  readonly skipped: readonly { readonly tool: string; readonly reason: string }[];
};

/**
 * The names an agent file uses for all the tools `toolNames` a source lists. A name taken by more
 * than one tool is given to none of them, so the result does not depend on the order the server
 * lists its tools in.
 */
export function qualifyToolNames(
  sourceId: string,
  toolNames: readonly string[],
  qualify: typeof qualifiedToolName = qualifiedToolName,
): QualifiedToolNames {
  const qualified = toolNames.map((tool) => ({ tool, result: qualify(sourceId, tool) }));
  const holders = new Map<string, number>();
  for (const { result } of qualified) {
    if ('name' in result) holders.set(result.name, (holders.get(result.name) ?? 0) + 1);
  }
  const named: { tool: string; name: string }[] = [];
  const skipped: { tool: string; reason: string }[] = [];
  for (const { tool, result } of qualified) {
    if ('skipped' in result) {
      skipped.push({ tool, reason: result.skipped });
    } else if ((holders.get(result.name) ?? 0) > 1) {
      skipped.push({
        tool,
        reason: `more than one tool of this source would be named ${result.name}, so none of them is offered.`,
      });
    } else {
      named.push({ tool, name: result.name });
    }
  }
  return { named, skipped };
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
        if (key !== 'acceptsSecrets') {
          throw new ProviderConfigurationError(
            location,
            `${field}.tools.${name}.${key}`,
            'not a known field.',
          );
        }
      }
      const acceptsSecrets = settings['acceptsSecrets'];
      if (acceptsSecrets !== undefined && typeof acceptsSecrets !== 'boolean') {
        throw new ProviderConfigurationError(
          location,
          `${field}.tools.${name}.acceptsSecrets`,
          'expected true or false.',
        );
      }
      tools.set(name, Object.freeze(acceptsSecrets === undefined ? {} : { acceptsSecrets }));
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
