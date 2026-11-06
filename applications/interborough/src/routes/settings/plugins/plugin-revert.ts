/**
 * Putting plugins back to what the running host loaded, which is what Revert on the restart notice
 * does for the plugins among the waiting changes: each one's stored choices are written again as
 * the host reports it runs them (`PluginStanding.running`), so nothing waits for a restart.
 */
import { updatePlugin, type PluginStanding } from '../../../lib/host-plugins.ts';

/**
 * The choices that put `plugin` back: whether it runs, and its configuration, or `null` (which
 * removes the stored one) when the running host loaded none.
 */
export function runningChoices(plugin: PluginStanding): {
  readonly enabled: boolean;
  readonly configuration: unknown;
} {
  const { enabled, configuration } = plugin.running;
  const empty =
    typeof configuration === 'object' &&
    configuration !== null &&
    Object.keys(configuration).length === 0;
  return { enabled, configuration: empty ? null : configuration };
}

/**
 * Writes the running choices of every plugin in `plugins` whose stored choices differ from them
 * (`restartRequired`), one after another.
 *
 * @throws {HostPluginError} When the host refuses a write; the plugins before it are already put back.
 */
export async function revertPlugins(plugins: readonly PluginStanding[]): Promise<void> {
  for (const plugin of plugins) {
    if (!plugin.restartRequired) continue;
    await updatePlugin(plugin.descriptor.name, runningChoices(plugin));
  }
}
