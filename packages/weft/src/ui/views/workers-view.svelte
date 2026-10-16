<script lang="ts">
  /** `WorkersView` from `@lostgradient/weft/ui`: the workers area, renderable inside or outside `WeftDashboard`. */
  import WorkersRoute from '../routes/workers/index.svelte';
  import StandaloneView from './standalone-view.svelte';
</script>

<StandaloneView>
  <WorkersRoute />
</StandaloneView>
