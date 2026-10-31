<script lang="ts">
  /**
   * `/health`: the engine's overview (`routes/dashboard`), and below it the diagnostics the System
   * page held that belong with the engine's health: metrics, alerts, lease and recovery. The engine's
   * realms are a fourth, listed only when the engine runs them: an engine that never opted into
   * `workflowExecutionMode: 'realm'` lists no pool, and has nothing to diagnose.
   */
  import { createQuery } from '@tanstack/svelte-query';

  import { HEALTH_DIAGNOSTICS_COPY } from '../../app/copy.ts';
  import { useFleetEventsLive } from '../../app/live-polling.svelte.ts';
  import { getClient } from '../../lib/client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import Dashboard from '../dashboard/index.svelte';
  import { fetchRealmDiagnostics, runsRealms } from '../system/realms-view.ts';
  import SystemSections from '../system/system-sections.svelte';
  import { HEALTH_TABS, HEALTH_TABS_WITH_REALMS } from '../system/system-tabs.ts';

  const client = getClient();

  // The same read, under the same key, as the Realms tab's, so the two share one answer. A failed
  // read lists no Realms: the tab would only repeat the failure.
  const fleetLive = useFleetEventsLive();
  const realms = createQuery(() => {
    // Read here, not in the interval, which TanStack Query reads untracked.
    const polling = !fleetLive();
    return {
      queryKey: queryKeys.realms(),
      queryFn: () => fetchRealmDiagnostics(client),
      // poll-reason: fallback
      refetchInterval: polling ? 30_000 : false,
    };
  });

  const tabs = $derived(runsRealms(realms.data) ? HEALTH_TABS_WITH_REALMS : HEALTH_TABS);
</script>

<div class="weft-health">
  <Dashboard />

  <section class="weft-health__diagnostics" aria-labelledby="weft-health-diagnostics-title">
    <h2 id="weft-health-diagnostics-title" class="weft-health__diagnostics-title">
      {HEALTH_DIAGNOSTICS_COPY.title}
    </h2>
    <SystemSections {tabs} path="/health" label={HEALTH_DIAGNOSTICS_COPY.sections} />
  </section>
</div>

<style>
  .weft-health {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-6);
  }

  .weft-health__diagnostics-title {
    margin: 0 0 var(--cinder-space-3);
    font-size: var(--cinder-text-lg);
    font-weight: 600;
  }
</style>
