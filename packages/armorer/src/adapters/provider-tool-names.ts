import { sha256HexSync } from '@lostgradient/cryptography';

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
