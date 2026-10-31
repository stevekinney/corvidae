<script lang="ts">
  /**
   * Test-only harness composing `<WorkflowRouteHarness>` (the workflows track's shared context
   * provider: `HttpClient`, `PrincipalStore`, `FleetEventSource`, `QueryClient`) around a run's
   * page, for tests that script the workflow engine's HTTP routes and the Bureau's JSON-RPC
   * methods through one `ScriptedFetch`. Never imported by production code.
   */
  import type { HttpClient } from '@lostgradient/weft';
  import type { QueryClient } from '@tanstack/svelte-query';

  import type { Principal } from '../../../lib/scopes.svelte.ts';
  import WorkflowRouteHarness from '../list/workflow-route-harness.test-harness.svelte';
  import RunDetail from './run-detail.svelte';

  interface Props {
    client: HttpClient;
    principal: Principal;
    queryClient: QueryClient;
    runId: string;
  }

  let { client, principal, queryClient, runId }: Props = $props();
</script>

<WorkflowRouteHarness {client} {principal} {queryClient}>
  <RunDetail {runId} />
</WorkflowRouteHarness>
