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

/**
 * A copy of `tool` that refuses to run once `refusal` returns a message, rebuilt the way
 * {@link withAcceptsSecrets} rebuilds one (COR-1931). A saved source's tools are connected to their
 * server with whatever the loader captured when it loaded (a key or token read once, a child
 * process's environment, an open session), and removing the source cannot reach into each
 * transport to take that back. The check sits where the host builds every saved source's tools, so
 * no kind of source (MCP over HTTP or stdio, OpenAPI from a URL or inline) can send a request, or
 * use a credential, after the host retired it. The configuration is copied whole, so the name,
 * description, schema, tags and metadata (the tier and approval metadata) are the original's.
 */
export function refusingWhen(tool: Tool, refusal: () => string | undefined): Tool {
  const refuseWhenRetired = (): void => {
    const reason = refusal();
    if (reason !== undefined) throw new Error(reason);
  };
  const execute = tool.configuration.execute;
  // A toolbox runs `rawExecute` when a configuration carries one, and `execute` otherwise, so both are guarded.
  const raw: unknown = Reflect.get(tool.configuration, 'rawExecute');
  const [rebuilt] = createToolbox([
    {
      ...tool.configuration,
      execute: async (params: unknown, context?: unknown) => {
        refuseWhenRetired();
        const run = await execute;
        return run(params, context);
      },
      ...(typeof raw === 'function'
        ? {
            rawExecute: async (params: unknown, context: unknown) => {
              refuseWhenRetired();
              return Reflect.apply(raw, undefined, [params, context]);
            },
          }
        : {}),
    },
  ]).tools();
  if (rebuilt === undefined) {
    throw new Error(`Tool "${tool.name}" could not be gated.`);
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
