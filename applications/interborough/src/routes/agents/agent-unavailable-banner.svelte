<script lang="ts">
  /**
   * The banner over every tab of an agent a disabled plugin ships (board PageAgent, "Agent from a
   * disabled plugin", row 39d): the agent isn't available, its plugin is disabled, and its chats stay
   * readable while sending, approving and running wait for it. Enable and restart asks first, as a
   * chat with the agent does, then turns the plugin on and restarts Interborough through the shared
   * restart flow, whose dialog shows the restart. When the host answers again the agent can run, so
   * the page reads it, the agent list and the plugins again.
   */
  import { untrack } from 'svelte';

  import { Banner, Button, ConfirmDialog } from '@lostgradient/cinder';
  import { useQueryClient } from '@tanstack/svelte-query';

  import { AGENT_PAGE_COPY } from '../../app/copy/agents.ts';
  import { CHAT_COPY } from '../../app/copy/chat.ts';
  import RestartDialog from '../../app/restart/restart-dialog.svelte';
  import { queryKeys } from '../../lib/query.ts';
  import { RestartFlow } from '../settings/plugins/restart-flow.svelte.ts';

  interface Props {
    /** The agent's identifier, `plugin:name`. */
    id: string;
    /** The agent's name as a person reads it. */
    name: string;
    /** The identifier of the plugin that ships it, which Enable and restart turns on. */
    plugin: string;
    /** The plugin's title, as Settings › Plugins shows it. */
    pluginTitle: string;
  }

  let { id, name, plugin, pluginTitle }: Props = $props();

  const copy = AGENT_PAGE_COPY.unavailable;
  const confirmCopy = CHAT_COPY.composer.enableDialog;
  const queryClient = useQueryClient();
  const restart = new RestartFlow();
  let confirming = $state(false);

  // Once the host answers again the plugin is on, so the agent is available and the page reads it again.
  $effect(() => {
    if (restart.phase !== 'back') return;
    untrack(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.definition(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.list() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.hostPlugins() });
    });
  });
</script>

<Banner
  variant="warning"
  dismissible={false}
  title={copy.title(name)}
  data-testid="agent-unavailable"
>
  {copy.description(pluginTitle)}
  {#snippet actions()}
    <Button
      data-changes
      variant="secondary"
      size="sm"
      disabled={restart.running}
      onclick={() => (confirming = true)}>{copy.enable}</Button
    >
  {/snippet}
</Banner>

<ConfirmDialog
  bind:open={confirming}
  title={confirmCopy.title(pluginTitle)}
  description={confirmCopy.description}
  confirmLabel={confirmCopy.confirm}
  onConfirm={() =>
    void restart.run([{ name: plugin, enabled: true }], false, { changes: [pluginTitle] })}
/>
<RestartDialog flow={restart} />
