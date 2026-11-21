<script lang="ts">
  import { router } from '../../lib/router.svelte.ts';

  const path = router.pathname;
  window.dispatchEvent(new CustomEvent('route-mount-probe', { detail: path }));
</script>

<div data-testid="route-mount-probe">{path}</div>
