<script lang="ts">
  /**
   * The question before a disabled plugin is turned on (board PageSettingsSections, "Enabling a
   * disabled plugin"): a Cinder confirm dialog. Interborough restarts to load the plugin, so it says
   * what becomes available again (the plugin's own agents, which the catalog lists as unavailable
   * while it is off) and that running work picks up where it stopped. Confirming writes the choice
   * and restarts in one step through the shared restart flow; Cancel changes nothing.
   */
  import { ConfirmDialog } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { PLUGINS_COPY } from '../../../app/copy.ts';
  import { listAgentDefinitions } from '../../../lib/agent-definitions.ts';
  import type { PluginStanding } from '../../../lib/host-plugins.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import PendingWritesList from './pending-writes-list.svelte';
  import type { PluginWrite } from './plugin-drafts.svelte.ts';
  import { heldBackAgents } from './plugin-presentation.ts';

  interface Props {
    /** The plugin the question is about, or `null` while it is closed. */
    plugin: PluginStanding | null;
    /** The other changes the restart writes with this one. */
    otherChanges: readonly PluginWrite[];
    onConfirm: (plugin: PluginStanding) => void;
    onCancel: () => void;
  }

  let { plugin, otherChanges, onConfirm, onCancel }: Props = $props();

  const copy = PLUGINS_COPY.enable;
  // The plugin stays named while the dialog leaves, after the page has let go of it.
  let last = $state<PluginStanding | null>(null);
  $effect(() => {
    if (plugin !== null) last = plugin;
  });
  const shown = $derived(plugin ?? last);

  // Read only while the question is open; it is information, and the confirmation never waits on it.
  const agents = createQuery(
    () => ({
      queryKey: queryKeys.agents.definitions(),
      queryFn: ({ signal }) => listAgentDefinitions({ signal }),
      enabled: plugin !== null,
      retry: false,
    }),
    undefined,
  );

  const names = $derived(
    shown === null ? [] : heldBackAgents(shown.descriptor.name, agents.data ?? []),
  );
  const description = $derived(
    [copy.intro, names.length > 0 ? copy.available(names) : '', copy.work]
      .filter((sentence) => sentence !== '')
      .join(' '),
  );

  function confirm(): void {
    if (plugin !== null) onConfirm(plugin);
  }
</script>

{#snippet alsoWrites()}
  <PendingWritesList changes={otherChanges} />
{/snippet}

{#if shown !== null}
  <ConfirmDialog
    open={plugin !== null}
    title={copy.title(shown.descriptor.title)}
    {description}
    cancelLabel={copy.cancel}
    confirmLabel={copy.confirm}
    onConfirm={confirm}
    {onCancel}
    {...otherChanges.length > 0 ? { options: alsoWrites } : {}}
  />
{/if}
