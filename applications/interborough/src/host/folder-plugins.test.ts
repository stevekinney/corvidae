/**
 * COR-1881: the folder plugins. A plugin folder imports host packages through the `node_modules`
 * link the host makes in `plugins/` (probe A3), the folders load by name, and a folder that cannot
 * load is reported and never thrown.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { developmentPluginPaths } from './development-plugin-flag.ts';
import { HOST_DEPENDENCIES, loadFolderPlugins } from './folder-plugins.ts';

const scratchDirectories: string[] = [];

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A fresh directory: `import()` caches by path, so a path is used for one set of contents. */
function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'interborough-folder-plugins-'));
  scratchDirectories.push(directory);
  return directory;
}

const PLUGIN_SOURCE = (name: string): string =>
  `import { definePlugin } from '@lostgradient/interborough-plugin';
export default definePlugin({ name: '${name}', version: '1.0.0', description: 'The ${name} plugin.' });
`;

/**
 * A plugin that imports nothing: a development folder outside `plugins/` has no link to the host's
 * packages, and brings its own `node_modules` when it needs one.
 */
const PLAIN_SOURCE = (name: string): string =>
  `export default { name: '${name}', version: '1.0.0', description: 'The ${name} plugin.' };\n`;

/** Write `<directory>/<folder>/plugin.ts` holding `source`. */
function writePlugin(directory: string, folder: string, source: string): string {
  const path = join(directory, folder);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'plugin.ts'), source);
  return path;
}

const load = (directory: string | undefined, developmentPaths: string[] = []) =>
  loadFolderPlugins({ directory, dependencies: HOST_DEPENDENCIES, developmentPaths });

describe('a folder plugin in a Bungalow directory with no node_modules of its own', () => {
  test('imports @lostgradient/interborough-plugin through the link in plugins/', async () => {
    const directory = scratch();
    writePlugin(directory, 'alpha', PLUGIN_SOURCE('alpha'));

    const loaded = await load(directory);

    expect(loaded.failures).toEqual([]);
    expect(loaded.entries.map((entry) => [entry.descriptor.name, entry.source])).toEqual([
      ['alpha', 'folder'],
    ]);
    expect(readdirSync(join(directory, 'alpha'))).toEqual(['plugin.ts']);
    expect(readlinkSync(join(directory, 'node_modules'))).toBe(HOST_DEPENDENCIES);
  });

  test('loads the folders by name and ignores node_modules, dot-folders, and loose files', async () => {
    const directory = scratch();
    writePlugin(directory, 'zulu', PLUGIN_SOURCE('zulu'));
    writePlugin(directory, 'alpha', PLUGIN_SOURCE('alpha'));
    writePlugin(directory, '.hidden', PLUGIN_SOURCE('hidden'));
    writeFileSync(join(directory, 'notes.ts'), PLUGIN_SOURCE('notes'));

    const loaded = await load(directory);

    expect(loaded.failures).toEqual([]);
    expect(loaded.entries.map((entry) => entry.descriptor.name)).toEqual(['alpha', 'zulu']);
  });

  test('loads a folder that is a link to a directory', async () => {
    const directory = scratch();
    const elsewhere = writePlugin(scratch(), 'linked', PLAIN_SOURCE('linked'));
    symlinkSync(elsewhere, join(directory, 'linked'), 'dir');

    const loaded = await load(directory);

    expect(loaded.entries.map((entry) => entry.descriptor.name)).toEqual(['linked']);
  });
});

describe('the node_modules link', () => {
  test('replaces a link that points somewhere else', async () => {
    const directory = scratch();
    symlinkSync(scratch(), join(directory, 'node_modules'), 'dir');
    writePlugin(directory, 'alpha', PLAIN_SOURCE('alpha'));

    await load(directory);

    expect(readlinkSync(join(directory, 'node_modules'))).toBe(HOST_DEPENDENCIES);
  });

  test('is not made for a plugins directory that holds no plugin folder', async () => {
    const directory = scratch();

    const loaded = await load(directory);

    expect(loaded).toEqual({ entries: [], failures: [] });
    expect(readdirSync(directory)).toEqual([]);
  });

  test('leaves a real node_modules directory alone', async () => {
    const directory = scratch();
    mkdirSync(join(directory, 'node_modules'));
    writePlugin(directory, 'alpha', PLAIN_SOURCE('alpha'));

    const loaded = await load(directory);

    expect(loaded.failures).toEqual([]);
    expect(lstatSync(join(directory, 'node_modules')).isSymbolicLink()).toBe(false);
  });
});

