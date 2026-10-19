<script lang="ts">
  /**
   * Test-only fixed-props wrapper around `<RefreshPanel>` for use as
   * `SystemRouteTestHarness`'s `component` prop (see
   * `workflow-revisions-panel-fixture.test-harness.svelte`).
   */
  import RefreshPanel from './refresh-panel.svelte';
</script>

<RefreshPanel workflowName="order-processing" />
