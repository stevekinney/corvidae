<script lang="ts">
  /**
   * Test-only fixed-props wrapper around `<WorkflowRevisionsPanel>` for use
   * as `SystemRouteTestHarness`'s `component` prop, which renders its
   * `RouteComponent` with no props (`<RouteComponent />`) — compose a
   * fixed-props wrapper rather than thread props through the shared harness.
   */
  import WorkflowRevisionsPanel from './workflow-revisions-panel.svelte';
</script>

<WorkflowRevisionsPanel workflowName="order-processing" />
