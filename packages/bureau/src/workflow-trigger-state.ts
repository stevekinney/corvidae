/**
 * COR-2164 — the durable state a contributed trigger keeps for one workflow file.
 *
 * A trigger's `start` receives a `storage` confined to
 * `plugin:<plugin>:trigger:<trigger-name>:<workflow-id>:` of the plugin's own store, where
 * `<workflow-id>` is the Weft form of the file's identifier (`stem`, or `plugin__stem` for a
 * plugin's own file). The Weft form keeps the segment free of `:`, so the prefix of file `foo`
 * never contains the prefix of the plugin file `foo:bar`, which is `foo__bar`. An owner's stem
 * cannot contain `_`, and neither can a plugin or a name, so the mapping is injective.
 *
 * The state outlives a restart, a pause, a configuration edit and a plugin upgrade. It goes when
 * its file goes, or when the file's trigger becomes another kind ({@link sweepTriggerState}).
 *
 * @module workflow-trigger-state
 */

import { createPluginStorage, pluginStoragePrefix } from '@lostgradient/interborough-plugin';
import {
  scopedStorage,
  storageDeletePrefix,
  storageKeys,
  type Storage,
} from '@lostgradient/storage';

import { fromWeftName, weftNameOf } from './namespaced-identifier';

/** The segment `trigger:` that follows a plugin's own prefix. */
const TRIGGER_NAMESPACE = 'trigger';

/** The plugin and the trigger name of a `plugin:name` kind, which a file's `trigger.kind` names. */
function splitKind(kind: string): { readonly plugin: string; readonly name: string } {
  const separator = kind.indexOf(':');
  if (separator <= 0 || separator !== kind.lastIndexOf(':') || separator === kind.length - 1) {
    throw new TypeError(`The trigger kind "${kind}" is not a plugin:name identifier.`);
  }
  return { plugin: kind.slice(0, separator), name: kind.slice(separator + 1) };
}

/**
 * The key prefix of the state of trigger `kind` for workflow `workflowId`, in the backing store:
 * `plugin:<plugin>:trigger:<trigger-name>:<workflow-id>:`. Throws when the plugin of `kind` is not
 * a valid plugin name.
 */
export function triggerStatePrefix(kind: string, workflowId: string): string {
  const { plugin, name } = splitKind(kind);
  return `${pluginStoragePrefix(plugin)}${TRIGGER_NAMESPACE}:${name}:${weftNameOf(workflowId)}:`;
}

/**
 * The storage a trigger kind `kind` receives for workflow `workflowId`: every key it writes lands
 * under {@link triggerStatePrefix}, and it reads nothing outside it.
 */
export function createTriggerStorage(backing: Storage, kind: string, workflowId: string): Storage {
  const { plugin, name } = splitKind(kind);
  return scopedStorage(
    createPluginStorage(backing, plugin),
    `${TRIGGER_NAMESPACE}:${name}:${weftNameOf(workflowId)}`,
  );
}

/**
 * Delete the trigger state nothing owns any more, for each of `plugins`.
 *
 * `files` has an entry for every workflow file the catalog lists, ready or not: its trigger kind
 * when the file could be read, and `undefined` when it is `invalid` or unreadable. State is kept
 * while its file is listed and either names the same trigger kind or cannot be judged, so a file
 * that is being edited, paused, or written by a newer Bureau keeps it. It is deleted when no file
 * has the identifier, or when the file's trigger is another kind, including another kind of the
 * same plugin, so the file starts the new kind with empty state.
 *
 * The rule: state is swept only when every party that could bring the file back is present and
 * the file is still absent. Three parties are checked.
 *
 * - The kind's plugin: only the plugins in `plugins` are swept, so the keys of a plugin that is not
 *   loaded stay until it loads and a sweep runs.
 * - The plugin that ships the file: a plugin file `shipper:digest` is `shipper__digest` in the
 *   key, and a plugin ships content only while it is running. When `shipper` is not in
 *   `runningPlugins` (disabled, its setup failed, not loaded) its file may be absent only for this
 *   start, so its state stays; it is deleted only while `shipper` runs and still lists no such file.
 * - The owner's scan: an owner file has no namespace, and `files` is read from a scan that
 *   succeeded (the caller passes none otherwise), so an absent owner file is deleted.
 *
 * A failure is reported through `diagnose` and never thrown, because leftover keys are harmless
 * and a reconcile must go on.
 */
export async function sweepTriggerState(options: {
  readonly storage: Storage;
  readonly plugins: Iterable<string>;
  /** The plugins that are running this start, and so would ship their content files. */
  readonly runningPlugins: ReadonlySet<string>;
  readonly files: ReadonlyMap<string, string | undefined>;
  readonly diagnose: (message: string, cause: unknown) => void;
}): Promise<void> {
  const { storage, files, diagnose, runningPlugins } = options;
  const kindOfSegment = new Map<string, string | undefined>();
  for (const [id, kind] of files) kindOfSegment.set(weftNameOf(id), kind);
  for (const plugin of options.plugins) {
    try {
      const namespace = `${pluginStoragePrefix(plugin)}${TRIGGER_NAMESPACE}:`;
      const orphaned = new Set<string>();
      for await (const key of storageKeys(storage, namespace)) {
        // `<trigger-name>:<workflow-segment>:<key>`: a key of another shape is the plugin's own.
        const parts = key.slice(namespace.length).split(':');
        if (parts.length < 3) continue;
        const [name, segment] = parts as [string, string];
        if (!kindOfSegment.has(segment)) {
          const shipper = fromWeftName(segment)?.split(':')[0];
          if (shipper === undefined || runningPlugins.has(shipper)) {
            orphaned.add(`${name}:${segment}`);
          }
          continue;
        }
        const kind = kindOfSegment.get(segment);
        if (kind !== undefined && kind !== `${plugin}:${name}`) orphaned.add(`${name}:${segment}`);
      }
      for (const owner of orphaned) {
        await storageDeletePrefix(storage, `${namespace}${owner}:`);
      }
    } catch (error) {
      diagnose(
        `Could not remove the trigger state of plugin "${plugin}" that no file owns.`,
        error,
      );
    }
  }
}
