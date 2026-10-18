<script lang="ts">
  /** `SystemView`: the system area, renderable inside or outside the application shell. */
  import SystemRoute from '../routes/system/index.svelte';
  import StandaloneView from './standalone-view.svelte';
</script>

<StandaloneView>
  <SystemRoute />
</StandaloneView>
