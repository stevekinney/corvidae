/**
 * Turns the demo plugin on for a test home. The plugin is off by default (`enabledByDefault:
 * false`), so a test that talks to `demo:assistant` and the other scripted agents enables it in the
 * home's `configuration.json` before the host starts, keeping whatever the file already holds.
 */
import type { BureauPluginEntry } from '@lostgradient/bureau';
import { createDemoPlugin } from '@lostgradient/plugin-demo';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { workspacePlugins } from './plugins.ts';

/** Enable the demo plugin in `home`'s `configuration.json`, keeping every other key it holds. */
export async function enableDemoPlugin(home: string): Promise<void> {
  const path = join(home, 'configuration.json');
  let document: Record<string, unknown> = {};
  try {
    document = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const plugins = (document['plugins'] ?? {}) as Record<string, Record<string, unknown>>;
  plugins['demo'] = { ...plugins['demo'], enabled: true };
  await mkdir(home, { recursive: true });
  await writeFile(path, JSON.stringify({ ...document, plugins }));
}

/**
 * The workspace's plugins with the demo plugin built without its seeding step, for a test that
 * wants the scripted agents but not the schedule and goal the plugin creates in `afterStart`.
 * Pair it with {@link enableDemoPlugin}.
 */
export function pluginsWithUnseededDemo(): readonly BureauPluginEntry[] {
  return workspacePlugins().map((entry) =>
    entry.descriptor.name === 'demo'
      ? { ...entry, descriptor: createDemoPlugin({ seedOnStart: false }) }
      : entry,
  );
}

/**
 * The workspace's plugins with the demo plugin on by default, for a host whose configuration the
 * test does not write: a remote host keeps its `configuration.json` in the deployment's bucket.
 * A remote host also needs `INTERBOROUGH_SECRET_DEMO_APPROVAL_SECRET`, which it cannot generate.
 */
export function pluginsWithEnabledDemo(): readonly BureauPluginEntry[] {
  return workspacePlugins().map((entry) =>
    entry.descriptor.name === 'demo'
      ? { ...entry, descriptor: { ...entry.descriptor, enabledByDefault: true } }
      : entry,
  );
}
