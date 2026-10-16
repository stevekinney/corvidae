<script lang="ts">
  import Terminal from '../lib/components/terminal/terminal.svelte';
  import type {
    TerminalRendererController,
    TerminalState,
  } from '../lib/components/terminal/terminal.types.ts';

  /**
   * A parent that turns optional callback props on and off by adding and removing them from a
   * spread, the way an application toggles a feature. The terminal must treat that as a settings
   * change, never as a new session.
   */
  type Props = {
    state: TerminalState;
    controller: TerminalRendererController;
    links: boolean;
    titles: boolean;
    recovery: boolean;
    announce: boolean;
  };

  let { state, controller, links, titles, recovery, announce }: Props = $props();
</script>

<Terminal
  title="Shell"
  {state}
  {controller}
  {...links ? { onLinkActivate: () => {} } : {}}
  {...titles ? { onTitleChange: () => {} } : {}}
  {...recovery ? { onNewSession: () => {}, onRetry: () => {}, onCheckCleanup: () => {} } : {}}
  {...announce ? { announceOutput: true } : {}}
/>
