<script lang="ts">
  /**
   * Test-only fixed-props wrapper around `<RevisionDetail>` for use as
   * `SystemRouteTestHarness`'s `component` prop (see
   * `workflow-revisions-panel-fixture.test-harness.svelte`).
   */
  import RevisionDetail from './revision-detail.svelte';
</script>

<RevisionDetail
  workflowName="order-processing"
  revision="order-processing-rev-1"
  onClose={() => {}}
/>
