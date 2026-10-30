/**
 * COR-1873 — a plugin's definitions as a read-only layer. The wrapped source holds files by their
 * bare stem (`triager`); the layer lists them as `plugin:name` (`linear:triager`), reports a
 * change to one under that identifier, and refuses every write and delete with a
 * {@link SourceReadOnlyError}. The files still reload when they change: the layer watches through
 * the wrapped source.
 *
 * @module plugin-layer
 */

import {
  IDENTIFIER_SEGMENT_SOURCE,
  isNamespacedIdentifier,
  RESERVED_NAMESPACES,
} from '../namespaced-identifier';
import {
  type DefinitionEntry,
  type DefinitionSource,
  type DefinitionSourceChange,
  SourceReadOnlyError,
} from './definition-source';

const PLUGIN_NAME_PATTERN = new RegExp(`^${IDENTIFIER_SEGMENT_SOURCE}$`);

/** Throw a `TypeError` unless `plugin` can name a plugin's namespace. */
export function assertPluginName(plugin: string): void {
  if (!PLUGIN_NAME_PATTERN.test(plugin)) {
    throw new TypeError(
      `"${plugin}" is not a plugin name: it must match ${PLUGIN_NAME_PATTERN.source}.`,
    );
  }
  if (RESERVED_NAMESPACES.includes(plugin)) {
    throw new TypeError(`"${plugin}" is reserved and cannot name a plugin.`);
  }
}

/**
 * `source` as the read-only layer of `plugin`. Every other property of `source` (its `kind`, an
 * agent source's `readSibling` and `tools`) is kept; the layer's own `load`, `watch`, `write`,
 * and `delete` replace the wrapped ones.
 */
export function pluginLayer<TSource extends DefinitionSource>(
  source: TSource,
  plugin: string,
): TSource {
  assertPluginName(plugin);
  if (source.plugin !== undefined) {
    throw new TypeError(`The source is already the layer of the plugin "${source.plugin}".`);
  }
  const qualify = (stem: string): string => `${plugin}:${stem}`;
  const refuse = (id: string): Promise<never> =>
    Promise.reject(new SourceReadOnlyError(isNamespacedIdentifier(id) ? id : qualify(id), plugin));
  const load = source.load.bind(source);
  const watch = source.watch.bind(source);
  const layer: DefinitionSource = {
    plugin,
    async load(): Promise<readonly DefinitionEntry[]> {
      const entries = await load();
      return entries.map((entry) => ({ ...entry, id: qualify(entry.id), plugin }));
    },
    watch(listener) {
      return watch((change: DefinitionSourceChange) =>
        listener({
          added: change.added.map(qualify),
          changed: change.changed.map(qualify),
          removed: change.removed.map(qualify),
        }),
      );
    },
    write: (id) => refuse(id),
    delete: (id) => refuse(id),
  };
  return { ...source, ...layer };
}
