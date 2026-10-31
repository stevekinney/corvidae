/**
 * Runs the plugin conformance checks against a folder plugin: `bun scripts/run-plugin-contract.ts
 * <plugin folder>`. The repository's `scripts/check-plugin.ts` runs it, because a root script
 * cannot import a workspace, and this script lives where Bureau and the plugin authoring package
 * resolve. The folder must be able to resolve its own imports (`check-plugin.ts` copies a plugin
 * into a scratch directory whose `node_modules` links the workspaces a plugin may use). The plugin
 * is `plugin.ts`'s default export. Prints each failed check and exits 1; exits 0 when the plugin
 * conforms.
 */
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { checkPluginContract } from '@lostgradient/interborough-plugin/testing';

import { createPluginTestHost } from '../src/testing/plugin-test-host.ts';

const directory = process.argv[2];
if (directory === undefined) {
  process.stderr.write('Usage: bun run-plugin-contract.ts <plugin folder>\n');
  process.exitCode = 2;
} else {
  const entry = join(resolve(directory), 'plugin.ts');
  const loaded: { default?: unknown } = await import(pathToFileURL(entry).href);
  const plugin = loaded.default;
  if (typeof plugin !== 'object' || plugin === null || !('name' in plugin)) {
    process.stderr.write(`${entry} must export a plugin as its default export.\n`);
    process.exitCode = 1;
  } else {
    const failures = await checkPluginContract(
      // The module is the plugin's own code; the contract's first check judges its shape.
      plugin as Parameters<typeof checkPluginContract>[0],
      { createHost: createPluginTestHost },
    );
    for (const { check, message } of failures) {
      process.stderr.write(`Plugin check failed: ${check}: ${message}\n`);
    }
    process.exitCode = failures.length === 0 ? 0 : 1;
  }
}
