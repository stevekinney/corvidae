<script lang="ts">
  /**
   * Test-only harness: the route outlet with the shell's one fleet feed provided, which the engine's
   * workflow page (a run's Engine tab) reads from its ancestors. Never imported by production code.
   */
  import type { HttpClient } from '@lostgradient/weft';
  import { onDestroy, untrack } from 'svelte';

  import { provideFleetEventSource } from '../../../app/engine-status.svelte.ts';
  import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
  import { FleetEventSource } from '../../../lib/live-source/fleet-event-source.svelte.ts';
  import type { AuthorizationScope } from '../../../lib/scopes.svelte.ts';

  interface RunDetailEngineHarnessProps {
    client: HttpClient;
    scopes: readonly AuthorizationScope[];
  }

  let { client, scopes }: RunDetailEngineHarnessProps = $props();

  // The engine's workflow page subscribes to it. It is closed with the harness, so no reconnect timer
  // outlives the test and reaches a stubbed `fetch` another test has installed.
  const fleetSource = untrack(() => new FleetEventSource({ baseUrl: 'http://weft.test' }));
  provideFleetEventSource(fleetSource);
  onDestroy(() => fleetSource.close());
</script>

<RouteOutletHarness {client} {scopes} />
