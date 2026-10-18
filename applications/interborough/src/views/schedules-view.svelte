<script lang="ts">
  /** `SchedulesView`: the schedules area, renderable inside or outside the application shell. */
  import SchedulesRoute from '../routes/schedules/index.svelte';
  import StandaloneView from './standalone-view.svelte';
</script>

<StandaloneView>
  <SchedulesRoute />
</StandaloneView>
