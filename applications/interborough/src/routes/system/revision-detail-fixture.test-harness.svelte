<script lang="ts">
  /**
   * Test-only fixed-props wrapper around `<RevisionDetail>` for use as
   * `SystemRouteTestHarness`'s `component` prop (see
   * `workflow-revisions-panel-fixture.test-harness.svelte`). Closing the detail
   * leaves a line of text, so a test can see `onClose` was called.
   */
  import RevisionDetail from './revision-detail.svelte';

  let closed = $state(false);
</script>

{#if closed}
  <p>Detail closed</p>
{:else}
  <RevisionDetail
    workflowName="order-processing"
    revision="order-processing-rev-1"
    onClose={() => (closed = true)}
  />
{/if}
