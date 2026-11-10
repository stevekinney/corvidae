/**
 * Turns the demo plugin on for a test home. The plugin is off by default (`enabled:
 * false`), so a test that talks to `demo:assistant` and the other scripted agents enables it with
 * `enableDemoPlugin` (`demo-plugin-home.ts`) before the host starts. This module holds the plugin
 * lists a test hands the host instead.
 */
import type { BureauPluginEntry } from '@lostgradient/bureau';
import { createDemoPlugin } from '@lostgradient/plugin-demo';

import { workspacePlugins } from './plugins.ts';

/**
 * The workspace's plugins with the demo plugin built without its seeding step, for a test that
 * wants the scripted agents but not the schedule and goal the plugin creates in `start`.
 * Pair it with `enableDemoPlugin` (`demo-plugin-home.ts`).
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
      ? { ...entry, descriptor: { ...entry.descriptor, enabled: true } }
      : entry,
  );
}
