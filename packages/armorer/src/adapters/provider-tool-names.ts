import { sha256HexSync } from '@lostgradient/cryptography';

import type { ToolIdentity } from '../core/identity';
import { type AdapterInput, normalizeToSerializedDefinitions } from './shared';

/**
 * The longest tool name every supported provider accepts. OpenAI and Gemini cap names at 64
 * characters, and Anthropic allows at least that many.
 */
export const PROVIDER_TOOL_NAME_LIMIT = 64;

const HASH_LENGTH = 8;

/**
 * Encodes a tool id (`namespace:name@version`) as a name every provider accepts: only letters,
 * digits, `_` and `-`, a letter or `_` first, and at most {@link PROVIDER_TOOL_NAME_LIMIT}
 * characters.
 *
 * Providers reject `:` and `@`, and an id can run past the length cap, so the id is sanitized,
 * clipped, and suffixed with a digest of the full id. Two ids that sanitize to the same text, or
 * share a long prefix, still get different names. The encoding is one way: map a provider's name
 * back with {@link createProviderToolNameMapper}.
 */
export function toProviderToolName(toolId: string): string {
  const sanitized = toolId.replace(/[^A-Za-z0-9_-]/g, '_');
  const leading = /^[A-Za-z_]/.test(sanitized) ? sanitized : `_${sanitized}`;
  const digest = sha256HexSync(toolId).slice(0, HASH_LENGTH);
  return `${leading.slice(0, PROVIDER_TOOL_NAME_LIMIT - HASH_LENGTH - 1)}_${digest}`;
}

/** What separates a namespace from a name in {@link toNamespacedToolName}'s result. */
export const NAMESPACED_TOOL_NAME_SEPARATOR = '__';

/** The namespace a tool without one is given, whose tools keep their bare name. */
const DEFAULT_NAMESPACE = 'default';

/**
 * The name the adapters' `'default'` naming gives a tool: its bare name in the default namespace,
 * and `<namespace>__<name>` in any other, so `a:search` and `b:search` reach a provider as
 * `a__search` and `b__search` rather than as one `search`. A toolbox resolves the result back to
 * the tool ({@link fromNamespacedToolName}), so no name mapper is needed for a call to run. Unlike
 * `'safe-id'`, the version is not part of it: a provider sees one name across a tool's versions.
 */
export function toNamespacedToolName(identity: Pick<ToolIdentity, 'namespace' | 'name'>): string {
  return identity.namespace === DEFAULT_NAMESPACE
    ? identity.name
    : `${identity.namespace}${NAMESPACED_TOOL_NAME_SEPARATOR}${identity.name}`;
}

/**
 * The `namespace` and `name` a {@link toNamespacedToolName} result stands for, read at its first
 * `__`, or `undefined` when `name` has no `__` with text on both sides.
 */
export function fromNamespacedToolName(
  name: string,
): { readonly namespace: string; readonly name: string } | undefined {
  const index = name.indexOf(NAMESPACED_TOOL_NAME_SEPARATOR);
  if (index < 1) return undefined;
  const rest = name.slice(index + NAMESPACED_TOOL_NAME_SEPARATOR.length);
  return rest === '' ? undefined : { namespace: name.slice(0, index), name: rest };
}

/**
 * Builds the function that turns a provider's tool name back into the tool id it was encoded
 * from, for the tools sent in that request. A name it did not encode passes through unchanged.
 * Throws when two of the tools encode to the same name, because a call could not tell them apart.
 */
export function createProviderToolNameMapper(tools: AdapterInput): (name: string) => string {
  const idsByName = new Map<string, string>();
  for (const { id } of normalizeToSerializedDefinitions(tools)) {
    const name = toProviderToolName(id);
    const existing = idsByName.get(name);
    if (existing !== undefined && existing !== id) {
      throw new Error(
        `Tools "${existing}" and "${id}" encode to the same provider name "${name}".`,
      );
    }
    idsByName.set(name, id);
  }
  return (name) => idsByName.get(name) ?? name;
}
