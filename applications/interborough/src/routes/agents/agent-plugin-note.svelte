<script lang="ts">
  /** Says that a plugin ships the agent, so the page cannot change it, and what to do instead. */
  import { AGENT_PAGE_COPY } from '../../app/copy.ts';

  interface Props {
    /** The plugin that ships the agent. */
    plugin: string;
  }

  let { plugin }: Props = $props();
</script>

<p class="ib-agent-note" data-testid="agent-plugin-note">{AGENT_PAGE_COPY.plugin.note(plugin)}</p>
