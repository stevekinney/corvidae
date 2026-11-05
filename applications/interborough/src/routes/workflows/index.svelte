<script lang="ts">
  /**
   * Runs dispatcher. `src/app/routes.ts` maps `/runs`, `/runs/:run` and
   * `/workflows/:workflow/runs/:run` to this one component (a run reached by its ID alone, and the
   * same page under the workflow it belongs to):
   * this file is the only place that can tell those apart, plus the `?view=` sub-navigation the
   * start picker and aggregate view live under. `/runs` is the human list of what the
   * agents have done (`runs/run-list.svelte`), and `/runs/:run` is one run's page
   * (`runs/run-detail.svelte`), whose sections for the workflow engine's side of a run are there for a caller who may read it.
   *
   * The list and a run's page are the Bureau's, and hold no console scope. The start picker and the
   * aggregate view read the engine, so a caller without `workflows:read` is told so here instead of
   * being sent to a form the engine would refuse.
   */
  import { VIEW_COPY } from '../../app/copy.ts';
  import ForbiddenState from '../../app/forbidden-state.svelte';
  import { router } from '../../lib/router.svelte.ts';
  import { getPrincipalStore } from '../../lib/scopes.svelte.ts';
  import AggregateView from './aggregate/aggregate-view.svelte';
  import RunDetail from './runs/run-detail.svelte';
  import RunList from './runs/run-list.svelte';
  import StartPicker from './start/start-picker.svelte';

  const runId = $derived(router.current.params['run']);
  const view = $derived(router.current.search.get('view'));
  const principal = getPrincipalStore();
  const engineAllowed = $derived(principal.hasScope('workflows:read'));
</script>

{#if runId}
  {#key runId}<RunDetail {runId} />{/key}
{:else if (view === 'start' || view === 'aggregate') && !engineAllowed}
  <ForbiddenState title={VIEW_COPY.runs.forbidden.title} requirement="workflows:read" />
{:else if view === 'start'}
  <StartPicker />
{:else if view === 'aggregate'}
  <AggregateView />
{:else}
  <RunList />
{/if}
