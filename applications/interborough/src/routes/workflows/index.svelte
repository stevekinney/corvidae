<script lang="ts">
  /**
   * Runs dispatcher. `src/app/routes.ts` maps BOTH `/runs` and `/runs/:id` to this one component:
   * this file is the only place that can tell those apart, plus the `?view=` sub-navigation the
   * engine's start wizard and aggregate view live under. `/runs` is the human list of what the
   * agents have done (`runs/run-list.svelte`), and `/runs/:id` is one run's page
   * (`runs/run-detail.svelte`), whose Engine tab is the workflow detail the engine always had.
   */
  import { router } from '../../lib/router.svelte.ts';
  import AggregateView from './aggregate/aggregate-view.svelte';
  import RunDetail from './runs/run-detail.svelte';
  import RunList from './runs/run-list.svelte';
  import StartWizard from './start/start-wizard.svelte';

  const runId = $derived(router.current.params['id']);
  const view = $derived(router.current.search.get('view'));
</script>

{#if runId}
  {#key runId}<RunDetail {runId} />{/key}
{:else if view === 'start'}
  <StartWizard />
{:else if view === 'aggregate'}
  <AggregateView />
{:else}
  <RunList />
{/if}
