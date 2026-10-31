<script lang="ts">
  /**
   * Runs dispatcher. `src/app/routes.ts` maps `/runs`, `/runs/:run` and
   * `/workflows/:workflow/runs/:run` to this one component (a run reached by its ID alone, and the
   * same page under the workflow it belongs to):
   * this file is the only place that can tell those apart, plus the `?view=` sub-navigation the
   * engine's start wizard and aggregate view live under. `/runs` is the human list of what the
   * agents have done (`runs/run-list.svelte`), and `/runs/:run` is one run's page
   * (`runs/run-detail.svelte`), whose sections for the workflow engine's side of a run are there for a caller who may read it.
   *
   * The list and a run's page are the Bureau's, and hold no console scope. The start wizard and the
   * aggregate view read the engine, so a caller without `workflows:read` is told so here instead of
   * being sent to a form the engine would refuse.
   */
  import { EmptyState } from '@lostgradient/cinder';
  import { Lock } from '@lucide/svelte';

  import { VIEW_COPY } from '../../app/copy.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { getPrincipalStore, scopeReason } from '../../lib/scopes.svelte.ts';
  import AggregateView from './aggregate/aggregate-view.svelte';
  import RunDetail from './runs/run-detail.svelte';
  import RunList from './runs/run-list.svelte';
  import StartWizard from './start/start-wizard.svelte';

  const runId = $derived(router.current.params['run']);
  const view = $derived(router.current.search.get('view'));
  const principal = getPrincipalStore();
  const engineAllowed = $derived(principal.hasScope('workflows:read'));
</script>

{#if runId}
  {#key runId}<RunDetail {runId} />{/key}
{:else if (view === 'start' || view === 'aggregate') && !engineAllowed}
  <EmptyState
    kind="first-use"
    title={VIEW_COPY.runs.forbidden.title}
    description={scopeReason('workflows:read')}
    headingLevel={1}
  >
    {#snippet icon()}<Lock size={28} aria-hidden="true" />{/snippet}
  </EmptyState>
{:else if view === 'start'}
  <StartWizard />
{:else if view === 'aggregate'}
  <AggregateView />
{:else}
  <RunList />
{/if}
