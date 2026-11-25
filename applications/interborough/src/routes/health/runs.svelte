<script lang="ts">
  import WorkflowList from '../workflows/list/workflow-list.svelte';
  import HealthFrame from './health-frame.svelte';
</script>

<HealthFrame active="runs">
  <WorkflowList headingLevel={2} stackTable showConnectionIndicator={false} />
</HealthFrame>
