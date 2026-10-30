/**
 * The `version` a saved tool source gives each tool it loads (COR-1950).
 *
 * Armorer binds an approval to the tool's id, which carries its version, and refuses to issue one
 * for a tool with none. A tool the loader builds from a server or a document has no version of its
 * own, so the loader derives one from what a person approves: a digest of
 *
 * - the tool's name and the source's `id`, so the same server saved twice is two tools;
 * - where a call goes: an MCP server's URL, or its command line and environment, and an OpenAPI
 *   service's resolved base URL (a changed destination is a changed tool, not the same one moved);
 * - what a call takes: the input schema, exactly as the server or the document gives it;
 * - what a call can do: an MCP tool's capability flags (`readOnly`, `mutates`, `dangerous`, mapped
 *   from its annotations), so a server cannot widen a tool from "mutating" to "dangerous" under an
 *   earlier approval, and an OpenAPI operation's method and path.
 *
 * It leaves out what does not change what an approval covers, or changes without a person's say:
 * the tool's description and title, the server's name and version, `_meta`, a credential's value,
 * the auth scheme, and the tool-name prefix (already part of the name). Descriptions inside the
 * input schema stay, because they are part of the schema as given.
 *
 * The digest is of canonical JSON (keys sorted by code unit, so no locale decides it), and nothing
 * in it is per-process, so an unchanged tool has the same version at every start.
 */
import { sha256HexSync } from '@lostgradient/cryptography';

import type { McpToolSourceDescription } from './index';

/** The characters of the digest kept: 128 bits, enough that no two tools meet by chance. */
const VERSION_LENGTH = 32;

/** The version for `material`: the first 128 bits of the SHA-256 of its canonical JSON. */
export function versionOfMaterial(material: unknown): string {
  return sha256HexSync(canonicalJson(material)).slice(0, VERSION_LENGTH);
}

/** JSON with every object's keys in code-unit order, and `undefined` members left out. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'null';
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map((entry) => (entry === undefined ? null : sortKeys(entry)));
  if (typeof value !== 'object' || value === null) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).toSorted()) {
    const entry: unknown = Reflect.get(value, key);
    if (entry !== undefined) {
      Object.defineProperty(sorted, key, {
        value: sortKeys(entry),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return sorted;
}

/** Entries ordered by key, so two records that differ only in key order digest the same. */
function sortedEntries(record: Readonly<Record<string, string>> | undefined): [string, string][] {
  return Object.entries(record ?? {}).toSorted(([left], [right]) => (left < right ? -1 : 1));
}

/**
 * Where an MCP source's calls go: the URL it is reached at, or the command it runs with its
 * arguments, working directory, and environment (a command sends what it is given wherever its
 * environment says, so the environment is part of the destination).
 */
export function mcpRecipient(transport: McpToolSourceDescription['transport']): unknown {
  return transport.type === 'http'
    ? ['http', transport.url]
    : [
        'stdio',
        transport.command,
        transport.args ?? [],
        transport.cwd ?? null,
        sortedEntries(transport.env),
        sortedEntries(transport.credentialEnv),
      ];
}
