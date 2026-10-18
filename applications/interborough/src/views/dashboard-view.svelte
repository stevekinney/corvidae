<script lang="ts">
  /** `DashboardView`: the dashboard area, renderable inside or outside the application shell. */
  import DashboardRoute from '../routes/dashboard/index.svelte';
  import StandaloneView from './standalone-view.svelte';
</script>

<StandaloneView>
  <DashboardRoute />
</StandaloneView>
