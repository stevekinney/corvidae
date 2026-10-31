/**
 * Folder plugins (COR-1881): the plugins the owner drops into Bungalow's `plugins/` folder, and the
 * ones a developer names with `--plugin <path>` on the development entry.
 *
 * - **Where they come from.** Each folder in `<bungalow>/plugins/` holds a `plugin.ts` whose default
 *   export is a plugin (`definePlugin`). `node_modules` and dot-folders are not plugins. Folders
 *   load by name, which is the order Bureau gives folder plugins.
 * - **Dependencies.** `<bungalow>/plugins/node_modules` is a link to the host's own
 *   `node_modules`, made when `plugins/` holds a plugin folder, so a plugin imports `@lostgradient/interborough-plugin` and the other packages
 *   the host depends on without an install of its own. A real directory the owner put there is left
 *   alone.
 * - **No install.** The host runs with `--no-install`, so an import of a package nothing provides
 *   fails with a message that names the specifier, and Bun contacts no registry.
 * - **A problem skips the plugin.** A folder that cannot be loaded is reported as a
 *   {@link FolderPluginFailure} and never stops the host. Plugin code loads once, at startup.
 * - **Development.** A `--plugin` path loads like a folder plugin and is marked
 *   `development-source`. Under `bun --watch`, an edit to its `plugin.ts` restarts the host.
 *
 * @module folder-plugins
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

import type { BureauPluginEntry } from '@lostgradient/bureau';
import { definePlugin, type PluginDescriptor } from '@lostgradient/interborough-plugin';
import type { z } from 'zod';

/** The file a plugin folder holds. Its default export is the plugin. */
export const PLUGIN_ENTRY_FILE = 'plugin.ts';

/** The name of Bungalow's content directory that holds the folder plugins. */
export const PLUGIN_FOLDER_NAME = 'plugins';

/** The host's own `node_modules`, which a folder plugin's `node_modules` links to. */
export const HOST_DEPENDENCIES = join(import.meta.dir, '..', '..', 'node_modules');

/** A plugin folder that could not be loaded. The host starts without it. */
export type FolderPluginFailure = {
  /** The folder, absolute. */
  readonly location: string;
  /** Set when the folder came from `--plugin`. */
  readonly developmentPath?: string;
  /** Why it could not be loaded, naming the folder and, for a failed import, the specifier. */
  readonly message: string;
};

/** What loading the folders produced. */
export type FolderPlugins = {
  /** The plugins that loaded, in folder-name order. */
  readonly entries: readonly BureauPluginEntry[];
  /** The folders that did not. */
  readonly failures: readonly FolderPluginFailure[];
};

/** What {@link loadFolderPlugins} reads. */
export type LoadFolderPluginsOptions = {
  /** `<bungalow>/plugins`, or `undefined` for a home with no local directory (a remote one). */
  readonly directory: string | undefined;
  /** The `node_modules` the folder `node_modules` links to. */
  readonly dependencies: string;
  /** Folders named with `--plugin`. Absolute or relative to the working directory. */
  readonly developmentPaths: readonly string[];
};

/** The message of anything thrown, including the resolver's own message objects. */
function messageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String(error.message);
  }
  return String(error);
}

/** The folder name that orders a plugin and names it in messages. */
function folderNameOf(location: string): string {
  return basename(location);
}

/** Whether `path` is a directory, following a link. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Make `<directory>/node_modules` a link to `dependencies`. Nothing is done when a real directory
 * or file is there, and a link to somewhere else is replaced. A failure to link is returned as
 * text, not thrown: the plugins that need the link then fail to import and say so.
 */
