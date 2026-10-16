<script lang="ts">
  /** `WorkflowsView` from `@lostgradient/weft/ui`: the workflows area, renderable inside or outside `WeftDashboard`. */
  import WorkflowsRoute from '../routes/workflows/index.svelte';
  import StandaloneView from './standalone-view.svelte';
</script>

<StandaloneView>
  <WorkflowsRoute />
</StandaloneView>
