<script lang="ts">
  /**
   * Test-only fixed-props wrapper around `<RevisionInstallForm>` for use as
   * `SystemRouteTestHarness`'s `component` prop (see
   * `workflow-revisions-panel-fixture.test-harness.svelte`).
   */
  import RevisionInstallForm from './revision-install-form.svelte';
</script>

<RevisionInstallForm workflowName="order-processing" />
