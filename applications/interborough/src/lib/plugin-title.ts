/**
 * The name a person knows a plugin by: its `title` ("GitHub"), which the host reports beside its
 * identifier (`github`). A page that names a plugin says the title, and says the identifier only
 * where it has nothing else to say and the caller allows it.
 */
import type { PluginsSnapshot } from './host-plugins.ts';

/**
 * The title of the plugin named `plugin`, or `undefined` while the host's plugins are not loaded or
 * when no loaded plugin has that name, so the caller chooses its own fallback.
 */
export function pluginTitle(
  plugin: string,
  snapshot: Pick<PluginsSnapshot, 'plugins'> | undefined,
): string | undefined {
  return snapshot?.plugins.find((standing) => standing.descriptor.name === plugin)?.descriptor
    .title;
}

/** The plugin a contributed kind belongs to: `github:webhook` is the `github` plugin's. */
export function kindPlugin(kind: string): string | undefined {
  const separator = kind.indexOf(':');
  return separator > 0 ? kind.slice(0, separator) : undefined;
}
