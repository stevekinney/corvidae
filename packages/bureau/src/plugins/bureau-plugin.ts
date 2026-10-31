/**
 * COR-1890 — the built-in `bureau` plugin: the tools Bureau gives agents itself, contributed through
 * the plugin API like any other plugin's.
 *
 * It contributes `discover-agents` and, when the Bureau has a `workflowSource`, the five workflow
 * tools, so an agent file names them `bureau:discover-agents`, `bureau:workflows-create` and so on,
 * a provider calls them `bureau__discover-agents`, and a durable record pins
 * `bureau:discover-agents@1.0.0`. The plugin is `required`: the owner cannot turn it off. It is
 * composed before every plugin the host gives, so it holds the name `bureau`; a later plugin of that
 * name is `skipped` with `name-clash`, and a host tool in the `bureau` namespace is refused when the
 * Bureau is created. `createBureau` supplies the plugin itself; a host lists it (for its own plugin
 * management) with {@link BUREAU_PLUGIN_ENTRY} and never passes it in `plugins`.
 *
 * @module bureau-plugin
 */

import { definePlugin } from '@lostgradient/interborough-plugin';
import { fromNamespacedToolName, type AnyTool } from 'armorer';

import type { BureauPluginEntry } from './plugin-types';

/** The name of the built-in plugin, and the event `source` of the events its tools cause. */
export const BUREAU_PLUGIN_NAME = 'bureau';

/**
 * The version of the built-in plugin, which a tool of it that declares none takes onto its
 * identity (`discover-agents`). A durable record pins it, so it changes only with a change to what
 * such a tool does that a recorded call must not resume across.
 */
export const BUREAU_PLUGIN_VERSION = '1.0.0';

/** Where the built-in plugin comes from, as its listing names it. */
export const BUREAU_PLUGIN_LOCATION = '@lostgradient/bureau';

const BUREAU_PLUGIN_DESCRIPTION =
  'The tools Bureau gives agents itself: finding other agents and managing workflows.';

/**
 * The built-in plugin as a host lists it: its descriptor with no `setup`, because the tools are
 * built by the Bureau they read from. A host that manages plugins includes it so the plugin
 * appears with its standing and refuses to turn it off, and removes it again from the `plugins` it
 * gives `createBureau`, which supplies its own.
 */
export const BUREAU_PLUGIN_ENTRY: BureauPluginEntry = {
  descriptor: definePlugin({
    name: BUREAU_PLUGIN_NAME,
    version: BUREAU_PLUGIN_VERSION,
    description: BUREAU_PLUGIN_DESCRIPTION,
    required: true,
  }),
  source: 'built-in',
  location: BUREAU_PLUGIN_LOCATION,
};

/** The built-in plugin whose setup contributes `tools`, which `createBureau` builds over the Bureau itself. */
function createBureauPluginEntry(tools: readonly AnyTool[]): BureauPluginEntry {
  return {
    ...BUREAU_PLUGIN_ENTRY,
    descriptor: definePlugin({
      name: BUREAU_PLUGIN_NAME,
      version: BUREAU_PLUGIN_VERSION,
      description: BUREAU_PLUGIN_DESCRIPTION,
      required: true,
      setup: () => ({ tools: [...tools] }),
    }),
  };
}

/**
 * The first key of `tools` in the `bureau` namespace, either spelled `bureau:name` (as an agent file
 * names it) or `bureau__name` (as a provider calls it), or `undefined`. The namespace belongs to
 * the built-in plugin, so a host tool in it would hold a name the plugin needs.
 */
export function toolInBureauNamespace(
  tools: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  return Object.keys(tools ?? {}).find(
    (key) =>
      key.startsWith(`${BUREAU_PLUGIN_NAME}:`) ||
      fromNamespacedToolName(key)?.namespace === BUREAU_PLUGIN_NAME,
  );
}

/**
 * Refuses, through `refuse` (which throws), the options that would take the built-in plugin's
 * place: a host tool in the `bureau` namespace, and a host-supplied plugin with source `built-in`.
 */
export function validateBuiltInPluginOptions(
  options: {
    readonly agentSource?:
      { readonly tools?: Readonly<Record<string, unknown>> | undefined } | undefined;
    readonly plugins?: readonly BureauPluginEntry[] | undefined;
  },
  refuse: (message: string) => never,
): void {
  const inNamespace = toolInBureauNamespace(options.agentSource?.tools);
  if (inNamespace !== undefined) {
    refuse(
      `"options.agentSource.tools" names a tool "${inNamespace}" in the "${BUREAU_PLUGIN_NAME}" namespace, which is the built-in "${BUREAU_PLUGIN_NAME}" plugin's`,
    );
  }
  if (options.plugins?.some((entry) => entry.source === 'built-in') === true) {
    refuse(
      '"options.plugins" holds a plugin with source "built-in": Bureau supplies its built-in plugins itself, so a host lists them only for its own use',
    );
  }
}

/** `plugins` with the built-in plugin, contributing `tools`, ahead of them: the first plugin composed. */
export function withBuiltInPlugin(
  plugins: readonly BureauPluginEntry[] | undefined,
  tools: readonly AnyTool[],
): BureauPluginEntry[] {
  return [createBureauPluginEntry(tools), ...(plugins ?? [])];
}
