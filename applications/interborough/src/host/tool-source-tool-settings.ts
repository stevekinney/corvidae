/**
 * Applying the host's per-tool settings (`tools` of a `toolSources` entry, COR-1932) to the tools a
 * source loaded.
 *
 * `acceptsSecrets` is the metadata key Armorer reads to decide whether a tool may receive the
 * plaintext of a secret answer (COR-1816): `metadata.acceptsSecrets === true`, and nothing else. A
 * tool the owner has not flagged is left exactly as the loader made it, so it never carries the key
 * and a `{ secretRef }` in its arguments fails with `secret-not-accepted`.
 *
 * @module tool-source-tool-settings
 */

import { createToolbox, type Tool } from 'armorer';

import type { ConfiguredToolSettings } from './tool-sources-configuration.ts';

/**
 * A copy of `tool` whose metadata declares `acceptsSecrets: true`. The copy is made the way a
 * toolbox registers a tool (from its configuration, with the same execute function and every
 * other field), so nothing of the original is mutated and the rest of the configuration rides
 * along unchanged.
 */
export function withAcceptsSecrets(tool: Tool): Tool {
  const [rebuilt] = createToolbox([
    {
      ...tool.configuration,
      metadata: { ...tool.configuration.metadata, acceptsSecrets: true },
    },
  ]).tools();
  if (rebuilt === undefined) {
    throw new Error(`Tool "${tool.name}" could not be given acceptsSecrets.`);
  }
  return rebuilt;
}

/** A setting that names a tool the source does not offer. */
export type UnmatchedToolSetting = {
  /** The tool name the setting is keyed by. */
  readonly tool: string;
  /** Why the setting reached no tool, in words that hold no URL or value. */
  readonly message: string;
};

/**
 * The settings in `settings` that reach no tool: the server does not list the name, or lists it but
 * the host does not offer it (`skipped`). Nothing is applied to a different tool.
 */
export function unmatchedToolSettings(
  settings: ReadonlyMap<string, ConfiguredToolSettings>,
  offered: readonly string[],
  skipped: readonly { readonly tool: string; readonly reason: string }[],
): UnmatchedToolSetting[] {
  const listed = new Set(offered);
  const unmatched: UnmatchedToolSetting[] = [];
  for (const tool of settings.keys()) {
    if (!listed.has(tool)) {
      unmatched.push({ tool, message: 'the source does not list a tool with this name.' });
      continue;
    }
    const reason = skipped.find((entry) => entry.tool === tool)?.reason;
    if (reason !== undefined) {
      unmatched.push({
        tool,
        message: `the tool is not offered, so the setting is unused: ${reason}`,
      });
    }
  }
  return unmatched;
}
