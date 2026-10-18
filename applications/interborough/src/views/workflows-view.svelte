<script lang="ts">
  /** `WorkflowsView`: the workflows area, renderable inside or outside the application shell. */
  import WorkflowsRoute from '../routes/workflows/index.svelte';
  import StandaloneView from './standalone-view.svelte';
</script>

<StandaloneView>
  <WorkflowsRoute />
</StandaloneView>
