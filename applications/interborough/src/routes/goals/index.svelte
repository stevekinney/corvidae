<script lang="ts">
  /**
   * The route for `/goals`, `/goals/new` and `/goals/:goal`. The outlet keys a route by its path, so
   * each address mounts a page of its own, and the pattern says which: the list, the page that makes
   * a goal, or one goal with its attempts.
   */
  import { router } from '../../lib/router.svelte.ts';
  import GoalCreate from './goal-create.svelte';
  import GoalDetail from './goal-detail.svelte';
  import GoalList from './goal-list.svelte';

  const pattern = $derived(router.current.route?.pattern);
</script>

{#if pattern === '/goals/new'}
  <GoalCreate />
{:else if pattern === '/goals/:goal'}
  <GoalDetail />
{:else}
  <GoalList />
{/if}
