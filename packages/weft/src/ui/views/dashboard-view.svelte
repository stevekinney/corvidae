<script lang="ts">
  /** `DashboardView` from `@lostgradient/weft/ui`: the dashboard area, renderable inside or outside `WeftDashboard`. */
  import DashboardRoute from '../routes/dashboard/index.svelte';
  import StandaloneView from './standalone-view.svelte';
</script>

<StandaloneView>
  <DashboardRoute />
</StandaloneView>