export function linkPluginDependencies(
  directory: string,
  dependencies: string,
): string | undefined {
  const link = join(directory, 'node_modules');
  try {
    let existing: ReturnType<typeof lstatSync> | undefined;
    try {
      existing = lstatSync(link);
    } catch {
      existing = undefined;
    }
    if (existing === undefined) {
      symlinkSync(dependencies, link, 'dir');
    } else if (existing.isSymbolicLink() && readlinkSync(link) !== dependencies) {
      unlinkSync(link);
      symlinkSync(dependencies, link, 'dir');
    }
    return undefined;
  } catch (error) {
    return `The plugin folder's node_modules link could not be made: ${messageOf(error)}`;
  }
}

/** The plugin folders under `directory`, by name: directories only, without `node_modules` or dot-folders. */
function folderNames(directory: string): string[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  return names
    .filter(
      (name) =>
        name !== 'node_modules' && !name.startsWith('.') && isDirectory(join(directory, name)),
    )
    .toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Whether `value` is an object that claims to be a descriptor: the checks `definePlugin` makes decide the rest. */
function isDescriptorLike(value: unknown): value is PluginDescriptor<z.ZodType> {
  return typeof value === 'object' && value !== null && 'name' in value && 'version' in value;
}

/** Import the plugin in `folder`, or say why it cannot be. Never throws. */
async function importPlugin(
  folder: string,
  developmentPath: string | undefined,
): Promise<BureauPluginEntry | FolderPluginFailure> {
  const failure = (message: string): FolderPluginFailure => ({
    location: folder,
    ...(developmentPath === undefined ? {} : { developmentPath }),
    message: `The plugin folder "${folderNameOf(folder)}" could not be loaded: ${message}`,
  });
  const file = join(folder, PLUGIN_ENTRY_FILE);
  if (!existsSync(file)) return failure(`it has no ${PLUGIN_ENTRY_FILE}.`);
  try {
    const loaded: { readonly default?: unknown } = await import(file);
    const candidate = loaded.default;
    if (!isDescriptorLike(candidate)) {
      return failure(`${PLUGIN_ENTRY_FILE} has no plugin as its default export.`);
    }
    // `definePlugin` returns the descriptor unchanged and refuses a malformed one.
    const descriptor = definePlugin(candidate);
    return {
      descriptor,
      source: 'folder',
      location: folder,
      ...(developmentPath === undefined ? {} : { developmentPath }),
    };
  } catch (error) {
    return failure(messageOf(error));
  }
}

/**
 * Load every plugin folder. Folders in `directory` come first by name, then the `--plugin` folders
 * that are not among them; a `--plugin` folder that is also in `directory` loads once, marked as
 * a development source. No folder throws: a failure is returned beside the plugins that loaded.
 */
export async function loadFolderPlugins(options: LoadFolderPluginsOptions): Promise<FolderPlugins> {
  const entries: BureauPluginEntry[] = [];
  const failures: FolderPluginFailure[] = [];
  const folders = new Map<string, { location: string; developmentPath?: string }>();
  if (options.directory !== undefined) {
    const names = folderNames(options.directory);
    // The link is made only for a home that has plugin folders, so a home without any has nothing
    // in `plugins/` that a scan of the home would walk into the host's whole dependency tree.
    const linkFailure =
      names.length === 0
        ? undefined
        : linkPluginDependencies(options.directory, options.dependencies);
    if (linkFailure !== undefined) {
      failures.push({ location: join(options.directory, 'node_modules'), message: linkFailure });
    }
    for (const name of names) {
      const location = join(options.directory, name);
      folders.set(realpathSync(location), { location });
    }
  }
  for (const given of options.developmentPaths) {
    const location = resolve(given);
    if (!isDirectory(location)) {
      failures.push({
        location,
        developmentPath: location,
        message: `The development plugin folder "${given}" does not exist.`,
      });
      continue;
    }
    const real = realpathSync(location);
    folders.set(real, {
      location: folders.get(real)?.location ?? location,
      developmentPath: location,
    });
  }
  for (const { location, developmentPath } of folders.values()) {
    const loaded = await importPlugin(location, developmentPath);
    if ('descriptor' in loaded) entries.push(loaded);
    else failures.push(loaded);
  }
  return { entries, failures };
}
