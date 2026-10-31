/**
 * The development entry's `--plugin <path>` flag (COR-1881). It sits in a module of its own so the
 * supervisor, which only starts the host, does not load the plugin runtime to know the flag's name.
 *
 * @module development-plugin-flag
 */

import { resolve } from 'node:path';

/** The flag the development entry takes, once per plugin folder. */
export const DEVELOPMENT_PLUGIN_FLAG = '--plugin';

/**
 * The folders named by `--plugin <path>` in `argv`, absolute. `undefined` when an argument is not
 * a `--plugin` with a path after it, so the caller can print its usage line.
 */
export function developmentPluginPaths(argv: readonly string[]): string[] | undefined {
  const paths: string[] = [];
  for (let index = 0; index < argv.length; index += 2) {
    const path = argv[index + 1];
    if (argv[index] !== DEVELOPMENT_PLUGIN_FLAG || path === undefined || path === '') {
      return undefined;
    }
    paths.push(resolve(path));
  }
  return paths;
}
