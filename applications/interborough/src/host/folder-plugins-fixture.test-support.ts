/**
 * Run by `folder-plugins.slow.test.ts` in a Bun child that was started with `--no-install`: load
 * the plugin folders under the directory named by the first argument the way the host does, and
 * print what loaded and what did not as one line of JSON.
 */
import { HOST_DEPENDENCIES, loadFolderPlugins } from './folder-plugins.ts';

const directory = process.argv[2];
if (directory === undefined) throw new Error('The fixture needs a plugins directory.');

const loaded = await loadFolderPlugins({
  directory,
  dependencies: HOST_DEPENDENCIES,
  developmentPaths: [],
});
console.info(
  JSON.stringify({
    names: loaded.entries.map((entry) => entry.descriptor.name),
    failures: loaded.failures.map((failure) => failure.message),
  }),
);
