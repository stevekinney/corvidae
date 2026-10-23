<script lang="ts">
  /**
   * The route for `/workflows`, `/workflows/new`, `/workflows/:type`, `/workflows/:type/runs`, and
   * `/workflows/:type/edit`. The outlet keys a route by its path, so each address mounts a page of
   * its own, and the pattern says which.
   */
  import { router } from '../../lib/router.svelte.ts';
  import WorkflowCreator from './workflow-creator.svelte';
  import WorkflowDetail from './workflow-detail.svelte';
  import WorkflowEditor from './workflow-editor.svelte';
  import WorkflowList from './workflow-list.svelte';
  import WorkflowRuns from './workflow-runs.svelte';

  const pattern = $derived(router.current.route?.pattern);
</script>

{#if pattern === '/workflows/new'}
  <WorkflowCreator />
{:else if pattern === '/workflows/:type'}
  <WorkflowDetail />
{:else if pattern === '/workflows/:type/runs'}
  <WorkflowRuns />
{:else if pattern === '/workflows/:type/edit'}
  <WorkflowEditor />
{:else}
  <WorkflowList />
{/if}
