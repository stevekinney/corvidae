<script lang="ts">
  /**
   * The banner over every tab of an agent a disabled plugin ships (board PageAgent, "Agent from a
   * disabled plugin", row 39d): the agent isn't available, its plugin is disabled, and its chats stay
   * readable while sending, approving and running wait for it. Enable and restart asks first, as a
   * chat with the agent does, then turns the plugin on and restarts Interborough through the shared
   * restart flow, whose dialog shows the restart. When the host answers again the agent can run, so
   * the page reads it, the agent list and the plugins again.
   */
  import { Banner, Button } from '@lostgradient/cinder';

  import { AGENT_PAGE_COPY } from '../../app/copy/agents.ts';
  import AgentListEnable from './agent-list-enable.svelte';

  interface Props {
    /** The agent's name as a person reads it. */
    name: string;
    /** The identifier of the plugin that ships it, which Enable and restart turns on. */
    plugin: string;
    /** The plugin's title, as Settings › Plugins shows it. */
    pluginTitle: string;
  }

  let { name, plugin, pluginTitle }: Props = $props();

  const copy = AGENT_PAGE_COPY.unavailable;
  let confirming = $state(false);
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
      onclick={() => (confirming = true)}
      label={copy.enable}
    />
  {/snippet}
</Banner>

<AgentListEnable
  bind:open={confirming}
  plugins={[{ name: plugin, title: pluginTitle }]}
  agents={[name]}
/>
