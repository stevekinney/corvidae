/**
 * COR-1873 — several definition sources as one. The owner's sources come first, in the order
 * given; each plugin's read-only layer ({@link pluginLayer}) sits beneath them. An owner's
 * definition has a bare identifier and a plugin's is `plugin:name`, so the two never collide; two
 * owner sources that hold the same identifier list the first one's.
 *
 * A write or delete of a bare identifier goes to the owner source that holds it, or, for a new
 * definition, to the first owner source. One of a `plugin:name` identifier is refused with a
 * {@link SourceReadOnlyError} without reaching any source.
 *
 * @module layered-source
 */

import { isNamespacedIdentifier } from '../namespaced-identifier';
import {
  type AgentSource,
  type DefinitionEntry,
  type DefinitionSource,
  type SiblingRead,
  SourceReadOnlyError,
  type WorkflowSource,
} from './definition-source';

/** The owner sources and plugin layers of a layered source, owners first. */
interface Layers<TSource extends DefinitionSource> {
  readonly owners: readonly TSource[];
  readonly plugins: ReadonlyMap<string, TSource>;
  readonly all: readonly TSource[];
}

function layersOf<TSource extends DefinitionSource>(sources: readonly TSource[]): Layers<TSource> {
  if (sources.length === 0) throw new TypeError('A layered source needs at least one source.');
  const owners: TSource[] = [];
  const plugins = new Map<string, TSource>();
  for (const source of sources) {
    if (source.plugin === undefined) {
      owners.push(source);
    } else if (plugins.has(source.plugin)) {
      throw new TypeError(`Two layers belong to the plugin "${source.plugin}".`);
    } else {
      plugins.set(source.plugin, source);
    }
  }
  return { owners, plugins, all: [...owners, ...plugins.values()] };
}

/** The first of `owners` that holds `id`, or `undefined` when none does. */
async function ownerHolding<TSource extends DefinitionSource>(
  owners: readonly TSource[],
  id: string,
): Promise<TSource | undefined> {
  for (const owner of owners) {
    const entries = await owner.load();
    if (entries.some((entry) => entry.id === id)) return owner;
  }
  return undefined;
}

/** The plugin a `plugin:name` identifier names. */
function namespaceOf(id: string): string {
  return id.slice(0, id.indexOf(':'));
}

function layeredDefinitionSource<TSource extends DefinitionSource>(
  layers: Layers<TSource>,
): DefinitionSource {
  /** Refuse a plugin's identifier, and an identifier no owner source can take. */
  function writable(id: string): TSource {
    if (isNamespacedIdentifier(id)) throw new SourceReadOnlyError(id, namespaceOf(id));
    const first = layers.owners[0];
    if (first === undefined) {
      throw new TypeError(`There is no owner source to write the definition "${id}" to.`);
    }
    return first;
  }

  return {
    attach(host) {
      for (const source of layers.all) source.attach?.(host);
    },

    async load(): Promise<readonly DefinitionEntry[]> {
      const loaded = await Promise.all(layers.all.map((source) => source.load()));
      const entries = new Map<string, DefinitionEntry>();
      for (const entry of loaded.flat()) {
        // An owner source's first holder of an identifier wins; a plugin's own `plugin:name` wins
        // over an owner file that names itself after it, which is invalid anyway.
        if (!entries.has(entry.id) || entry.plugin !== undefined) entries.set(entry.id, entry);
      }
      return [...entries.values()];
    },

    watch(listener) {
      const unsubscribes = layers.all.map((source) => source.watch(listener));
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },

    async write(id, bytes, options) {
      const first = writable(id);
      const target =
        options.expectedHash === null || layers.owners.length === 1
          ? first
          : ((await ownerHolding(layers.owners, id)) ?? first);
      return target.write(id, bytes, options);
    },

    async delete(id, options) {
      const first = writable(id);
      const target =
        layers.owners.length === 1 ? first : ((await ownerHolding(layers.owners, id)) ?? first);
      return target.delete(id, options);
    },
  };
}

/**
 * The agent sources `sources` as one {@link AgentSource}: owner sources first, in order, then each
 * plugin's read-only layer (COR-1873). The tool catalog is every source's `tools`, an earlier
 * source's tool winning a name; a reference document is read from the layer that holds the agent
 * naming it. Throws a `TypeError` for no sources, or two layers of one plugin.
 */
export function layeredAgentSource(sources: readonly AgentSource[]): AgentSource {
  const layers = layersOf(sources);
  const tools = Object.assign({}, ...layers.all.toReversed().map((source) => source.tools ?? {}));
  const polls = layers.all.flatMap((source) =>
    source.referencePollMilliseconds === undefined ? [] : [source.referencePollMilliseconds],
  );

  async function readSibling(
    path: string,
    options: {
      readonly limit: number;
      readonly unlessStamp?: string | undefined;
      readonly definitionId?: string | undefined;
    },
  ): Promise<SiblingRead> {
    const { definitionId } = options;
    let holder: AgentSource | undefined;
    if (definitionId !== undefined && isNamespacedIdentifier(definitionId)) {
      holder = layers.plugins.get(namespaceOf(definitionId));
    } else {
      // With one owner source there is nothing to choose, so nothing is scanned to choose it.
      if (definitionId !== undefined && layers.owners.length > 1) {
        holder = await ownerHolding(layers.owners, definitionId);
      }
      holder ??= layers.owners[0];
    }
    if (holder === undefined) return { kind: 'missing' };
    return holder.readSibling(path, options);
  }

  return {
    ...layeredDefinitionSource(layers),
    kind: 'agent',
    readSibling,
    ...(Object.keys(tools).length === 0 ? {} : { tools }),
    ...(polls.length === 0 ? {} : { referencePollMilliseconds: Math.min(...polls) }),
  };
}

/**
 * The workflow sources `sources` as one {@link WorkflowSource}: owner sources first, in order,
 * then each plugin's read-only layer (COR-1873). Throws a `TypeError` for no sources, or two
 * layers of one plugin.
 */
export function layeredWorkflowSource(sources: readonly WorkflowSource[]): WorkflowSource {
  return { ...layeredDefinitionSource(layersOf(sources)), kind: 'workflow' };
}
