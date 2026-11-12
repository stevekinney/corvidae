<script lang="ts">
  /**
   * `/settings/plugins`: the plugins Interborough loaded at startup, with the open one beside the
   * list (board PageSettingsSections, "Plugins, /settings/plugins"). The body is
   * `plugins-body.svelte`; this is the Settings frame around it, with the section navigation, the
   * heading and the settings the restart notice counts. The page reads `GET /host/plugins` here, so
   * the read starts with the page and not once the settings are in.
   */
  import { createQuery } from '@tanstack/svelte-query';

  import { PLUGINS_COPY } from '../../../app/copy/plugins.ts';
  import { getPlugins } from '../../../lib/host-plugins.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import SettingsFrame from '../settings-frame.svelte';
  import PluginsBody from './plugins-body.svelte';

  const plugins = createQuery(
    () => ({
      queryKey: queryKeys.hostPlugins(),
      queryFn: ({ signal }) => getPlugins({ signal }),
      // A failure is shown with Try again, not retried behind the person's back.
      retry: false,
    }),
    undefined,
  );
</script>

<SettingsFrame title={PLUGINS_COPY.title} intro={PLUGINS_COPY.intro} page="settings-plugins">
  {#snippet body({ schema, snapshot })}
    <PluginsBody {plugins} {schema} {snapshot} />
  {/snippet}
</SettingsFrame>
