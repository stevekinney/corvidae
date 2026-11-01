<script lang="ts">
  /**
   * The route for `/workflows`, `/internal-workflows`, `/workflows/new`, `/workflows/:workflow`, `/workflows/:workflow/runs`,
   * `/workflows/:workflow/run`, and `/workflows/:workflow/edit`. The outlet keys a route by its path, so each address mounts a page of
   * its own, and the pattern says which.
   */
  import { router } from '../../lib/router.svelte.ts';
  import WorkflowCreator from './workflow-creator.svelte';
  import WorkflowDetail from './workflow-detail.svelte';
  import InternalWorkflows from './internal-workflows.svelte';
  import WorkflowEditor from './workflow-editor.svelte';
  import WorkflowList from './workflow-list.svelte';
  import RunSetup from './run-setup.svelte';
  import WorkflowRuns from './workflow-runs.svelte';

  const pattern = $derived(router.current.route?.pattern);
</script>

{#if pattern === '/workflows/new'}
  <WorkflowCreator />
{:else if pattern === '/internal-workflows'}
  <InternalWorkflows />
{:else if pattern === '/workflows/:workflow'}
  <WorkflowDetail />
{:else if pattern === '/workflows/:workflow/runs'}
  <WorkflowRuns />
{:else if pattern === '/workflows/:workflow/run'}
  <RunSetup />
{:else if pattern === '/workflows/:workflow/edit'}
  <WorkflowEditor />
{:else}
  <WorkflowList />
{/if}
