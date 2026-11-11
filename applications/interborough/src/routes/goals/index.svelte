<script lang="ts">
  /**
   * The route for `/goals`, `/goals/new`, `/goals/:goal` and `/goals/:goal/edit`. The outlet keys a
   * route by its path, so each address mounts a page of its own, and the pattern says which: the
   * list, the page that makes a goal, one goal with its attempts, or the page that changes it.
   */
  import { router } from '../../lib/router.svelte.ts';
  import GoalCreate from './goal-create.svelte';
  import GoalDetail from './goal-detail.svelte';
  import GoalEdit from './goal-edit.svelte';
  import GoalList from './goal-list.svelte';

  const pattern = $derived(router.current.route?.pattern);
</script>

{#if pattern === '/goals/new'}
  <GoalCreate />
{:else if pattern === '/goals/:goal/edit'}
  <GoalEdit />
{:else if pattern === '/goals/:goal'}
  <GoalDetail />
{:else}
  <GoalList />
{/if}
