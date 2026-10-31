<script lang="ts">
  /** `DashboardView`: the health area (the overview and its diagnostics), renderable inside or outside the application shell. */
  import DashboardRoute from '../routes/health/index.svelte';
  import StandaloneView from './standalone-view.svelte';
</script>

<StandaloneView>
  <DashboardRoute />
</StandaloneView>
