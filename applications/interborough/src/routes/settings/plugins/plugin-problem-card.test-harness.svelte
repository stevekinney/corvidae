<script lang="ts">
  /**
   * Test-only page that mounts one `<PluginProblemCard>` with the toast host it reports to, as the
   * shell has. Never imported by production code.
   */
  import type { ComponentProps } from 'svelte';

  import ToastHost, { provideToastHost } from '../../../app/toast-host.svelte';
  import PluginProblemCard from './plugin-problem-card.svelte';

  let props: ComponentProps<typeof PluginProblemCard> = $props();

  provideToastHost();
</script>

<PluginProblemCard {...props} />
<ToastHost />
