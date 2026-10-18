<script lang="ts">
  /** `WorkersView`: the workers area, renderable inside or outside the application shell. */
  import WorkersRoute from '../routes/workers/index.svelte';
  import StandaloneView from './standalone-view.svelte';
</script>

<StandaloneView>
  <WorkersRoute />
</StandaloneView>