describe('a folder that cannot be loaded', () => {
  test.each([
    [
      'has no plugin.ts',
      (directory: string) => mkdirSync(join(directory, 'empty')),
      'empty',
      'it has no plugin.ts',
    ],
    [
      'has no default export',
      (directory: string) => writePlugin(directory, 'bare', 'export const nothing = 1;\n'),
      'bare',
      'has no plugin as its default export',
    ],
    [
      'throws when it loads',
      (directory: string) =>
        writePlugin(directory, 'throws', "throw new Error('the plugin blew up');\n"),
      'throws',
      'the plugin blew up',
    ],
    [
      'declares a name definePlugin refuses',
      (directory: string) => writePlugin(directory, 'loud', PLUGIN_SOURCE('Loud Name')),
      'loud',
      'Plugin name "Loud Name"',
    ],
    [
      'is not valid TypeScript',
      (directory: string) => writePlugin(directory, 'broken', 'export default {\n'),
      'broken',
      'could not be loaded',
    ],
  ])('is reported, naming the folder, when it %s', async (_name, prepare, folder, expected) => {
    const directory = scratch();
    writePlugin(directory, 'fine', PLUGIN_SOURCE('fine'));
    prepare(directory);

    const loaded = await load(directory);

    expect(loaded.entries.map((entry) => entry.descriptor.name)).toEqual(['fine']);
    expect(loaded.failures).toHaveLength(1);
    expect(loaded.failures[0]?.location).toBe(join(directory, folder));
    expect(loaded.failures[0]?.message).toContain(
      `The plugin folder "${folder}" could not be loaded`,
    );
    expect(loaded.failures[0]?.message).toContain(expected);
  });
});

describe('a remote home', () => {
  test('has no plugins directory, so only the development folders load', async () => {
    const development = writePlugin(scratch(), 'dev', PLAIN_SOURCE('dev'));

    const loaded = await load(undefined, [development]);

    expect(loaded.entries.map((entry) => entry.descriptor.name)).toEqual(['dev']);
  });
});

describe('development folders', () => {
  test('load like folder plugins and are marked with the folder they came from', async () => {
    const development = writePlugin(scratch(), 'wip', PLAIN_SOURCE('wip'));

    const loaded = await load(scratch(), [development]);

    expect(loaded.failures).toEqual([]);
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0]).toMatchObject({
      source: 'folder',
      location: development,
      developmentPath: development,
    });
  });

  test('load once, marked, when the folder is also in plugins/', async () => {
    const directory = scratch();
    const folder = writePlugin(directory, 'both', PLUGIN_SOURCE('both'));

    const loaded = await load(directory, [folder]);

    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0]).toMatchObject({ developmentPath: folder });
  });

  test('that does not exist is reported, and the others still load', async () => {
    const missing = join(scratch(), 'missing');
    const development = writePlugin(scratch(), 'wip', PLAIN_SOURCE('wip'));

    const loaded = await load(undefined, [missing, development]);

    expect(loaded.entries.map((entry) => entry.descriptor.name)).toEqual(['wip']);
    expect(loaded.failures).toEqual([
      {
        location: missing,
        developmentPath: missing,
        message: `The development plugin folder "${missing}" does not exist.`,
      },
    ]);
  });
});

describe('developmentPluginPaths', () => {
  test('reads each --plugin path and resolves it', () => {
    expect(developmentPluginPaths([])).toEqual([]);
    expect(developmentPluginPaths(['--plugin', '/a', '--plugin', '/b'])).toEqual(['/a', '/b']);
  });

  test.each([[['--plugin']], [['--other', '/a']], [['--plugin', '']], [['/a']]])(
    'refuses %j',
    (argumentsList) => {
      expect(developmentPluginPaths(argumentsList)).toBeUndefined();
    },
  );
});
